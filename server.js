// server.js - Rummy 500 Multiplayer Server (Clean Rewrite)
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static('public'));

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Card class
class Card {
    constructor(suit, rank) {
        this.suit = suit;
        this.rank = rank;
        this.value = this.calculateValue();
    }

    calculateValue() {
        if (this.rank === 'A' || this.rank === 'Joker') return 15;
        if (['K', 'Q', 'J'].includes(this.rank)) return 10;
        return parseInt(this.rank);
    }
}

// Game room class
class GameRoom {
    constructor(roomCode, hostId) {
        this.roomCode = roomCode;
        this.hostId = hostId;
        this.players = [];
        this.gameStarted = false;
        this.currentPlayer = 0;
        this.deck = [];
        this.discardPile = [];
        this.melds = [];
        this.drawSource = null;
        this.drawnCards = [];
    }

    addPlayer(player) {
        if (this.players.length >= 8) return false;
        
        this.players.push({
            id: player.id,
            name: player.name,
            socketId: player.socketId,
            hand: [],
            score: 0,
            roundScore: 0,
            connected: true
        });
        
        console.log(`Player ${player.name} joined room ${this.roomCode}`);
        return true;
    }

    removePlayer(socketId) {
        const player = this.players.find(p => p.socketId === socketId);
        if (player) {
            player.connected = false;
            console.log(`Player ${player.name} disconnected from room ${this.roomCode}`);
            
            // If all players disconnected, return true to delete room
            if (this.players.every(p => !p.connected)) {
                return true;
            }
        }
        return false;
    }

    reconnectPlayer(socketId, playerId) {
        const player = this.players.find(p => p.id === playerId);
        if (player) {
            player.socketId = socketId;
            player.connected = true;
            console.log(`Player ${player.name} reconnected to room ${this.roomCode}`);
            return true;
        }
        return false;
    }

