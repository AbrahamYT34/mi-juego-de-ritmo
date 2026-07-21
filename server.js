const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Servir archivos estáticos (el juego)
app.use(express.static(path.join(__dirname, 'public')));

// --- Estado del juego ---
const ROOM_SIZE = 4;
let players = new Map(); // ws -> { id, room, score, combo, life, ... }
let rooms = new Map();   // roomName -> { players: [], songStartTime: 0, noteMap: [] }

// Notas predefinidas para la canción (duración 30 seg)
const noteMap = [];
// Generamos una secuencia de notas (lane: 0-3, type: 'tap','hold','flick', time: ms)
// Usamos un patrón de batería simple: cada 500ms una nota, alternando carriles.
for (let t = 1000; t <= 30000; t += 500) {
  const lane = Math.floor(Math.random() * 4);
  const type = Math.random() < 0.7 ? 'tap' : Math.random() < 0.5 ? 'hold' : 'flick';
  noteMap.push({ lane, type, time: t, duration: type === 'hold' ? 400 : 0 });
}

// WebSocket
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    switch (msg.type) {
      case 'join':
        const roomName = msg.room || 'default';
        if (!rooms.has(roomName)) {
          rooms.set(roomName, { players: [], songStartTime: 0, noteMap });
        }
        const room = rooms.get(roomName);
        if (room.players.length >= ROOM_SIZE) {
          ws.send(JSON.stringify({ type: 'error', message: 'Sala llena' }));
          return;
        }
        const playerId = Math.random().toString(36).substr(2, 6);
        const player = {
          id: playerId,
          ws,
          room: roomName,
          score: 0,
          combo: 0,
          maxCombo: 0,
          life: 100,
          perfect: 0,
          great: 0,
          good: 0,
          miss: 0,
        };
        room.players.push(player);
        players.set(ws, player);

        // Enviar asignación de carril (cada jugador usa los mismos 4 carriles, pero su color)
        ws.send(JSON.stringify({ type: 'joined', playerId, laneColors: ['#FF6B6B','#4ECDC4','#FFE66D','#FF9FF3'] }));
        broadcastRoom(roomName, { type: 'playerList', players: room.players.map(p => ({ id: p.id, score: p.score, combo: p.combo, life: p.life })) });

        // Si hay suficientes jugadores y no ha iniciado, iniciar después de cuenta atrás
        if (room.players.length >= 1 && !room.songStartTime) {
          startGame(roomName);
        }
        break;

      case 'hit':
        handleHit(ws, msg);
        break;

      case 'start':
        // solo el host puede iniciar? por ahora omitimos.
        break;
    }
  });

  ws.on('close', () => {
    const player = players.get(ws);
    if (player) {
      players.delete(ws);
      const room = rooms.get(player.room);
      if (room) {
        room.players = room.players.filter(p => p.id !== player.id);
        broadcastRoom(player.room, { type: 'playerList', players: room.players.map(p => ({ id: p.id, score: p.score, combo: p.combo, life: p.life })) });
        if (room.players.length === 0) {
          rooms.delete(player.room);
        }
      }
    }
  });
});

function startGame(roomName) {
  const room = rooms.get(roomName);
  if (!room) return;
  const startDelay = 3000; // cuenta atrás
  room.songStartTime = Date.now() + startDelay;
  broadcastRoom(roomName, { type: 'start', startTime: room.songStartTime, noteMap: room.noteMap });
}

function handleHit(ws, msg) {
  const player = players.get(ws);
  if (!player) return;
  const room = rooms.get(player.room);
  if (!room || !room.songStartTime) return;

  const now = Date.now();
  const { lane, type } = msg; // type: 'tap' o 'flick' (hold se maneja con inicio/fin)
  // Buscar la nota más cercana en ese carril dentro de una ventana de tiempo
  const note = room.noteMap.find(n => n.lane === lane && !n.hit && Math.abs(now - room.songStartTime - n.time) < 150);
  if (note) {
    const diff = now - room.songStartTime - note.time;
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
    broadcastRoom(player.room, { type: 'hitResult', playerId: player.id, judgement, combo: player.combo, score: player.score, life: player.life });
  } else {
    // fallo (miss)
    player.combo = 0;
    player.miss++;
    player.life = Math.max(0, player.life - 10);
    broadcastRoom(player.room, { type: 'hitResult', playerId: player.id, judgement: 'miss', combo: 0, score: player.score, life: player.life });
  }
}

function broadcastRoom(roomName, msg) {
  const room = rooms.get(roomName);
  if (!room) return;
  const data = JSON.stringify(msg);
  room.players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Rhythm Legends corriendo en puerto ${PORT}`));