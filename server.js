// 5 Koszmarów Szymona Ignaczaka — serwer co-op (pokoje do 3 graczy)
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 3;
const INDEX = path.join(__dirname, 'public', 'index.html');

let indexRaw = null, indexGz = null;
function loadIndex() {
  try { indexRaw = fs.readFileSync(INDEX); indexGz = zlib.gzipSync(indexRaw); }
  catch (e) { console.error('Brak public/index.html', e.message); }
}
loadIndex();

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url === '/' || url === '/index.html') {
    if (!indexRaw) { res.writeHead(500); return res.end('Brak gry (public/index.html)'); }
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
    return res.end(gz ? indexGz : indexRaw);
  }
  if (url === '/rooms') { // simple status page
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify([...rooms.values()].map(r => ({ code: r.code, players: r.clients.size }))));
  }
  res.writeHead(404); res.end('404');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
const rooms = new Map(); // code -> {code, host, clients: Map(id -> ws), nextId}

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let i = 0; i < 50; i++) {
    let c = ''; for (let k = 0; k < 4; k++) c += A[Math.floor(Math.random() * A.length)];
    if (!rooms.has(c)) return c;
  }
  return String(Date.now()).slice(-4);
}
function send(ws, m) { if (ws.readyState === 1) ws.send(typeof m === 'string' ? m : JSON.stringify(m)); }
function peersOf(room, exceptId) {
  const out = [];
  for (const [id, c] of room.clients) if (id !== exceptId) out.push({ id, name: c.info.name, char: c.info.char, look: c.info.look, eq: c.info.eq, style: c.info.style });
  return out;
}
function broadcast(room, m, exceptId) {
  const s = typeof m === 'string' ? m : JSON.stringify(m);
  for (const [id, c] of room.clients) if (id !== exceptId) send(c, s);
}
function leave(ws) {
  const room = ws.room; if (!room) return;
  room.clients.delete(ws.pid); ws.room = null;
  if (room.clients.size === 0) { rooms.delete(room.code); return; }
  broadcast(room, { t: 'peer-', id: ws.pid });
  if (room.host === ws.pid) {
    room.host = Math.min(...room.clients.keys());
    broadcast(room, { t: 'host', id: room.host });
  }
}
function clean(info) {
  info = info || {};
  return { name: String(info.name || 'Gracz').slice(0, 16), char: String(info.char || 'ignaczak').slice(0, 16), look: info.look || {}, eq: info.eq || {}, style: info.style || 'melee' };
}

wss.on('connection', (ws) => {
  ws.alive = true; ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'create') {
      leave(ws);
      const code = makeCode();
      const room = { code, host: 1, clients: new Map(), nextId: 2 };
      rooms.set(code, room); ws.room = room; ws.pid = 1; ws.info = clean(m);
      room.clients.set(1, ws);
      return send(ws, { t: 'joined', room: code, you: 1, host: 1, peers: [] });
    }
    if (m.t === 'join') {
      const code = String(m.room || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'err', msg: 'Nie ma pokoju ' + code });
      if (room.clients.size >= MAX_PLAYERS) return send(ws, { t: 'err', msg: 'Pokój pełny (max ' + MAX_PLAYERS + ')' });
      leave(ws);
      const id = room.nextId++; ws.room = room; ws.pid = id; ws.info = clean(m);
      room.clients.set(id, ws);
      send(ws, { t: 'joined', room: code, you: id, host: room.host, peers: peersOf(room, id) });
      return broadcast(room, { t: 'peer+', p: { id, name: ws.info.name, char: ws.info.char, look: ws.info.look, eq: ws.info.eq, style: ws.info.style } }, id);
    }
    if (m.t === 'leave') { leave(ws); return send(ws, { t: 'left' }); }
    const room = ws.room; if (!room) return;
    if (m.t === 'look') { ws.info = clean(Object.assign({}, ws.info, m)); }
    m.from = ws.pid;
    const s = JSON.stringify(m);
    if (m.to) { const c = room.clients.get(m.to); if (c) send(c, s); }
    else if (m.toHost) { const c = room.clients.get(room.host); if (c && room.host !== ws.pid) send(c, s); }
    else broadcast(room, s, ws.pid);
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { try { ws.terminate(); } catch (e) {} continue; }
    ws.alive = false; try { ws.ping(); } catch (e) {}
  }
}, 25000);

server.listen(PORT, () => console.log('Serwer co-op działa na porcie ' + PORT));