    createDeck() {
        const suits = ['♠', '♥', '♦', '♣'];
        const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
        this.deck = [];

        // Add regular cards
        for (let suit of suits) {
            for (let rank of ranks) {
                this.deck.push(new Card(suit, rank));
            }
        }

        // Add jokers
        this.deck.push(new Card('', 'Joker'));
        this.deck.push(new Card('', 'Joker'));

        // Add second deck if 5+ players
        if (this.players.length >= 5) {
            const secondDeck = [];
            for (let suit of suits) {
                for (let rank of ranks) {
                    secondDeck.push(new Card(suit, rank));
                }
            }
            secondDeck.push(new Card('', 'Joker'));
            secondDeck.push(new Card('', 'Joker'));
            this.deck = [...this.deck, ...secondDeck];
        }

        // Shuffle
        for (let i = this.deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
    }

    dealCards() {
        this.createDeck();
        const cardsPerPlayer = this.players.length === 2 ? 13 : 7;

        console.log(`Dealing ${cardsPerPlayer} cards to ${this.players.length} players in room ${this.roomCode}`);

        for (let player of this.players) {
            player.hand = [];
            for (let i = 0; i < cardsPerPlayer; i++) {
                player.hand.push(this.deck.pop());
            }
        }

        // First discard
        this.discardPile.push(this.deck.pop());
        this.gameStarted = true;
        
        console.log(`Cards dealt. Deck has ${this.deck.length} cards remaining`);
    }

    drawFromDeck(playerId) {
        const player = this.players.find(p => p.id === playerId);
        if (!player || this.deck.length === 0) return false;

        const card = this.deck.pop();
        player.hand.push(card);
        this.drawSource = 'deck';
        this.drawnCards = [card];
        
        console.log(`Player ${player.name} drew from deck`);
        return true;
    }

    drawFromDiscard(playerId, numberOfCards = 1) {
        const player = this.players.find(p => p.id === playerId);
        if (!player || this.discardPile.length < numberOfCards) return false;

        const cards = [];
        for (let i = 0; i < numberOfCards; i++) {
            cards.push(this.discardPile.pop());
        }
        
        player.hand.push(...cards);
        this.drawSource = 'discard';
        this.drawnCards = cards;
        
        console.log(`Player ${player.name} drew ${numberOfCards} cards from discard`);
        return true;
    }

    isValidMeld(cards) {
        if (cards.length < 3) return false;

        // Separate jokers from regular cards
        const jokers = cards.filter(c => c.rank === 'Joker');
        const nonJokers = cards.filter(c => c.rank !== 'Joker');
        
        // All jokers is valid
        if (nonJokers.length === 0) return true;

        // Get unique ranks (excluding jokers)
        const ranks = nonJokers.map(c => c.rank);
        const uniqueRanks = [...new Set(ranks)];
        
        // Check for set (all same rank)
        if (uniqueRanks.length === 1) {
            // For sets, each card must have a different suit
            const suits = nonJokers.map(c => c.suit);
            const uniqueSuits = [...new Set(suits)];
            const isValidSet = uniqueSuits.length === nonJokers.length;
            
            console.log(`Set validation: rank=${uniqueRanks[0]}, suits=${suits.join(',')}, valid=${isValidSet}`);
            return isValidSet;
        }

        // Check for run (sequence in same suit)
        // All cards must be same suit
        const suits = nonJokers.map(c => c.suit);
        const uniqueSuits = [...new Set(suits)];
        
        if (uniqueSuits.length !== 1) {
            console.log('Run validation failed: multiple suits found:', uniqueSuits);
            return false;
        }

        // Check if cards form a sequence
        const suit = uniqueSuits[0];
        const rankOrder = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
        
        // Convert ranks to indices
        let indices = nonJokers.map(c => rankOrder.indexOf(c.rank));
        indices.sort((a, b) => a - b);
        
        console.log(`Run validation: suit=${suit}, ranks=${ranks.join(',')}, indices=${indices.join(',')}`);
        
        // Special handling for Ace (can be low or high)
        if (indices.includes(0) && indices.includes(12)) {
            // Try high ace sequence
            const highAceIndices = indices.filter(i => i !== 0).concat([13]);
            highAceIndices.sort((a, b) => a - b);
            
            const lowAceValid = this.isValidSequence(indices, jokers.length);
            const highAceValid = this.isValidSequence(highAceIndices, jokers.length);
            
            console.log(`Ace run: lowAceValid=${lowAceValid}, highAceValid=${highAceValid}`);
            return lowAceValid || highAceValid;
        }
        
        return this.isValidSequence(indices, jokers.length);
    }

    isValidSequence(indices, jokerCount) {
        // Check if indices form a sequence with jokers filling gaps
        for (let i = 1; i < indices.length; i++) {
            const gap = indices[i] - indices[i-1] - 1;
            if (gap < 0) return false; // Duplicate rank
            if (gap > jokerCount) {
                console.log(`Sequence gap too large: ${indices[i-1]} to ${indices[i]} needs ${gap} jokers, have ${jokerCount}`);
                return false;
            }
            jokerCount -= gap;
        }
        return true;
    }

    meldCards(playerId, cardIndices) {
        const player = this.players.find(p => p.id === playerId);
        if (!player) return false;

        const cards = cardIndices.map(i => player.hand[i]);
        
        // Debug logging
        console.log(`Player ${player.name} attempting to meld:`);
        cards.forEach(c => console.log(`  ${c.rank}${c.suit}`));
        
        if (!this.isValidMeld(cards)) {
            console.log('Meld validation failed');
            // More detailed validation feedback
            const ranks = cards.map(c => c.rank);
            const suits = cards.map(c => c.suit);
            console.log('Ranks:', ranks);
            console.log('Suits:', suits);
            return false;
        }

        // Check if bottom card from discard must be played
        if (this.drawSource === 'discard' && this.drawnCards.length > 1) {
            const bottomCard = this.drawnCards[0];
            if (!cards.some(c => c.suit === bottomCard.suit && c.rank === bottomCard.rank)) {
                console.log('Must play the bottom card drawn from discard');
                return false;
            }
        }

        // Remove cards from hand (in reverse order)
        cardIndices.sort((a, b) => b - a);
        cardIndices.forEach(i => player.hand.splice(i, 1));

        // Add to melds
        this.melds.push({
            cards: cards,
            playerId: playerId
        });

        console.log(`Player ${player.name} successfully created a meld`);
        return true;
    }

    layOffCards(playerId, cardIndices, meldIndex) {
        const player = this.players.find(p => p.id === playerId);
        if (!player || !this.melds[meldIndex]) return false;

        const cards = cardIndices.map(i => player.hand[i]);
        const meld = this.melds[meldIndex];
        const combinedCards = [...meld.cards, ...cards];

        if (!this.isValidMeld(combinedCards)) return false;

        // Remove cards from hand
        cardIndices.sort((a, b) => b - a);
        cardIndices.forEach(i => player.hand.splice(i, 1));

        // Add to meld
        meld.cards.push(...cards);
        
        console.log(`Player ${player.name} laid off ${cards.length} cards`);
        return true;
    }

    discardCard(playerId, cardIndex) {
        const player = this.players.find(p => p.id === playerId);
        if (!player || !player.hand[cardIndex]) return false;

        const card = player.hand[cardIndex];
        this.discardPile.push(card);
        player.hand.splice(cardIndex, 1);

        // Reset draw tracking
        this.drawSource = null;
        this.drawnCards = [];

        console.log(`Player ${player.name} discarded a card`);

        // Check for round end
        if (player.hand.length === 0) {
            this.endRound();
            return 'round_end';
        }

        // Next turn
        this.currentPlayer = (this.currentPlayer + 1) % this.players.length;
        return 'next_turn';
    }

    callRummy(playerId) {
        // Check if the discard pile has a playable card
        if (this.discardPile.length === 0) return false;
        
        const topCard = this.discardPile[this.discardPile.length - 1];
        
        // Check all melds to see if the card can be played
        for (let meld of this.melds) {
            const testMeld = [...meld.cards, topCard];
            if (this.isValidMeld(testMeld)) {
                // Valid call - give turn to caller
                this.currentPlayer = this.players.findIndex(p => p.id === playerId);
                
                // Draw the card
                const player = this.players.find(p => p.id === playerId);
                player.hand.push(this.discardPile.pop());
                
                console.log(`Player ${player.name} called Rummy!`);
                return true;
            }
        }
        
        return false;
    }

    endRound() {
        console.log(`Round ended in room ${this.roomCode}`);
        
        // Calculate scores
        for (let player of this.players) {
            let meldValue = 0;
            let handValue = 0;

            // Calculate meld values
            for (let meld of this.melds) {
                if (meld.playerId === player.id) {
                    meldValue += meld.cards.reduce((sum, card) => sum + card.value, 0);
                }
            }

            // Calculate hand values
            handValue = player.hand.reduce((sum, card) => sum + card.value, 0);

            player.roundScore = meldValue - handValue;
            player.score += player.roundScore;
            
            console.log(`Player ${player.name}: +${player.roundScore} (Total: ${player.score})`);
        }

        // Check for game winner
        const winner = this.players.find(p => p.score >= 500);
        if (winner) {
            this.gameWinner = winner;
            console.log(`Game winner: ${winner.name} with ${winner.score} points!`);
            return true;
        }

        return false;
    }

    startNewRound() {
        this.deck = [];
        this.discardPile = [];
        this.melds = [];
        this.currentPlayer = (this.currentPlayer + 1) % this.players.length;
        this.drawSource = null;
        this.drawnCards = [];
        
        console.log(`Starting new round in room ${this.roomCode}`);
    }

    getGameState(playerId) {
        const player = this.players.find(p => p.id === playerId);
        if (!player) return null;

        return {
            roomCode: this.roomCode,
            players: this.players.map(p => ({
                id: p.id,
                name: p.name,
                handCount: p.hand.length,
                score: p.score,
                connected: p.connected
            })),
            currentPlayer: this.currentPlayer,
            myHand: player.hand,
            discardPile: this.discardPile.slice(-1), // Only show top card
            discardCount: this.discardPile.length,
            deckCount: this.deck.length,
            melds: this.melds,
            gameStarted: this.gameStarted,
            isHost: this.hostId === playerId,
            myTurn: this.players[this.currentPlayer]?.id === playerId,
            hasDrawn: this.players[this.currentPlayer]?.id === playerId ? this.drawSource !== null : false
        };
    }
}

// Game rooms storage
const rooms = new Map();

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('New connection:', socket.id);

