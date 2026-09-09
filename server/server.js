const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const TURN_TIME_LIMIT = 30; // 30s as per Season 4 rules
const rooms = {};

// Initial Board Setup: 4 rows x 3 cols
// P1 is Green (bottom, row 3 territory), P2 is Red (top, row 0 territory)
function createInitialState() {
  const board = Array(4).fill(null).map(() => Array(3).fill(null));

  // P2 (Top - red): row 0 territory, forward is +row
  board[0][0] = { type: 'minister', player: 2 };
  board[0][1] = { type: 'king', player: 2 };
  board[0][2] = { type: 'general', player: 2 };
  board[1][1] = { type: 'man', player: 2 };

  // P1 (Bottom - green): row 3 territory, forward is -row
  board[3][0] = { type: 'minister', player: 1 };
  board[3][1] = { type: 'king', player: 1 };
  board[3][2] = { type: 'general', player: 1 };
  board[2][1] = { type: 'man', player: 1 };

  return {
    board,
    captives: { 1: [], 2: [] },
    currentTurn: 1,
    kingInTerritoryTurn: null, // Tracks if king survived in enemy territory
    timer: TURN_TIME_LIMIT,
    timerInterval: null,
    winner: null,
    score: { 1: 0, 2: 0 },
    round: 1
  };
}

function getLegalMoves(piece, r, c) {
  const deltas = [];
  // P1 starts bottom (row 3) -> moves up (dr = -1)
  // P2 starts top (row 0) -> moves down (dr = +1)
  const forward = piece.player === 1 ? -1 : 1;

  if (piece.type === 'king') {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr !== 0 || dc !== 0) deltas.push([dr, dc]);
      }
    }
  } else if (piece.type === 'minister') {
    deltas.push([-1, -1], [-1, 1], [1, -1], [1, 1]);
  } else if (piece.type === 'general') {
    deltas.push([-1, 0], [1, 0], [0, -1], [0, 1]);
  } else if (piece.type === 'man') {
    deltas.push([forward, 0]);
  } else if (piece.type === 'lord') {
    // Moves everywhere except diagonally backward
    deltas.push([forward, 0], [0, -1], [0, 1], [-forward, 0]);
    deltas.push([forward, -1], [forward, 1]);
  }

  return deltas
    .map(([dr, dc]) => [r + dr, c + dc])
    .filter(([nr, nc]) => nr >= 0 && nr < 4 && nc >= 0 && nc < 3);
}

function startTurnTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  clearInterval(room.state.timerInterval);
  room.state.timer = TURN_TIME_LIMIT;

  room.state.timerInterval = setInterval(() => {
    room.state.timer--;
    io.to(roomId).emit('timer-update', room.state.timer);

    if (room.state.timer <= 0) {
      clearInterval(room.state.timerInterval);
      // Timeout forfeiture: current turn loses
      const winner = room.state.currentTurn === 1 ? 2 : 1;
      resolveRound(roomId, winner, 'timeout');
    }
  }, 1000);
}

function resolveRound(roomId, winner, reason) {
  const room = rooms[roomId];
  clearInterval(room.state.timerInterval);
  room.state.score[winner]++;

  if (room.state.score[winner] >= 2) {
    room.state.winner = winner;
    io.to(roomId).emit('game-over', { winner, reason, score: room.state.score });
  } else {
    io.to(roomId).emit('round-over', { winner, reason, score: room.state.score });
    setTimeout(() => {
      room.state = { ...createInitialState(), score: room.state.score, round: room.state.round + 1 };
      io.to(roomId).emit('state-update', room.state);
      startTurnTimer(roomId);
    }, 4000);
  }
}

io.on('connection', (socket) => {
  socket.on('join-room', (roomId) => {
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: [socket.id],
        state: createInitialState()
      };
      socket.emit('player-assigned', 1);
    } else if (rooms[roomId].players.length === 1) {
      rooms[roomId].players.push(socket.id);
      socket.emit('player-assigned', 2);
      io.to(roomId).emit('game-start', rooms[roomId].state);
      startTurnTimer(roomId);
    } else {
      socket.emit('player-assigned', 0); // Spectator
      socket.emit('state-update', rooms[roomId].state);
      return;
    }
  });

  socket.on('make-move', ({ roomId, from, to }) => {
    const room = rooms[roomId];
    if (!room || room.state.winner) return;

    const playerNum = room.players.indexOf(socket.id) + 1;
    if (playerNum !== room.state.currentTurn) return;

    const { board, captives } = room.state;

    // Normal movement on board
    if (from.type === 'board') {
      const piece = board[from.r][from.c];
      if (!piece || piece.player !== playerNum) return;

      const legalMoves = getLegalMoves(piece, from.r, from.c);
      const isLegal = legalMoves.some(([r, c]) => r === to.r && c === to.c);
      if (!isLegal) return;

      const target = board[to.r][to.c];
      if (target && target.player === playerNum) return; // Cannot capture own piece

      // Capture logic
      if (target) {
        if (target.type === 'king') {
          resolveRound(roomId, playerNum, 'king-capture');
          return;
        }
        // Demote Lord to Man when captured
        captives[playerNum].push(target.type === 'lord' ? 'man' : target.type);
      }

      board[from.r][from.c] = null;

      // Promotion logic: Man entering opponent territory
      const enemyTerritory = playerNum === 1 ? 0 : 3;
      if (piece.type === 'man' && to.r === enemyTerritory) {
        piece.type = 'lord';
      }
      board[to.r][to.c] = piece;

      // Check king survival victory condition
      if (piece.type === 'king' && to.r === enemyTerritory) {
        room.state.kingInTerritoryTurn = { player: playerNum, turnsSurvived: 0 };
      }
    }

    // Drop captive
    if (from.type === 'captive') {
      const pieceType = captives[playerNum][from.index];
      const enemyTerritory = playerNum === 1 ? 0 : 3;

      // Rule: Drop anywhere empty outside opponent's territory
      if (to.r === enemyTerritory || board[to.r][to.c] !== null) return;

      captives[playerNum].splice(from.index, 1);
      board[to.r][to.c] = { type: pieceType, player: playerNum };
    }

    // Process King Survival check
    if (room.state.kingInTerritoryTurn) {
      if (room.state.kingInTerritoryTurn.player === playerNum) {
        room.state.kingInTerritoryTurn.turnsSurvived++;
        if (room.state.kingInTerritoryTurn.turnsSurvived >= 2) {
          resolveRound(roomId, playerNum, 'king-survival');
          return;
        }
      }
    }

    // Switch turn
    room.state.currentTurn = room.state.currentTurn === 1 ? 2 : 1;
    io.to(roomId).emit('state-update', room.state);
    startTurnTimer(roomId);
  });

  socket.on('disconnect', () => {
    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.players.includes(socket.id)) {
        clearInterval(room.state.timerInterval);
        io.to(roomId).emit('player-disconnected');
        delete rooms[roomId];
      }
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
