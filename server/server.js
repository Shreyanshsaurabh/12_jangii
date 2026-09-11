const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// Health check endpoint for Render monitoring
app.get('/', (req, res) => {
  res.status(200).send('12 Janggi Server is Running');
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // Allows Vercel production, preview URLs, and localhost
    methods: ["GET", "POST"]
  },
  transports: ['polling', 'websocket']
});

const TURN_TIME_LIMIT = 30;
const rooms = {};

function createInitialState() {
  const board = Array(4).fill(null).map(() => Array(3).fill(null));

  // P2 (Top - red): row 0 territory, forward is +row (down)
  board[0][0] = { type: 'minister', player: 2 };
  board[0][1] = { type: 'king', player: 2 };
  board[0][2] = { type: 'general', player: 2 };
  board[1][1] = { type: 'man', player: 2 };

  // P1 (Bottom - green): row 3 territory, forward is -row (up)
  board[3][0] = { type: 'minister', player: 1 };
  board[3][1] = { type: 'king', player: 1 };
  board[3][2] = { type: 'general', player: 1 };
  board[2][1] = { type: 'man', player: 1 };

  // NOTE: the timer's setInterval handle must NEVER live inside this object.
  // This whole object gets JSON-serialized and sent to clients over the
  // socket on every update. A live Node Timeout handle cannot be safely
  // serialized, and trying to emit it can throw. Track it on the room
  // object instead (see `room.timerInterval` below), not in game state.
  return {
    board,
    captives: { 1: [], 2: [] },
    currentTurn: 1,
    kingInTerritoryTurn: null,
    timer: TURN_TIME_LIMIT,
    winner: null,
    score: { 1: 0, 2: 0 },
    round: 1
  };
}

function getLegalMoves(piece, r, c) {
  const deltas = [];
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
    // Forward, Left, Right, Backward, Forward-Left, Forward-Right
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

  clearInterval(room.timerInterval);
  room.state.timer = TURN_TIME_LIMIT;

  // Emit immediately so clients don't show a stale countdown for up to 1s
  // while waiting for the first interval tick.
  io.to(roomId).emit('timer-update', room.state.timer);

  room.timerInterval = setInterval(() => {
    room.state.timer--;
    io.to(roomId).emit('timer-update', room.state.timer);

    if (room.state.timer <= 0) {
      clearInterval(room.timerInterval);
      const winner = room.state.currentTurn === 1 ? 2 : 1;
      resolveRound(roomId, winner, 'timeout');
    }
  }, 1000);
}

function resolveRound(roomId, winner, reason) {
  const room = rooms[roomId];
  if (!room) return;
  clearInterval(room.timerInterval);
  room.state.score[winner]++;

  if (room.state.score[winner] >= 2) {
    room.state.winner = winner;
    io.to(roomId).emit('game-over', { winner, reason, score: room.state.score });
  } else {
    io.to(roomId).emit('round-over', { winner, reason, score: room.state.score });
    setTimeout(() => {
      if (!rooms[roomId]) return; // room may have been cleaned up (disconnect) meanwhile
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
        state: createInitialState(),
        timerInterval: null
      };
      socket.emit('player-assigned', { player: 1, roomId });
    } else if (rooms[roomId].players.length === 1) {
      rooms[roomId].players.push(socket.id);
      socket.emit('player-assigned', { player: 2, roomId });
      io.to(roomId).emit('game-start', rooms[roomId].state);
      startTurnTimer(roomId);
    } else {
      socket.emit('player-assigned', { player: 0, roomId });
      socket.emit('state-update', rooms[roomId].state);
    }
  });

  socket.on('make-move', ({ roomId, from, to }) => {
    try {
      const room = rooms[roomId];
      if (!room || room.state.winner) return;

      const playerNum = room.players.indexOf(socket.id) + 1;
      if (playerNum !== room.state.currentTurn) return;

      const { board, captives } = room.state;

      if (from.type === 'board') {
        const piece = board[from.r][from.c];
        if (!piece || piece.player !== playerNum) return;

        const legalMoves = getLegalMoves(piece, from.r, from.c);
        const isLegal = legalMoves.some(([r, c]) => r === to.r && c === to.c);
        if (!isLegal) return;

        const target = board[to.r][to.c];
        if (target && target.player === playerNum) return;

        if (target) {
          if (target.type === 'king') {
            resolveRound(roomId, playerNum, 'king-capture');
            return;
          }
          captives[playerNum].push(target.type === 'lord' ? 'man' : target.type);
        }

        board[from.r][from.c] = null;

        const enemyTerritory = playerNum === 1 ? 0 : 3;
        if (piece.type === 'man' && to.r === enemyTerritory) {
          piece.type = 'lord';
        }
        board[to.r][to.c] = piece;

        if (piece.type === 'king') {
          if (to.r === enemyTerritory) {
            room.state.kingInTerritoryTurn = { player: playerNum, turnsSurvived: 0 };
          } else if (room.state.kingInTerritoryTurn && room.state.kingInTerritoryTurn.player === playerNum) {
            // King retreated out of enemy territory - the survival clock resets.
            room.state.kingInTerritoryTurn = null;
          }
        }
      }

      if (from.type === 'captive') {
        const pieceType = captives[playerNum][from.index];
        if (pieceType === undefined) return;
        const enemyTerritory = playerNum === 1 ? 0 : 3;

        if (to.r === enemyTerritory || board[to.r][to.c] !== null) return;

        captives[playerNum].splice(from.index, 1);
        board[to.r][to.c] = { type: pieceType, player: playerNum };
      }

      if (room.state.kingInTerritoryTurn) {
        if (room.state.kingInTerritoryTurn.player === playerNum) {
          room.state.kingInTerritoryTurn.turnsSurvived++;
          if (room.state.kingInTerritoryTurn.turnsSurvived >= 2) {
            resolveRound(roomId, playerNum, 'king-survival');
            return;
          }
        }
      }

      room.state.currentTurn = room.state.currentTurn === 1 ? 2 : 1;
      io.to(roomId).emit('state-update', room.state);
      startTurnTimer(roomId);
    } catch (err) {
      // Never let a bad move crash the whole server / room.
      console.error(`Error handling make-move for room ${roomId}:`, err);
    }
  });

  socket.on('disconnect', () => {
    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.players.includes(socket.id)) {
        clearInterval(room.timerInterval);
        io.to(roomId).emit('player-disconnected');
        delete rooms[roomId];
      }
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