    socket.on('create_room', (data) => {
        const roomCode = Math.random().toString(36).substr(2, 6).toUpperCase();
        const room = new GameRoom(roomCode, data.playerId);
        
        room.addPlayer({
            id: data.playerId,
            name: data.playerName,
            socketId: socket.id
        });

        rooms.set(roomCode, room);
        socket.join(roomCode);
        
        console.log(`Room ${roomCode} created by ${data.playerName}`);
        
        socket.emit('room_created', { roomCode });
        io.to(roomCode).emit('game_update', room.getGameState(data.playerId));
    });

    socket.on('join_room', (data) => {
        const room = rooms.get(data.roomCode);
        
        if (!room) {
            socket.emit('error', { message: 'Room not found' });
            return;
        }

        if (room.gameStarted) {
            // Try to reconnect
            if (room.reconnectPlayer(socket.id, data.playerId)) {
                socket.join(data.roomCode);
                socket.emit('room_joined', { roomCode: data.roomCode });
                socket.emit('game_update', room.getGameState(data.playerId));
            } else {
                socket.emit('error', { message: 'Game already in progress' });
            }
            return;
        }

        if (room.players.length >= 8) {
            socket.emit('error', { message: 'Room is full' });
            return;
        }

        room.addPlayer({
            id: data.playerId,
            name: data.playerName,
            socketId: socket.id
        });

        socket.join(data.roomCode);
        socket.emit('room_joined', { roomCode: data.roomCode });
        
        // Update all players
        room.players.forEach(player => {
            io.to(player.socketId).emit('game_update', room.getGameState(player.id));
        });
    });

