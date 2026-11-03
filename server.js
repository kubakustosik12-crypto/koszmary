// 5 Koszmarów Szymona Ignaczaka — serwer multiplayer v2
// sesje do 10 graczy • lista sesji • prośby o dołączenie do lidera • każdy chodzi po innej mapie • anty-cheat
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const PROTO = 2;                 // wersja protokołu (stara gra w karcie przeglądarki = prośba o odświeżenie)
const LVMAX = 60;
const KNOCK_MS = 40000;          // ile lider ma czasu na odpowiedź
const BAN_MS = 10 * 60000;       // kara anty-cheat
const KICK_BAN_MS = 2 * 60000;   // wyrzucony przez lidera nie wraca od razu
const INDEX = path.join(__dirname, 'public', 'index.html');

// ---------- plik gry (przeładowuje się sam, gdy podmienisz public/index.html) ----------
let indexRaw = null, indexGz = null, indexMtime = 0;
function loadIndex() {
  try {
    const st = fs.statSync(INDEX);
    if (st.mtimeMs === indexMtime && indexRaw) return;
    indexRaw = fs.readFileSync(INDEX); indexGz = zlib.gzipSync(indexRaw); indexMtime = st.mtimeMs;
  } catch (e) { console.error('Brak public/index.html', e.message); }
}
loadIndex();

const rooms = new Map(); // code -> room
let KNOCKSEQ = 0;

function roomList() {
  const out = [];
  for (const r of rooms.values()) {
    if (!r.vis) continue;
    const L = r.clients.get(r.leader);
    let pvp = 0; for (const c of r.clients.values()) if (c.st && c.st.pv) pvp++;
    out.push({ code: r.code, name: r.name, leader: L ? L.info.name : '?', lch: L ? L.info.char : 'ignaczak', n: r.clients.size, max: MAX_PLAYERS,
      where: L && L.zk ? L.zk : '', lv: L && L.st ? L.st.lv : 0, pvp, open: !!r.open, age: Math.round((Date.now() - r.created) / 60000) });
  }
  return out.sort((a, b) => b.n - a.n || a.age - b.age).slice(0, 40);
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url === '/' || url === '/index.html') {
    loadIndex();
    if (!indexRaw) { res.writeHead(500); return res.end('Brak gry (public/index.html)'); }
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
    return res.end(gz ? indexGz : indexRaw);
  }
  if (url === '/rooms') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify(roomList()));
  }
  res.writeHead(404); res.end('404');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

// ---------- helpers ----------
function send(ws, m) { if (ws && ws.readyState === 1) ws.send(typeof m === 'string' ? m : JSON.stringify(m)); }
function broadcast(room, m, exceptId) { const s = typeof m === 'string' ? m : JSON.stringify(m); for (const [id, c] of room.clients) if (id !== exceptId) send(c, s); }
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
function num(v, d) { v = Number(v); return Number.isFinite(v) ? v : d; }
function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let i = 0; i < 80; i++) { let c = ''; for (let k = 0; k < 4; k++) c += A[Math.floor(Math.random() * A.length)]; if (!rooms.has(c)) return c; }
  return String(Date.now()).slice(-4);
}
function clean(info, prev) {
  info = info || {}; prev = prev || {};
  const lk = info.look && typeof info.look === 'object' ? info.look : (prev.look || {});
  const eq = info.eq && typeof info.eq === 'object' ? info.eq : (prev.eq || {});
  return { name: String(info.name || prev.name || 'Gracz').replace(/[<>]/g, '').trim().slice(0, 16) || 'Gracz', char: String(info.char || prev.char || 'ignaczak').slice(0, 16),
    look: JSON.parse(JSON.stringify(lk).slice(0, 2000) || '{}'), eq: JSON.parse(JSON.stringify(eq).slice(0, 1000) || '{}'), style: String(info.style || prev.style || 'melee').slice(0, 8),
    lv: Math.max(1, Math.min(LVMAX, Math.round(num(info.lv, prev.lv || 1)))), gv: String(info.gv || prev.gv || '').replace(/[^0-9a-z.]/gi, '').slice(0, 12) };
}
function safeClean(info, prev) { try { return clean(info, prev); } catch (e) { return clean({ name: info && info.name, char: info && info.char }, prev); } }
function peerInfo(c) { return { id: c.pid, name: c.info.name, char: c.info.char, look: c.info.look, eq: c.info.eq, style: c.info.style, lv: c.info.lv, gv: c.info.gv || '', zk: c.zk || '' }; }
function peersOf(room, exceptId) { const out = []; for (const [id, c] of room.clients) if (id !== exceptId) out.push(peerInfo(c)); return out; }
function nickTaken(room, name, ws) { const nk = name.trim().toLowerCase(); for (const c of room.clients.values()) if (c !== ws && c.info && c.info.name.trim().toLowerCase() === nk) return true; return false; }
function banned(room, ws, name) {
  const now = Date.now();
  for (const [k, until] of room.bans) if (until < now) room.bans.delete(k);
  return (ws.did && room.bans.has('d:' + ws.did)) || room.bans.has('n:' + String(name || '').toLowerCase());
}

