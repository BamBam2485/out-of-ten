const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── Lobby storage ──────────────────────────────────────────────────────────
// lobbies[code] = {
//   code, hostId, players: [{id, name, ready}],
//   impostorCount, state: 'waiting'|'reveal'|'statement'|'discussion'|'vote'|'result',
//   rating, impostorIndices, statements: [{playerIndex, name, text}],
//   currentTurn, votes: {[voterId]: targetIndex}, revealsDone,
//   result: null | { type, impostorNames, rating, guessedRating }
// }
const lobbies = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return lobbies[code] ? generateCode() : code;
}

function getLobbyForSocket(socketId) {
  return Object.values(lobbies).find(l => l.players.some(p => p.id === socketId));
}

function broadcastLobby(lobby) {
  io.to(lobby.code).emit('lobby:update', sanitizeLobby(lobby));
}

function sanitizeLobby(lobby) {
  // Never send impostorIndices or rating to clients directly
  return {
    code: lobby.code,
    hostId: lobby.hostId,
    players: lobby.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })),
    impostorCount: lobby.impostorCount,
    state: lobby.state,
    statements: lobby.statements,
    currentTurn: lobby.currentTurn,
    votes: lobby.votes,
    result: lobby.result,
    playerCount: lobby.players.length,
  };
}

