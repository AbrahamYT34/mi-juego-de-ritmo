const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configurar multer para guardar archivos en public/uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // Nombre único
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + '.mp3';
    cb(null, uniqueName);
  }
});
const upload = multer({ storage, fileFilter: (req, file, cb) => {
  if (file.mimetype === 'audio/mpeg' || file.originalname.endsWith('.mp3')) cb(null, true);
  else cb(new Error('Solo archivos MP3'));
}});

app.use(express.static(path.join(__dirname, 'public')));

// Endpoint para subir canción (solo accesible desde el juego)
app.post('/upload', upload.single('song'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });
  const fileUrl = '/uploads/' + req.file.filename;
  res.json({ url: fileUrl });
});

// ========== CANCIONES PREDEFINIDAS ==========
const predefinedSongs = [
  { id: 'neon', title: 'Neon Rush', artist: 'Kubbi', duration: 28000, bpm: 150, genre: 'Electro', color: '#ff2a6d', file: '/songs/neon.mp3', noteMap: generateNoteMap(28000, 150, 0.4, 0.3, 0.3) },
  { id: 'crystal', title: 'Crystal Dreams', artist: 'Daystar', duration: 32000, bpm: 128, genre: 'Pop', color: '#4ecdc4', file: '/songs/crystal.mp3', noteMap: generateNoteMap(32000, 128, 0.5, 0.2, 0.3) },
  { id: 'inferno', title: 'Inferno', artist: 'AlexiAction', duration: 22000, bpm: 175, genre: 'Rock', color: '#ff6b35', file: '/songs/inferno.mp3', noteMap: generateNoteMap(22000, 175, 0.3, 0.4, 0.3) },
  { id: 'stellar', title: 'Stellar Wave', artist: 'Alexander Nakarada', duration: 35000, bpm: 105, genre: 'Ambient', color: '#c77dff', file: '/songs/stellar.mp3', noteMap: generateNoteMap(35000, 105, 0.6, 0.1, 0.3) }
];

function generateNoteMap(durationMs, bpm, tapRatio, holdRatio, flickRatio) {
  const notes = [];
  const beatInterval = 60000 / bpm;
  let time = beatInterval * 2;
  while (time < durationMs - beatInterval * 2) {
    const isDouble = Math.random() < 0.15;
    const lanes = [];
    if (isDouble) {
      lanes.push(Math.floor(Math.random() * 4), (Math.floor(Math.random() * 4) + 1) % 4);
    } else {
      lanes.push(Math.floor(Math.random() * 4));
    }
    let type;
    const rand = Math.random();
    if (rand < tapRatio) type = 'tap';
    else if (rand < tapRatio + holdRatio) type = 'hold';
    else type = 'flick';
    const holdDuration = type === 'hold' ? beatInterval * (0.5 + Math.random() * 1.5) : 0;
    lanes.forEach(lane => notes.push({ lane, type, time: Math.round(time), duration: holdDuration }));
    time += beatInterval * (0.5 + Math.random());
  }
  return notes.sort((a,b) => a.time - b.time);
}

// Estado del juego (ahora currentSong puede ser de la lista o personalizada)
let currentSong = null;
let players = new Map();
let gameState = 'lobby';
let songStartTime = 0;
let hostWs = null;

function broadcast(msg, excludeWs = null) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) client.send(data);
  });
}
function sendTo(ws, msg) { ws.send(JSON.stringify(msg)); }

function resetGame() {
  gameState = 'lobby';
  currentSong = null;
  songStartTime = 0;
  players.forEach(p => { p.score = 0; p.combo = 0; p.maxCombo = 0; p.life = 100; p.perfect = 0; p.great = 0; p.good = 0; p.miss = 0; p.alive = true; });
  hostWs = null;
}