    socket.on('start_game', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room || room.hostId !== data.playerId || room.players.length < 2) {
            socket.emit('error', { message: 'Cannot start game' });
            return;
        }

        room.gameStarted = true;
        console.log(`Game started in room ${data.roomCode}`);
        
        // Just notify players - don't deal cards yet
        room.players.forEach(player => {
            io.to(player.socketId).emit('game_started');
            io.to(player.socketId).emit('game_update', room.getGameState(player.id));
        });
    });

    socket.on('deal_cards', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room || room.hostId !== data.playerId) {
            socket.emit('error', { message: 'Only host can deal cards' });
            return;
        }

        room.dealCards();
        
        // Notify all players that cards have been dealt
        room.players.forEach(player => {
            io.to(player.socketId).emit('cards_dealt');
            io.to(player.socketId).emit('game_update', room.getGameState(player.id));
        });
        
        io.to(data.roomCode).emit('notification', { 
            message: 'Cards have been dealt!' 
        });
    });

    socket.on('draw_deck', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room || room.players[room.currentPlayer]?.id !== data.playerId) {
            socket.emit('error', { message: 'Not your turn' });
            return;
        }

        if (room.drawSource !== null) {
            socket.emit('error', { message: 'Already drawn this turn' });
            return;
        }

        if (room.drawFromDeck(data.playerId)) {
            room.players.forEach(player => {
                io.to(player.socketId).emit('game_update', room.getGameState(player.id));
            });
            io.to(data.roomCode).emit('notification', { 
                message: `${room.players.find(p => p.id === data.playerId).name} drew from deck` 
            });
        }
    });

    socket.on('draw_discard', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room || room.players[room.currentPlayer]?.id !== data.playerId) {
            socket.emit('error', { message: 'Not your turn' });
            return;
        }

        if (room.drawSource !== null) {
            socket.emit('error', { message: 'Already drawn this turn' });
            return;
        }

        if (room.drawFromDiscard(data.playerId, data.numberOfCards || 1)) {
            room.players.forEach(player => {
                io.to(player.socketId).emit('game_update', room.getGameState(player.id));
            });
            io.to(data.roomCode).emit('notification', { 
                message: `${room.players.find(p => p.id === data.playerId).name} drew from discard` 
            });
        }
    });

    socket.on('meld_cards', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room || room.players[room.currentPlayer]?.id !== data.playerId) {
            socket.emit('error', { message: 'Not your turn' });
            return;
        }

        if (room.meldCards(data.playerId, data.cardIndices)) {
            room.players.forEach(player => {
                io.to(player.socketId).emit('game_update', room.getGameState(player.id));
            });
            io.to(data.roomCode).emit('notification', { 
                message: `${room.players.find(p => p.id === data.playerId).name} created a meld` 
            });
        } else {
            // Send more specific error message
            const player = room.players.find(p => p.id === data.playerId);
            const cards = data.cardIndices.map(i => player.hand[i]);
            let errorMsg = 'Invalid meld: ';
            
            if (cards.length < 3) {
                errorMsg += 'Need at least 3 cards';
            } else {
                const ranks = cards.map(c => c.rank);
                const suits = cards.map(c => c.suit);
                const uniqueRanks = [...new Set(ranks.filter(r => r !== 'Joker'))];
                const uniqueSuits = [...new Set(suits.filter(s => s))];
                
                if (uniqueRanks.length === 1) {
                    errorMsg += 'Sets cannot have duplicate suits';
                } else if (uniqueSuits.length > 1) {
                    errorMsg += 'Runs must all be the same suit';
                } else {
                    errorMsg += 'Cards do not form a valid sequence';
                }
            }
            
            socket.emit('error', { message: errorMsg });
        }
    });

    socket.on('layoff_cards', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room || room.players[room.currentPlayer]?.id !== data.playerId) {
            socket.emit('error', { message: 'Not your turn' });
            return;
        }

        if (room.layOffCards(data.playerId, data.cardIndices, data.meldIndex)) {
            room.players.forEach(player => {
                io.to(player.socketId).emit('game_update', room.getGameState(player.id));
            });
            io.to(data.roomCode).emit('notification', { 
                message: `${room.players.find(p => p.id === data.playerId).name} laid off cards` 
            });
        } else {
            socket.emit('error', { message: 'Invalid layoff' });
        }
    });

    socket.on('discard_card', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room || room.players[room.currentPlayer]?.id !== data.playerId) {
            socket.emit('error', { message: 'Not your turn' });
            return;
        }

        const result = room.discardCard(data.playerId, data.cardIndex);
        
        if (result === 'round_end') {
            const gameEnded = room.gameWinner !== undefined;
            
            room.players.forEach(player => {
                io.to(player.socketId).emit('round_end', {
                    scores: room.players.map(p => ({
                        name: p.name,
                        roundScore: p.roundScore,
                        totalScore: p.score
                    })),
                    gameWinner: gameEnded ? room.gameWinner : null
                });
            });
            
            if (!gameEnded) {
                io.to(data.roomCode).emit('notification', { 
                    message: 'Round complete! Prepare for next round.' 
                });
            }
        } else if (result === 'next_turn') {
            room.players.forEach(player => {
                io.to(player.socketId).emit('game_update', room.getGameState(player.id));
            });
            io.to(data.roomCode).emit('notification', { 
                message: `${room.players[room.currentPlayer].name}'s turn` 
            });
        }
    });

    socket.on('call_rummy', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room) return;

        if (room.callRummy(data.playerId)) {
            room.players.forEach(player => {
                io.to(player.socketId).emit('game_update', room.getGameState(player.id));
            });
            io.to(data.roomCode).emit('notification', { 
                message: `${room.players.find(p => p.id === data.playerId).name} called Rummy!` 
            });
        } else {
            socket.emit('error', { message: 'Invalid Rummy call' });
        }
    });

    socket.on('ready_for_next_round', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room || room.gameWinner) return;

        // Clear the round but don't deal yet
        room.startNewRound();
        
        // Show deal modal to all players
        room.players.forEach(player => {
            io.to(player.socketId).emit('game_started');
            io.to(player.socketId).emit('game_update', room.getGameState(player.id));
        });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        // Find and update player status in all rooms
        rooms.forEach((room, roomCode) => {
            const shouldDelete = room.removePlayer(socket.id);
            
            if (shouldDelete) {
                console.log(`Deleting empty room ${roomCode}`);
                rooms.delete(roomCode);
            } else {
                // Notify other players
                room.players.forEach(player => {
                    if (player.connected) {
                        io.to(player.socketId).emit('game_update', room.getGameState(player.id));
                    }
                });
            }
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Rummy 500 server running on port ${PORT}`);
});