// ---------- strefy: kto jest na jakiej mapie i kto "prowadzi" moby na danej mapie ----------
function zmapOf(room) { const o = {}; for (const [zk, Zs] of room.zones) o[zk] = { a: Zs.a, m: Zs.m.slice() }; return o; }
function sendZmap(room) { broadcast(room, { t: 'zmap', z: zmapOf(room) }); }
function zoneLeave(ws) {
  const room = ws.room, zk = ws.zk; ws.zk = null; if (!room || !zk) return;
  const Zs = room.zones.get(zk); if (!Zs) return;
  Zs.m = Zs.m.filter(id => id !== ws.pid);
  if (!Zs.m.length) { room.zones.delete(zk); return; }
  if (Zs.a === ws.pid) Zs.a = Zs.m[0];
}
function zoneEnter(ws, zk) {
  const room = ws.room; if (!room) return;
  ws.trk = null; // reset kontroli prędkości (teleport między mapami jest ok)
  if (ws.zk !== zk) {
    zoneLeave(ws); ws.zk = zk;
    let Zs = room.zones.get(zk); if (!Zs) { Zs = { a: ws.pid, m: [] }; room.zones.set(zk, Zs); }
    Zs.m.push(ws.pid);
  }
  sendZmap(room);
}

// ---------- sesje ----------
function joinRoom(ws, room, info) {
  if (room.clients.size >= MAX_PLAYERS) return send(ws, { t: 'err', code: 'full', msg: 'Sesja jest pełna (max ' + MAX_PLAYERS + ').' });
  if (nickTaken(room, info.name, ws)) return send(ws, { t: 'err', code: 'nick', msg: 'Nick „' + info.name + '” jest już zajęty w tej sesji. Zmień nick.' });
  if (banned(room, ws, info.name)) return send(ws, { t: 'err', code: 'ban', msg: 'Nie możesz teraz wejść do tej sesji (blokada czasowa).' });
  leave(ws, true); cancelKnock(ws, true);
  const id = room.nextId++; ws.room = room; ws.pid = id; ws.info = info; ws.zk = null; ws.st = null;
  room.clients.set(id, ws);
  send(ws, { t: 'joined', room: room.code, you: id, host: room.leader, peers: peersOf(room, id), zmap: zmapOf(room), sname: room.name, vis: room.vis, open: room.open });
  broadcast(room, { t: 'peer+', p: peerInfo(ws) }, id);
  log('join', room.code, info.name, '(' + room.clients.size + '/' + MAX_PLAYERS + ')');
}
function leave(ws, silent) {
  const room = ws.room; if (!room) return;
  zoneLeave(ws);
  room.clients.delete(ws.pid); ws.room = null; ws.zk = null;
  if (room.clients.size === 0) {
    for (const k of room.knocks.values()) { clearTimeout(k.timer); k.ws.knock = null; send(k.ws, { t: 'err', code: 'knock', msg: 'Sesja się zamknęła.' }); }
    rooms.delete(room.code); log('room closed', room.code); return;
  }
  broadcast(room, { t: 'peer-', id: ws.pid });
  if (room.leader === ws.pid) {
    room.leader = Math.min(...room.clients.keys());
    broadcast(room, { t: 'host', id: room.leader });
    const L = room.clients.get(room.leader);
    for (const [rid, k] of room.knocks) send(L, { t: 'knock', rid, name: k.info.name, char: k.info.char, lv: k.info.lv, left: Math.max(1, Math.round((k.t + KNOCK_MS - Date.now()) / 1000)) });
  }
  sendZmap(room);
}
function cancelKnock(ws, silent) {
  const k = ws.knock; if (!k) return; ws.knock = null;
  const room = rooms.get(k.room); if (!room) return;
  const K = room.knocks.get(k.rid); if (!K) return;
  clearTimeout(K.timer); room.knocks.delete(k.rid);
  send(room.clients.get(room.leader), { t: 'knockx', rid: k.rid });
}