io.on('connection', (socket) => {

  // ── Create lobby ──────────────────────────────────────────────────────────
  socket.on('lobby:create', ({ name }) => {
    const code = generateCode();
    const lobby = {
      code,
      hostId: socket.id,
      players: [{ id: socket.id, name: name || 'Host', ready: false }],
      impostorCount: 1,
      state: 'waiting',
      rating: 0,
      impostorIndices: [],
      statements: [],
      currentTurn: 0,
      votes: {},
      revealsDone: 0,
      result: null,
    };
    lobbies[code] = lobby;
    socket.join(code);
    socket.emit('lobby:joined', { code, playerId: socket.id });
    broadcastLobby(lobby);
  });

  // ── Join lobby ────────────────────────────────────────────────────────────
  socket.on('lobby:join', ({ code, name }) => {
    const lobby = lobbies[code.toUpperCase()];
    if (!lobby) { socket.emit('error', 'Lobby not found.'); return; }
    if (lobby.state !== 'waiting') { socket.emit('error', 'Game already in progress.'); return; }
    if (lobby.players.length >= 10) { socket.emit('error', 'Lobby is full.'); return; }
    if (lobby.players.some(p => p.id === socket.id)) { socket.emit('error', 'Already in lobby.'); return; }
    lobby.players.push({ id: socket.id, name: name || 'Player', ready: false });
    socket.join(code.toUpperCase());
    socket.emit('lobby:joined', { code: code.toUpperCase(), playerId: socket.id });
    broadcastLobby(lobby);
  });

  // ── Set impostor count ────────────────────────────────────────────────────
  socket.on('lobby:setImpostors', ({ count }) => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby || lobby.hostId !== socket.id) return;
    const max = Math.floor(lobby.players.length / 2);
    lobby.impostorCount = Math.max(1, Math.min(max, count));
    broadcastLobby(lobby);
  });

  // ── Start game ────────────────────────────────────────────────────────────
  socket.on('game:start', () => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby || lobby.hostId !== socket.id) return;
    if (lobby.players.length < 3) { socket.emit('error', 'Need at least 3 players.'); return; }

    lobby.rating = Math.floor(Math.random() * 10) + 1;
    const indices = [...Array(lobby.players.length).keys()];
    lobby.impostorIndices = [];
    for (let i = 0; i < lobby.impostorCount; i++) {
      const r = Math.floor(Math.random() * indices.length);
      lobby.impostorIndices.push(indices.splice(r, 1)[0]);
    }
    lobby.state = 'reveal';
    lobby.statements = [];
    lobby.currentTurn = 0;
    lobby.votes = {};
    lobby.revealsDone = 0;
    lobby.result = null;

    // Send each player their private role
    lobby.players.forEach((player, i) => {
      const isImpostor = lobby.impostorIndices.includes(i);
      const teammates = lobby.impostorIndices.filter(x => x !== i).map(x => lobby.players[x].name);
      io.to(player.id).emit('game:role', {
        isImpostor,
        rating: isImpostor ? null : lobby.rating,
        teammates: isImpostor ? teammates : [],
      });
    });

    broadcastLobby(lobby);
  });

  // ── Player confirms they've seen their role ───────────────────────────────
  socket.on('game:roleConfirmed', () => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby || lobby.state !== 'reveal') return;
    lobby.revealsDone++;
    io.to(lobby.code).emit('game:revealProgress', {
      done: lobby.revealsDone,
      total: lobby.players.length,
    });
    if (lobby.revealsDone >= lobby.players.length) {
      lobby.state = 'statement';
      lobby.currentTurn = 0;
      broadcastLobby(lobby);
      io.to(lobby.code).emit('game:statementTurn', {
        playerIndex: 0,
        playerName: lobby.players[0].name,
        playerId: lobby.players[0].id,
      });
    }
  });

  // ── Submit statement ──────────────────────────────────────────────────────
  socket.on('game:submitStatement', ({ text }) => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby || lobby.state !== 'statement') return;
    const playerIndex = lobby.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== lobby.currentTurn) return;

    lobby.statements.push({
      playerIndex,
      name: lobby.players[playerIndex].name,
      text: (text || '').trim() || '(no statement)',
    });

    lobby.currentTurn++;
    if (lobby.currentTurn >= lobby.players.length) {
      lobby.state = 'discussion';
      broadcastLobby(lobby);
    } else {
      broadcastLobby(lobby);
      io.to(lobby.code).emit('game:statementTurn', {
        playerIndex: lobby.currentTurn,
        playerName: lobby.players[lobby.currentTurn].name,
        playerId: lobby.players[lobby.currentTurn].id,
      });
    }
  });

  // ── Impostor guess ────────────────────────────────────────────────────────
  socket.on('game:guess', ({ guess }) => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby) return;
    if (!['statement', 'discussion', 'vote'].includes(lobby.state)) return;
    const playerIndex = lobby.players.findIndex(p => p.id === socket.id);
    if (!lobby.impostorIndices.includes(playerIndex)) return;

    const correct = Number(guess) === lobby.rating;
    const impostorNames = lobby.impostorIndices.map(i => lobby.players[i].name).join(' & ');
    lobby.result = {
      type: correct ? 'impostor_guess_correct' : 'impostor_guess_wrong',
      impostorNames,
      rating: lobby.rating,
      guessedRating: Number(guess),
    };
    lobby.state = 'result';
    broadcastLobby(lobby);
  });

  // ── Start vote phase ──────────────────────────────────────────────────────
  socket.on('game:startVote', () => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby || lobby.state !== 'discussion') return;
    lobby.state = 'vote';
    lobby.votes = {};
    broadcastLobby(lobby);
  });

  // ── Submit vote ───────────────────────────────────────────────────────────
  socket.on('game:vote', ({ targetIndex }) => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby || lobby.state !== 'vote') return;
    const playerIndex = lobby.players.findIndex(p => p.id === socket.id);
    if (playerIndex < 0) return;
    lobby.votes[socket.id] = targetIndex;
    broadcastLobby(lobby);

    // Check if all players have voted
    if (Object.keys(lobby.votes).length >= lobby.players.length) {
      resolveVote(lobby);
    }
  });

  // ── Play again ────────────────────────────────────────────────────────────
  socket.on('game:playAgain', () => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby || lobby.hostId !== socket.id) return;
    lobby.state = 'waiting';
    lobby.statements = [];
    lobby.votes = {};
    lobby.result = null;
    lobby.impostorIndices = [];
    lobby.revealsDone = 0;
    broadcastLobby(lobby);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby) return;
    lobby.players = lobby.players.filter(p => p.id !== socket.id);
    if (lobby.players.length === 0) {
      delete lobbies[lobby.code];
      return;
    }
    if (lobby.hostId === socket.id) lobby.hostId = lobby.players[0].id;
    broadcastLobby(lobby);
    io.to(lobby.code).emit('player:left', { name: 'A player' });
  });
});

function resolveVote(lobby) {
  const tally = {};
  lobby.players.forEach((_, i) => tally[i] = 0);
  Object.values(lobby.votes).forEach(v => { if (tally[v] !== undefined) tally[v]++; });

  const max = Math.max(...Object.values(tally));
  const tied = Object.keys(tally).filter(k => tally[k] === max).map(Number);
  const votedOutIndex = tied[Math.floor(Math.random() * tied.length)];
  const impostorNames = lobby.impostorIndices.map(i => lobby.players[i].name).join(' & ');
  const isImpostor = lobby.impostorIndices.includes(votedOutIndex);

  lobby.result = {
    type: isImpostor ? 'crew_wins' : 'impostor_survives',
    impostorNames,
    rating: lobby.rating,
    votedOutName: lobby.players[votedOutIndex].name,
    wasTie: tied.length > 1,
  };
  lobby.state = 'result';
  broadcastLobby(lobby);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Out of Ten running on port ${PORT}`));