wss.on('connection', (ws) => {
  const playerId = Math.random().toString(36).substr(2,6);
  const player = { id: playerId, ws, score:0, combo:0, maxCombo:0, life:100, perfect:0, great:0, good:0, miss:0, alive:true, character:0 };
  players.set(ws, player);

  // Enviar canciones predefinidas y estado
  sendTo(ws, { type: 'songList', songs: predefinedSongs.map(s => ({ id:s.id, title:s.title, artist:s.artist, duration:s.duration, bpm:s.bpm, genre:s.genre, color:s.color, file:s.file })) });
  sendTo(ws, { type: 'playerId', playerId });
  sendTo(ws, { type: 'gameState', state: gameState, currentSong: currentSong?.id });

  if (gameState === 'playing' && currentSong) {
    sendTo(ws, { type: 'start', startTime: songStartTime, songFile: currentSong.file, noteMap: currentSong.noteMap });
  }
  broadcast({ type: 'playerList', players: getPlayerList() });

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    switch(msg.type) {
      case 'selectSong':
        if (gameState === 'lobby' && !currentSong) {
          const song = predefinedSongs.find(s => s.id === msg.songId);
          if (song) {
            currentSong = song;
            startGameSequence();
          }
        }
        break;
      case 'customSong':
        if (gameState === 'lobby' && !currentSong && msg.url && msg.bpm && msg.duration) {
          // Crear canción personalizada
          const custom = {
            id: 'custom_' + Date.now(),
            title: 'Canción personalizada',
            artist: 'Subida por el host',
            duration: msg.duration * 1000, // en ms
            bpm: msg.bpm,
            genre: 'Custom',
            color: '#ffcc00',
            file: msg.url,
            noteMap: generateNoteMap(msg.duration * 1000, msg.bpm, 0.4, 0.3, 0.3)
          };
          currentSong = custom;
          startGameSequence();
        }
        break;
      case 'hit':
        handleHit(ws, msg);
        break;
      case 'character':
        player.character = msg.index;
        break;
    }
  });

  ws.on('close', () => {
    players.delete(ws);
    if (players.size === 0) resetGame();
    broadcast({ type: 'playerList', players: getPlayerList() });
    if (hostWs === ws) hostWs = null;
  });
});

function startGameSequence() {
  hostWs = Array.from(players.keys())[0]; // el primero que mandó select/custom es host
  gameState = 'countdown';
  broadcast({ type: 'songSelected', song: { id:currentSong.id, title:currentSong.title, artist:currentSong.artist, duration:currentSong.duration, bpm:currentSong.bpm, file:currentSong.file } });
  setTimeout(() => {
    if (gameState === 'countdown' && currentSong) {
      songStartTime = Date.now() + 3000;
      gameState = 'playing';
      broadcast({ type: 'start', startTime: songStartTime, songFile: currentSong.file, noteMap: currentSong.noteMap });
      setTimeout(() => {
        if (gameState === 'playing') {
          gameState = 'results';
          broadcast({ type: 'gameOver', players: getPlayerList() });
          setTimeout(() => {
            resetGame();
            broadcast({ type: 'gameState', state: 'lobby', currentSong: null });
            broadcast({ type: 'songList', songs: predefinedSongs.map(s => ({ id:s.id, title:s.title, artist:s.artist, duration:s.duration, bpm:s.bpm, genre:s.genre, color:s.color, file:s.file })) });
          }, 10000);
        }
      }, currentSong.duration + 2000);
    }
  }, 5000);
  broadcast({ type: 'gameState', state: 'countdown', countdown: 5, currentSong: currentSong.id });
}

function getPlayerList() {
  return Array.from(players.values()).map(p => ({ id:p.id, score:p.score, combo:p.combo, life:p.life, alive:p.alive, character:p.character, maxCombo:p.maxCombo, perfect:p.perfect, great:p.great, good:p.good, miss:p.miss }));
}

function handleHit(ws, msg) { /* igual que antes, sin cambios */ }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Servidor listo en puerto', PORT));
