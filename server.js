const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// --- Canciones disponibles ---
const songs = [
  {
    id: 'song1',
    title: 'Neon Rush',
    duration: 25000, // 25 segundos
    bpm: 140,
    genre: 'electro',
    noteMap: generateNoteMap(25000, 0.4, 0.3, 0.3) // tap, hold, flick
  },
  {
    id: 'song2',
    title: 'Crystal Dreams',
    duration: 30000,
    bpm: 120,
    genre: 'pop',
    noteMap: generateNoteMap(30000, 0.5, 0.2, 0.3)
  },
  {
    id: 'song3',
    title: 'Inferno',
    duration: 20000,
    bpm: 160,
    genre: 'rock',
    noteMap: generateNoteMap(20000, 0.3, 0.4, 0.3)
  },
  {
    id: 'song4',
    title: 'Stellar Wave',
    duration: 35000,
    bpm: 100,
    genre: 'ambient',
    noteMap: generateNoteMap(35000, 0.6, 0.1, 0.3)
  }
];

// Generador de mapas de notas (patrones pseudoaleatorios)
function generateNoteMap(durationMs, tapRatio, holdRatio, flickRatio) {
  const notes = [];
  const interval = 400; // ms entre notas base
  let time = 1000;
  while (time < durationMs - 1000) {
    const lane = Math.floor(Math.random() * 4);
    const rand = Math.random();
    let type;
    if (rand < tapRatio) type = 'tap';
    else if (rand < tapRatio + holdRatio) type = 'hold';
    else type = 'flick';
    const holdDuration = type === 'hold' ? 300 + Math.floor(Math.random() * 400) : 0;
    notes.push({ lane, type, time, duration: holdDuration });
    time += interval * (0.8 + Math.random() * 0.5);
  }
  return notes;
}

// --- Salas y estado del juego ---
let currentSong = null;      // canción seleccionada
let players = new Map();     // ws -> player
let gameState = 'lobby';    // 'lobby', 'countdown', 'playing', 'results'
let songStartTime = 0;
let hostWs = null;

function broadcast(msg, excludeWs = null) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

function sendTo(ws, msg) {
  ws.send(JSON.stringify(msg));
}

function resetGame() {
  gameState = 'lobby';
  currentSong = null;
  songStartTime = 0;
  players.forEach(p => {
    p.score = 0; p.combo = 0; p.life = 100; p.perfect = 0; p.great = 0; p.good = 0; p.miss = 0;
  });
  hostWs = null;
}

wss.on('connection', (ws) => {
  const playerId = Math.random().toString(36).substr(2, 6);
  const player = {
    id: playerId,
    ws,
    score: 0,
    combo: 0,
    maxCombo: 0,
    life: 100,
    perfect: 0,
    great: 0,
    good: 0,
    miss: 0,
    alive: true
  };
  players.set(ws, player);

  // Enviar lista de canciones y estado actual
  sendTo(ws, { type: 'songList', songs: songs.map(s => ({ id: s.id, title: s.title, duration: s.duration, bpm: s.bpm, genre: s.genre })) });
  sendTo(ws, { type: 'gameState', state: gameState, currentSong: currentSong?.id });

  // Si el juego ya está en marcha, enviar datos actuales
  if (gameState === 'playing' && currentSong) {
    sendTo(ws, { type: 'start', startTime: songStartTime, noteMap: currentSong.noteMap });
  }

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    switch (msg.type) {
      case 'selectSong':
        if (gameState === 'lobby' && !currentSong) {
          const song = songs.find(s => s.id === msg.songId);
          if (song) {
            currentSong = song;
            hostWs = ws;
            // Notificar a todos que se seleccionó una canción y empezar cuenta atrás
            broadcast({ type: 'songSelected', song: { id: song.id, title: song.title, duration: song.duration } });
            gameState = 'countdown';
            const countdown = 5000;
            setTimeout(() => {
              if (gameState === 'countdown' && currentSong) {
                songStartTime = Date.now() + 2000; // pequeño margen
                gameState = 'playing';
                broadcast({ type: 'start', startTime: songStartTime, noteMap: currentSong.noteMap });
                // Al terminar la canción, volver al lobby
                setTimeout(() => {
                  if (gameState === 'playing') {
                    broadcast({ type: 'gameOver' });
                    resetGame();
                    broadcast({ type: 'gameState', state: 'lobby', currentSong: null });
                  }
                }, currentSong.duration + 3000);
              }
            }, countdown);
            broadcast({ type: 'gameState', state: 'countdown', countdown, currentSong: song.id });
          }
        }
        break;

      case 'hit':
        handleHit(ws, msg);
        break;
    }
  });

  ws.on('close', () => {
    players.delete(ws);
    if (players.size === 0) {
      resetGame();
    }
    broadcast({ type: 'playerList', players: getPlayerList() });
    if (hostWs === ws) hostWs = null;
  });

  // Enviar lista inicial de jugadores
  broadcast({ type: 'playerList', players: getPlayerList() });
});

function getPlayerList() {
  return Array.from(players.values()).map(p => ({
    id: p.id,
    score: p.score,
    combo: p.combo,
    life: p.life,
    alive: p.alive
  }));
}

function handleHit(ws, msg) {
  const player = players.get(ws);
  if (!player || gameState !== 'playing' || !currentSong) return;

  const { lane, type } = msg;
  const note = currentSong.noteMap.find(n =>
    n.lane === lane && !n.hit && Math.abs(Date.now() - songStartTime - n.time) < 200
  );
  if (note) {
    const diff = Date.now() - songStartTime - note.time;
    let judgement = '';
    if (Math.abs(diff) < 50) {
      judgement = 'perfect';
      player.combo++;
      player.perfect++;
      player.score += 1000 + player.combo * 100;
    } else if (Math.abs(diff) < 100) {
      judgement = 'great';
      player.combo++;
      player.great++;
      player.score += 500 + player.combo * 50;
    } else {
      judgement = 'good';
      player.combo = 0;
      player.good++;
      player.score += 200;
    }
    if (player.combo > player.maxCombo) player.maxCombo = player.combo;
    note.hit = true;
    broadcast({ type: 'hitResult', playerId: player.id, judgement, combo: player.combo, score: player.score, life: player.life });
  } else {
    // Miss
    player.combo = 0;
    player.miss++;
    player.life = Math.max(0, player.life - 10);
    broadcast({ type: 'hitResult', playerId: player.id, judgement: 'miss', combo: 0, score: player.score, life: player.life });
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor de ritmo listo en puerto ${PORT}`));
