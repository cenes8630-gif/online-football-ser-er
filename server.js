const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 25000, pingTimeout: 20000 });
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
const rooms = new Map();
const waiting = [];
const FIELD_X = 34, FIELD_Z = 52.5;

function code() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }
function newRoom(id) {
  const room = { id, ids: [], started: false, players: {}, ball: { x: 0, y: 0.44, z: 0, vx: 0, vy: 0, vz: 0 }, score: [0, 0], lastKick: 0, goalCooldown: 0, passFlight: null, possessionId: null };
  rooms.set(id, room); return room;
}
function emitState(room) {
  io.to(room.id).emit('state', { code: room.id, started: room.started, players: room.players, ball: room.ball, score: room.score, count: room.ids.length });
}
function joinRoom(socket, room) {
  if (room.ids.length >= 2 || room.ids.includes(socket.id)) return false;
  const side = room.ids.length;
  room.ids.push(socket.id); socket.join(room.id); socket.data.roomId = room.id; socket.data.side = side;
  room.players[socket.id] = { id: socket.id, side, x: side === 0 ? -4 : 4, z: side === 0 ? 3 : -3, yaw: side === 0 ? Math.PI : 0, action: 'idle', team: 'Fenerbahçe', index: 9 };
  socket.emit('joined', { code: room.id, side });
  emitState(room);
  if (room.ids.length === 2) { room.started = true; io.to(room.id).emit('matchReady', { code: room.id }); emitState(room); }
  return true;
}
function roomFor(socket) { const id = socket.data.roomId; return id && rooms.get(id); }
function removeFromQueue(id) { for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i] === id) waiting.splice(i, 1); }

io.on('connection', socket => {
  socket.emit('connected', { id: socket.id });
  socket.on('setTeam', data => { const r = roomFor(socket); if (r && r.players[socket.id]) r.players[socket.id].team = String(data && data.team || 'Fenerbahçe').slice(0, 32); });
  socket.on('quickMatch', () => {
    removeFromQueue(socket.id);
    let other = null;
    while (waiting.length && !other) {
      const id = waiting.shift();
      const candidate = io.sockets.sockets.get(id);
      if (candidate && candidate.connected && !candidate.data.roomId && id !== socket.id) other = candidate;
    }
    if (!other) { waiting.push(socket.id); socket.emit('queue', 'Rakip aranıyor… Bu ekranı açık tut.'); return; }
    const room = newRoom(code()); joinRoom(other, room); joinRoom(socket, room);
  });
  socket.on('createRoom', () => {
    if (roomFor(socket)) return socket.emit('notice', 'Zaten bir odadasın.');
    const room = newRoom(code()); joinRoom(socket, room); socket.emit('roomCreated', { code: room.id });
  });
  socket.on('joinRoom', raw => {
    const id = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!id) return socket.emit('notice', 'Oda kodunu gir.');
    const room = rooms.get(id);
    if (!room) return socket.emit('notice', 'Bu oda bulunamadı veya kapandı.');
    if (!joinRoom(socket, room)) socket.emit('notice', 'Oda dolu.');
  });
  socket.on('playerMove', data => {
    const r = roomFor(socket); if (!r || !r.players[socket.id] || !data) return;
    const p = r.players[socket.id];
    p.x = Math.max(-FIELD_X + 1, Math.min(FIELD_X - 1, Number(data.x) || 0));
    p.z = Math.max(-FIELD_Z + 1, Math.min(FIELD_Z - 1, Number(data.z) || 0));
    p.yaw = Number.isFinite(data.yaw) ? data.yaw : p.yaw;
    p.action = ['idle', 'run', 'kick'].includes(data.action) ? data.action : 'idle';
    p.index = Math.max(0, Math.min(10, Number.isFinite(Number(data.index)) ? Number(data.index) : 9));
    if (data.team) p.team = String(data.team).slice(0, 32);
  });
  socket.on('kickBall', data => {
    const r = roomFor(socket); if (!r || !r.started || !r.players[socket.id] || !data) return;
    const p = r.players[socket.id], b = r.ball;
    const dx = Number(data.dx) || 0, dz = Number(data.dz) || (p.side === 0 ? -1 : 1);
    const length = Math.hypot(dx, dz) || 1;
    if (Math.hypot(p.x - b.x, p.z - b.z) > 4.7) return;
    r.possessionId = null;
    const startX = p.x + dx / length * 0.95, startZ = p.z + dz / length * 0.95;
    b.x = startX; b.z = startZ; b.y = 0.5; b.vx = 0; b.vy = 0; b.vz = 0;
    if (data.kind === 'pass' && Number.isFinite(Number(data.targetX)) && Number.isFinite(Number(data.targetZ))) {
      const tx = Math.max(-33, Math.min(33, Number(data.targetX)));
      const tz = Math.max(-52, Math.min(52, Number(data.targetZ)));
      const dist = Math.hypot(tx - startX, tz - startZ);
      r.passFlight = { startX, startZ, targetX: tx, targetZ: tz, distance: dist, duration: Math.max(0.32, Math.min(1.5, dist / 18)), elapsed: 0 };
      r.lastKick = Date.now();
      emitState(r);
      return;
    }
    r.passFlight = null;
    const power = Math.max(9, Math.min(27, Number(data.speed) || 20));
    b.vx = dx / length * power; b.vz = dz / length * power;
    b.vy = Math.max(1.2, Math.min(12, Number(data.vy) || 4)); r.lastKick = Date.now();
  });
  socket.on('claimBall', data => {
    const r = roomFor(socket); if (!r || !r.started || !r.players[socket.id] || !data) return;
    const p = r.players[socket.id], b = r.ball;
    const x = Math.max(-33, Math.min(33, Number(data.x) || 0));
    const z = Math.max(-52, Math.min(52, Number(data.z) || 0));
    // Accept claims only when the reported receiving player is close to the server ball.
    if (Math.hypot(x - b.x, z - b.z) > 2.8 && !r.passFlight) return;
    p.x = x; p.z = z; p.yaw = Number.isFinite(data.yaw) ? data.yaw : p.yaw;
    p.index = Math.max(0, Math.min(10, Number.isFinite(Number(data.index)) ? Number(data.index) : p.index));
    r.passFlight = null; r.possessionId = socket.id;
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    Object.assign(b, { x: p.x + fx * 0.78, y: 0.44, z: p.z + fz * 0.78, vx: 0, vy: 0, vz: 0 });
    emitState(r);
  });
  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    const r = roomFor(socket); if (!r) return;
    if (r.possessionId === socket.id) r.possessionId = null;
    r.passFlight = null;
    r.ids = r.ids.filter(id => id !== socket.id); delete r.players[socket.id];
    io.to(r.id).emit('opponentLeft', 'Rakip bağlantıyı kesti.'); emitState(r);
    if (!r.ids.length) rooms.delete(r.id); else r.started = false;
  });
});

setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    if (!r.started) continue;
    const b = r.ball, dt = 0.05;
    if (r.passFlight) {
      const f = r.passFlight; f.elapsed += dt; const t = Math.max(0, Math.min(1, f.elapsed / f.duration));
      b.x = f.startX + (f.targetX - f.startX) * t; b.z = f.startZ + (f.targetZ - f.startZ) * t;
      b.y = 0.44 + Math.sin(Math.PI * t) * Math.min(0.42, 0.16 + f.distance * 0.009);
      b.vx = 0; b.vy = 0; b.vz = 0;
      if (t >= 1) { b.x = f.targetX; b.z = f.targetZ; b.y = 0.44; r.passFlight = null; }
    } else if (r.possessionId && r.players[r.possessionId]) {
      const p = r.players[r.possessionId], fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
      Object.assign(b, { x: p.x + fx * 0.78, y: 0.44, z: p.z + fz * 0.78, vx: 0, vy: 0, vz: 0 });
    } else {
      b.vy -= 9.8 * dt; b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
      if (b.y < 0.44) { b.y = 0.44; if (b.vy < 0) b.vy *= -0.42; if (Math.abs(b.vy) < 0.7) b.vy = 0; b.vx *= 0.985; b.vz *= 0.985; }
      b.vx *= 0.992; b.vz *= 0.992;
    }
    if (Math.abs(b.x) > 37) { b.x = Math.sign(b.x) * 37; b.vx *= -0.5; }
    if (now > r.goalCooldown && Math.abs(b.z) > FIELD_Z && Math.abs(b.x) < 3.66 && b.y < 2.6) {
      const scoring = b.z < 0 ? 0 : 1; r.score[scoring]++; r.passFlight = null; r.possessionId = null;
      io.to(r.id).emit('goal', { score: r.score });
      Object.assign(b, { x: 0, y: 0.44, z: 0, vx: 0, vy: 0, vz: 0 }); r.goalCooldown = now + 1800;
    } else if (Math.abs(b.z) > 57) { b.z = Math.sign(b.z) * 56; b.vz *= -0.35; }
    emitState(r);
  }
}, 50);
server.listen(PORT, '0.0.0.0', () => console.log(`Online Football 3D V11 sunucusu: http://localhost:${PORT}`));
