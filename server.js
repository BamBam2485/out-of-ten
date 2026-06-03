const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const lobbies = {};

// Track recent ratings per lobby to avoid repeats
const recentRatings = {};

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

// Pick a rating that wasn't used in the last 3 rounds
function pickRating(code) {
  const recent = recentRatings[code] || [];
  let rating;
  let attempts = 0;
  do {
    rating = Math.floor(Math.random() * 10) + 1;
    attempts++;
  } while (recent.includes(rating) && attempts < 20);
  recentRatings[code] = [...recent.slice(-2), rating];
  return rating;
}

// Shuffle array properly
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

io.on('connection', (socket) => {

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

  socket.on('lobby:setImpostors', ({ count }) => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby || lobby.hostId !== socket.id) return;
    const max = Math.floor(lobby.players.length / 2);
    lobby.impostorCount = Math.max(1, Math.min(max, count));
    broadcastLobby(lobby);
  });

  socket.on('game:start', () => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby || lobby.hostId !== socket.id) return;
    if (lobby.players.length < 3) { socket.emit('error', 'Need at least 3 players.'); return; }

    // Fix: use proper shuffle so host isn't always impostor
    lobby.rating = pickRating(lobby.code);
    const shuffled = shuffle([...Array(lobby.players.length).keys()]);
    lobby.impostorIndices = shuffled.slice(0, lobby.impostorCount);

    lobby.state = 'reveal';
    lobby.statements = [];
    lobby.currentTurn = 0;
    lobby.votes = {};
    lobby.revealsDone = 0;
    lobby.result = null;

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

  socket.on('game:submitStatement', ({ text }) => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby || lobby.state !== 'statement') return;
    const playerIndex = lobby.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== lobby.currentTurn) return;

    const statement = {
      playerIndex,
      name: lobby.players[playerIndex].name,
      text: (text || '').trim() || '(no statement)',
    };
    lobby.statements.push(statement);

    // Broadcast the new statement to everyone immediately
    io.to(lobby.code).emit('game:newStatement', statement);

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

  socket.on('game:startVote', () => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby || lobby.state !== 'discussion') return;
    lobby.state = 'vote';
    lobby.votes = {};
    broadcastLobby(lobby);
  });

  socket.on('game:vote', ({ targetIndex }) => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby || lobby.state !== 'vote') return;
    const playerIndex = lobby.players.findIndex(p => p.id === socket.id);
    if (playerIndex < 0) return;
    lobby.votes[socket.id] = targetIndex;
    broadcastLobby(lobby);
    if (Object.keys(lobby.votes).length >= lobby.players.length) {
      resolveVote(lobby);
    }
  });

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

  socket.on('disconnect', () => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby) return;

    const playerName = lobby.players.find(p => p.id === socket.id)?.name || 'A player';
    lobby.players = lobby.players.filter(p => p.id !== socket.id);

    if (lobby.players.length === 0) {
      delete lobbies[lobby.code];
      delete recentRatings[lobby.code];
      return;
    }

    if (lobby.hostId === socket.id) lobby.hostId = lobby.players[0].id;

    // If game is mid-round, end it gracefully rather than crashing
    if (['reveal', 'statement', 'discussion', 'vote'].includes(lobby.state)) {
      if (lobby.players.length < 2) {
        // Not enough players to continue
        lobby.state = 'waiting';
        lobby.statements = [];
        lobby.votes = {};
        lobby.result = null;
        lobby.impostorIndices = [];
        lobby.revealsDone = 0;
        broadcastLobby(lobby);
        io.to(lobby.code).emit('game:aborted', { reason: `${playerName} left — not enough players to continue.` });
      } else {
        // Enough players — notify and continue if possible
        io.to(lobby.code).emit('player:left', { name: playerName });
        broadcastLobby(lobby);
      }
    } else {
      broadcastLobby(lobby);
      io.to(lobby.code).emit('player:left', { name: playerName });
    }
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
    votedOutName: lobby.players[votedOutIndex] ? lobby.players[votedOutIndex].name : 'Unknown',
    wasTie: tied.length > 1,
  };
  lobby.state = 'result';
  broadcastLobby(lobby);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Out of Ten running on port ${PORT}`));
