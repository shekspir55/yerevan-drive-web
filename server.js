// Yerevan Drive web port: static server for web/ + minimal WebSocket relay for the multiplayer screen (no dependencies).
// usage: node server.js [port]   -> http://localhost:8099/ ; ws://localhost:8099/ws
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = +process.argv[2] || 8099, ROOT = path.join(__dirname, 'web');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css' };

const srv = http.createServer((req, res) => {
  if (req.url.split('?')[0] === '/sessions') {   // open sessions for the network screen list
    const list = listRooms();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(list));
  }
  let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p); if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.stat(f, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size });
    fs.createReadStream(f).pipe(res);
  });
});

// ---- WebSocket (RFC 6455, text frames only) ----
function frame(str) {
  const b = Buffer.from(str), n = b.length;
  const h = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : (() => { const x = Buffer.alloc(10); x[0] = 0x81; x[1] = 127; x.writeBigUInt64BE(BigInt(n), 2); return x; })();
  return Buffer.concat([h, b]);
}
// ---- rooms: any number of games at once; a room = one session (unique name) with its own players, track, clock ----
const clients = new Map(); let nextId = 1;
const rooms = new Map();               // lower-case session name -> room { session, maxPlayers, gameType, laps, track, password, created, startDelay, members:Set }
const MAX_ROOMS = 100, MAX_CLIENTS = 1000;
const send = (c, o) => { try { c.sock.write(frame(JSON.stringify(o))); } catch (e) { } };
const others = c => c.room ? [...c.room.members].filter(x => x !== c) : [];
const listRooms = () => [...rooms.values()].map(r => ({ name: r.session, players: r.members.size, max: r.maxPlayers, type: r.gameType, password: !!r.password }));

function onMsg(c, m) {
  if (m.t === 'hello' && !c.room) {
    let room;
    if (m.create) {
      const name = String(m.create.session || 'Session').slice(0, 32), key = name.toLowerCase();
      if (rooms.has(key)) return send(c, { t: 'error', msg: 'session name already taken' });
      if (rooms.size >= MAX_ROOMS) return send(c, { t: 'error', msg: 'server full' });
      room = { session: name, maxPlayers: Math.min(8, Math.max(2, +m.create.maxPlayers || 4)), gameType: +m.create.gameType || 0, laps: +m.create.laps || 2, track: Math.floor(Math.random() * 28), password: String(m.create.password || ''), created: Date.now(), host: c, started: false, goAt: 0, members: new Set() };   // the host starts the game with GO TO CITY (message 'start'); everybody then counts down together
      rooms.set(key, room);
    } else {
      room = m.session ? rooms.get(String(m.session).toLowerCase()) : (rooms.size === 1 ? [...rooms.values()][0] : null);
      if (!room) return send(c, { t: 'error', msg: rooms.size ? 'no such session' : 'no session' });
      if (room.password && room.password !== String(m.password || '')) return send(c, { t: 'error', msg: 'wrong password' });
      if (room.members.size >= room.maxPlayers) return send(c, { t: 'error', msg: 'session full' });
    }
    c.room = room; room.members.add(c);
    // Gogh & Milica: the player may ask for a team ('g' = robber/Goxer, 'm' = police/Milicaner); default: the first player is a robber, the rest police
    const team = (m.team === 'g' || m.team === 'm') ? m.team : (others(c).some(x => x.info.team === 'g') ? 'm' : 'g');
    c.info = { id: c.id, name: String(m.name || 'Player').slice(0, 24), car: String(m.car || 'bmw'), col: +m.col || 0, plate: m.plate || null, team };
    send(c, { t: 'welcome', id: c.id, team, host: room.host === c, room: { session: room.session, gameType: room.gameType, laps: room.laps, track: room.track, started: room.started, untilGo: room.started ? (room.goAt - Date.now()) / 1000 : null }, peers: others(c).map(x => x.info) });
    for (const o of others(c)) send(o, { t: 'join', peer: c.info });
  } else if (!c.room) {
    return;
  } else if (m.t === 's') {
    for (const o of others(c)) send(o, { t: 's', id: c.id, p: m.p });
  } else if (m.t === 'car') {   // CHOICE CAR: the player picked a car/colour/plate (original FUN_00429420 -> network message)
    c.info.car = String(m.car || c.info.car); c.info.col = +m.col || 0; c.info.plate = m.plate || null; c.info.auto = m.auto !== false;
    for (const o of others(c)) send(o, { t: 'car', id: c.id, car: c.info.car, col: c.info.col, plate: c.info.plate });
  } else if (m.t === 'start') {   // GO TO CITY (host only): the game starts for everybody, 3-2-1-Go after 6 s
    if (c.room.host !== c || c.room.started) return;
    c.room.started = true; c.room.goAt = Date.now() + 6000;
    for (const o of c.room.members) send(o, { t: 'go', in: 6 });
  } else if (m.t === 'tr') {   // the host simulates the NPC traffic and relays it, so every player sees (and collides with) the same cars
    if (c.room.host !== c) return;
    for (const o of others(c)) send(o, { t: 'tr', c: m.c });
  } else if (m.t === 'siren') {
    c.info.siren = !!m.on;
    for (const o of others(c)) send(o, { t: 'siren', id: c.id, on: !!m.on });
  } else if (m.t === 'chat') {
    for (const o of others(c)) send(o, { t: 'chat', id: c.id, name: c.info.name, text: String(m.text || '').slice(0, 120) });
  }
}
function drop(c) {
  if (!clients.delete(c.id)) return;
  const room = c.room; if (!room) return;
  for (const o of others(c)) send(o, { t: 'leave', id: c.id });
  room.members.delete(c); c.room = null;
  if (room.host === c && room.members.size) { room.host = [...room.members][0]; send(room.host, { t: 'host' }); }   // the next player becomes the host
  if (!room.members.size) rooms.delete(room.session.toLowerCase());   // an empty game disappears from the list
}
srv.on('upgrade', (req, sock) => {
  if (req.url !== '/ws') return sock.destroy();
  const key = req.headers['sec-websocket-key'];
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n');
  if (clients.size >= MAX_CLIENTS) return sock.destroy();
  const c = { id: nextId++, sock, room: null, buf: Buffer.alloc(0) }; clients.set(c.id, c);
  sock.on('data', d => {
    c.buf = Buffer.concat([c.buf, d]);
    for (;;) {
      const b = c.buf; if (b.length < 2) return;
      const op = b[0] & 15; let len = b[1] & 127, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; } else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      const masked = b[1] & 128; if (masked) off += 4;
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= b[off - 4 + (i & 3)];
      c.buf = b.subarray(off + len);
      if (op === 8) { sock.end(); return; }
      if (op === 9) { sock.write(Buffer.from([0x8a, 0])); continue; }
      if (op === 1) { try { onMsg(c, JSON.parse(payload.toString())); } catch (e) { } }
    }
  });
  sock.on('close', () => drop(c)); sock.on('error', () => drop(c));
});
srv.listen(PORT, () => console.log('Yerevan Drive: http://localhost:' + PORT + '/  (multiplayer relay on /ws)'));