// ---------- anty-cheat ----------
const ACNAME = { flood: 'spam pakietami', speed: 'teleport / speedhack', stats: 'nierealne statystyki', pvp: 'nierealne obrażenia PvP', dmg: 'nierealne obrażenia', spoof: 'podszywanie się pod serwer gry',
  'c:speed': 'przyspieszanie gry', 'c:save': 'edytowany zapis gry', 'c:stats': 'zmienione statystyki', 'c:gear': 'podrobiony sprzęt', 'c:items': 'podrobione przedmioty' };
const ACW = { flood: 3, speed: 1, stats: 1, pvp: 1, dmg: 1, spoof: 1, 'c:speed': 2, 'c:save': 1, 'c:stats': 2, 'c:gear': 2, 'c:items': 2 };
function hpCap(lv) { return 1200 + lv * 140; }
function pvpAtkCap(lv) { return 80 + lv * 28; }
function dmgCap(lv) { return 600 + lv * 450; }
function strike(ws, reason) {
  const now = Date.now(); ws.lastStrike = ws.lastStrike || {};
  if (now - (ws.lastStrike[reason] || 0) < 45000) return; // jedno przewinienie danego typu na 45 s
  ws.lastStrike[reason] = now;
  ws.strikes = (ws.strikes || []).filter(s => now - s.t < 300000); ws.strikes.push({ t: now, r: reason, w: ACW[reason] || 1 });
  const total = ws.strikes.reduce((a, s) => a + s.w, 0), nm = ws.info ? ws.info.name : '?';
  log('[AC]', ws.room ? ws.room.code : '-', nm, ws.ip, reason, 'pkt=' + total);
  if (total >= 3) return acKick(ws, reason);
  send(ws, { t: 'sys', ac: 1, msg: '🛡️ Anty-cheat: ostrzeżenie (' + (ACNAME[reason] || reason) + '). Jeszcze raz i wylatujesz z sesji.' });
}
function acKick(ws, reason) {
  const room = ws.room, nm = ws.info ? ws.info.name : '?', why = ACNAME[reason] || reason;
  if (room) {
    if (ws.did) room.bans.set('d:' + ws.did, Date.now() + BAN_MS); room.bans.set('n:' + nm.toLowerCase(), Date.now() + BAN_MS);
    broadcast(room, { t: 'sys', ac: 1, msg: '🛡️ Anty-cheat wyrzucił gracza ' + nm + ' (' + why + ').' }, ws.pid);
  }
  send(ws, { t: 'kicked', ac: 1, msg: '🛡️ Anty-cheat: wyrzucono Cię z sesji (' + why + '). Wróć za 10 minut, już bez oszukiwania.' });
  leave(ws);
}
function rateOk(ws) {
  const now = Date.now(), R = ws.rate;
  R.tok = Math.min(160, R.tok + (now - R.last) * 0.09); R.last = now;
  if (R.tok >= 1) { R.tok -= 1; return true; }
  if (now - R.dropT > 10000) { R.dropT = now; R.drops = 0; }
  if (++R.drops > 500) strike(ws, 'flood');
  return false;
}
function dist(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }
// kontrola prędkości: średnia z ok. 1,2 s, kilka wpadek w minucie = kara (pojedyncze odrodzenie się nie liczy)
function speedCheck(ws, x, z) {
  const now = Date.now(), T = ws.trk;
  if (!T) { ws.trk = { x, z, t: now, v: [] }; return; }
  const dt = (now - T.t) / 1000; if (dt < 1.2) return;
  const v = Math.hypot(x - T.x, z - T.z) / dt;
  T.x = x; T.z = z; T.t = now;
  T.v = T.v.filter(t => now - t < 60000);
  if (v > 38) { T.v.push(now); if (T.v.length >= 4) { T.v = []; strike(ws, 'speed'); } }
}
function validate(ws, m) {
  const t = m.t, room = ws.room;
  if (t === 'st') {
    const lv = Math.round(num(m.lv, 1)), hp = num(m.hp, 0), mh = num(m.mh, 1), x = num(m.x, NaN), z = num(m.zz, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > 5000 || Math.abs(z) > 5000) return false;
    if (lv < 1 || lv > LVMAX || mh > hpCap(lv) || hp > mh + 80 || hp < 0) { strike(ws, 'stats'); m.lv = Math.max(1, Math.min(LVMAX, lv)); m.mh = Math.min(mh, hpCap(m.lv)); m.hp = Math.min(Math.max(0, hp), m.mh); }
    if (typeof m.z === 'string' && m.z === ws.zk) speedCheck(ws, x, z);
    ws.st = { x, z, lv: m.lv, pv: !!m.pv, zk: ws.zk, t: Date.now(), dd: !!m.dd, ac: !!m.ac };
    ws.info.lv = m.lv;
    return true;
  }
  if (t === 'pvp') {
    const T = room.clients.get(m.to); if (!T || !ws.st || !T.st) return false;
    if (!ws.st.pv || !T.st.pv || ws.zk !== T.zk || ws.st.ac || T.st.ac) return false;
    const lv = ws.st.lv || 1, cap = pvpAtkCap(lv), d = dist(ws.st, T.st);
    m.atk = num(m.atk, 0); m.pow = num(m.pow, 1);
    if (m.atk > cap * 1.6 || m.pow > 8 || d > 80) strike(ws, 'pvp');
    if (d > 32) return false;
    m.atk = Math.max(0, Math.min(cap, m.atk)); m.pow = Math.max(0, Math.min(6, m.pow)); m.kb = Math.min(4, Math.max(0, num(m.kb, 0)));
    ws.pvpN = (ws.pvpN || []).filter(t0 => Date.now() - t0 < 1000); if (ws.pvpN.length > 14) return false; ws.pvpN.push(Date.now());
    return true;
  }
  if (t === 'dmg') {
    const lv = (ws.st && ws.st.lv) || ws.info.lv || 1, cap = dmgCap(lv); m.d = num(m.d, 0);
    if (m.d > cap * 2) strike(ws, 'dmg');
    m.d = Math.max(0, Math.min(cap, m.d));
    ws.dmgN = (ws.dmgN || []).filter(t0 => Date.now() - t0 < 1000); if (ws.dmgN.length > 40) return false; ws.dmgN.push(Date.now());
    return true;
  }
  if (t === 'pvpk') return num(m.v, -1) === ws.pid; // tylko ofiara ogłasza swoją przegraną
  if (t === 'chat') {
    if (typeof m.msg !== 'string') return false; m.msg = m.msg.slice(0, 120);
    const now = Date.now(); ws.chatN = (ws.chatN || []).filter(t0 => now - t0 < 5000); if (ws.chatN.length >= 6) return false; ws.chatN.push(now); return true;
  }
  return true;
}
const RELAY = new Set(['st', 'look', 'chat', 'pvp', 'pvpk', 'pfx', 'sync', 'dmg', 'fst', 'fall', 'fsp', 'fs', 'fk', 'boss', 'hurt', 'fx', 'neoT']);
const AUTHONLY = new Set(['fall', 'fsp', 'fs', 'fk', 'boss', 'hurt', 'fx']);
const ZONED = new Set(['pfx', 'fst', 'fsp', 'fs', 'fk', 'boss', 'fx', 'fall']);

// ---------- połączenia ----------
const perIp = new Map();
wss.on('connection', (ws, req) => {
  ws.ip = String((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?');
  const n = (perIp.get(ws.ip) || 0) + 1; perIp.set(ws.ip, n);
  if (n > 8) { send(ws, { t: 'err', msg: 'Za dużo połączeń z jednego adresu.' }); ws.close(); }
  ws.alive = true; ws.on('pong', () => { ws.alive = true; });
  ws.rate = { tok: 160, last: Date.now(), drops: 0, dropT: Date.now() };
  ws.on('message', (data) => {
    if (!rateOk(ws)) return;
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const t = m.t;
    // ----- poza sesją -----
    if (t === 'list') return send(ws, { t: 'rooms', l: roomList() });
    if (t === 'create' || t === 'join' || t === 'knock') {
      if (num(m.v, 0) < PROTO) return send(ws, { t: 'err', code: 'ver', msg: 'Masz starą wersję gry. Odśwież stronę (Ctrl+F5).' });
      const info = safeClean(m); if (typeof m.did === 'string' && /^[a-z0-9]{6,24}$/i.test(m.did)) ws.did = m.did;
      if (t === 'create') {
        leave(ws, true); cancelKnock(ws, true);
        const code = makeCode();
        const room = { code, name: String(m.sname || ('Sesja ' + info.name)).replace(/[<>]/g, '').slice(0, 28), leader: 1, clients: new Map(), nextId: 1, zones: new Map(), bans: new Map(), knocks: new Map(), vis: m.vis !== false, open: !!m.open, created: Date.now() };
        rooms.set(code, room); log('room created', code, info.name);
        return joinRoom(ws, room, info);
      }
      const code = String(m.room || '').toUpperCase().trim(), room = rooms.get(code);
      if (!room) return send(ws, { t: 'err', code: 'room', msg: 'Nie ma sesji ' + code + ' (może już się skończyła).' });
      if (t === 'join' || room.open) return joinRoom(ws, room, info);
      // prośba do lidera
      if (ws.room === room) return;
      if (room.clients.size >= MAX_PLAYERS) return send(ws, { t: 'err', code: 'full', msg: 'Sesja jest pełna (max ' + MAX_PLAYERS + ').' });
      if (nickTaken(room, info.name, ws)) return send(ws, { t: 'err', code: 'nick', msg: 'Nick „' + info.name + '” jest już zajęty w tej sesji. Zmień nick.' });
      if (banned(room, ws, info.name)) return send(ws, { t: 'err', code: 'ban', msg: 'Nie możesz teraz wejść do tej sesji (blokada czasowa).' });
      if (Date.now() - (ws.knockT || 0) < 6000) return send(ws, { t: 'err', code: 'knock', msg: 'Poczekaj chwilę przed kolejną prośbą.' });
      cancelKnock(ws, true); ws.knockT = Date.now();
      const rid = ++KNOCKSEQ;
      const K = { ws, info, t: Date.now(), timer: setTimeout(() => {
        if (!room.knocks.has(rid)) return; room.knocks.delete(rid); if (ws.knock && ws.knock.rid === rid) ws.knock = null;
        send(ws, { t: 'err', code: 'knock', msg: 'Lider nie odpowiedział. Spróbuj jeszcze raz.' }); send(room.clients.get(room.leader), { t: 'knockx', rid });
      }, KNOCK_MS) };
      room.knocks.set(rid, K); ws.knock = { room: code, rid };
      send(room.clients.get(room.leader), { t: 'knock', rid, name: info.name, char: info.char, lv: info.lv, left: Math.round(KNOCK_MS / 1000) });
      return send(ws, { t: 'knock-wait', room: code, leader: (room.clients.get(room.leader) || { info: { name: '?' } }).info.name, sname: room.name });
    }
    if (t === 'knockc') { cancelKnock(ws); return send(ws, { t: 'knock-cancel' }); }
    if (t === 'leave') { leave(ws); return send(ws, { t: 'left' }); }
    const room = ws.room; if (!room) return;
    // ----- lider -----
    if (t === 'knockr') {
      if (room.leader !== ws.pid) return;
      const K = room.knocks.get(num(m.rid, -1)); if (!K) return;
      clearTimeout(K.timer); room.knocks.delete(num(m.rid, -1)); K.ws.knock = null;
      if (K.ws.readyState !== 1) return;
      if (m.ok) joinRoom(K.ws, room, K.info);
      else send(K.ws, { t: 'err', code: 'knock', msg: 'Lider odrzucił prośbę o dołączenie.' });
      return;
    }
    if (t === 'roomset') {
      if (room.leader !== ws.pid) return;
      if (typeof m.vis === 'boolean') room.vis = m.vis;
      if (typeof m.open === 'boolean') room.open = m.open;
      if (typeof m.sname === 'string' && m.sname.trim()) room.name = m.sname.replace(/[<>]/g, '').trim().slice(0, 28);
      return broadcast(room, { t: 'roomset', vis: room.vis, open: room.open, sname: room.name });
    }
    if (t === 'kick') {
      if (room.leader !== ws.pid) return;
      const T = room.clients.get(num(m.id, -1)); if (!T || T === ws) return;
      if (T.did) room.bans.set('d:' + T.did, Date.now() + KICK_BAN_MS); room.bans.set('n:' + T.info.name.toLowerCase(), Date.now() + KICK_BAN_MS);
      send(T, { t: 'kicked', msg: 'Lider wyrzucił Cię z sesji.' }); broadcast(room, { t: 'sys', msg: T.info.name + ' został(a) wyrzucony(a) przez lidera.' }, T.pid);
      return leave(T);
    }
    // ----- mapa -----
    if (t === 'zin') { const zk = String(m.z || '').slice(0, 48); if (!/^[a-z0-9_:-]+$/i.test(zk)) return; return zoneEnter(ws, zk); }
    // ----- zgłoszenie z anty-cheata w grze -----
    if (t === 'ac') { const r = 'c:' + String(m.r || '').replace(/[^a-z]/g, '').slice(0, 10); if (ACNAME[r]) strike(ws, r); return; }
    if (t === 'look') { const nm = ws.info.name, lv = ws.info.lv; ws.info = safeClean(m, ws.info); ws.info.name = nm; ws.info.lv = lv; m = { t: 'look', name: nm, char: ws.info.char, look: ws.info.look, eq: ws.info.eq, style: ws.info.style, gv: ws.info.gv, to: m.to }; }
    if (!RELAY.has(t)) return;
    if (t === 'st' && typeof m.z === 'string' && m.z !== ws.zk && /^[a-z0-9_:-]{1,48}$/i.test(m.z)) zoneEnter(ws, m.z); // gracz bez zgłoszonej mapy: przyjmij mapę z jego pozycji
    if (AUTHONLY.has(t)) { const Zs = ws.zk && room.zones.get(ws.zk); if (!Zs || Zs.a !== ws.pid) return; } // tylko gracz prowadzący mapę wysyła stan mobów
    if (!validate(ws, m)) return;
    m.from = ws.pid;
    const s = JSON.stringify(m);
    if (m.to != null) {
      const c = room.clients.get(m.to); if (!c || c === ws) return;
      if ((t === 'hurt' || t === 'dmg' || t === 'sync' || t === 'fall' || t === 'fst') && c.zk !== ws.zk) return;
      return send(c, s);
    }
    if (ZONED.has(t) || (t === 'st' && m.zs)) { for (const c of room.clients.values()) if (c !== ws && c.zk && c.zk === ws.zk) send(c, s); return; }
    broadcast(room, s, ws.pid);
  });
  const bye = () => { const n2 = (perIp.get(ws.ip) || 1) - 1; if (n2 <= 0) perIp.delete(ws.ip); else perIp.set(ws.ip, n2); cancelKnock(ws, true); leave(ws); };
  ws.on('close', bye);
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { try { ws.terminate(); } catch (e) {} continue; }
    ws.alive = false; try { ws.ping(); } catch (e) {}
  }
}, 25000);

server.listen(PORT, () => console.log('Serwer multiplayer v2 działa na porcie ' + PORT));
