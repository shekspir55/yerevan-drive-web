// Yerevan Drive web port: static server for web/ + minimal WebSocket relay for the multiplayer screen (no dependencies).
// usage: node server.js [port]   -> http://localhost:8099/ ; ws://localhost:8099/ws
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const PORT = +process.argv[2] || 8099, ROOT = path.join(__dirname, 'web');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css' };

const srv = http.createServer((req, res) => {
  if (req.url.split('?')[0] === '/sessions') {   // open sessions for the network screen list
    const list = listRooms();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(list));
  }
  if (req.url.split('?')[0] === '/playlist') {   // the original plays every MP3 in its \MP3\ folder: list them (paths inside the game folder)
    let list = []; try { const d = resolveCI(path.join(ROOT, 'game', 'MP3')); list = fs.readdirSync(d).filter(n => /\.mp3$/i.test(n)).sort().map(n => 'MP3/' + n); } catch (e) { }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }); return res.end(JSON.stringify(list));
  }
  try { serveStatic(req, res); } catch (e) { res.writeHead(400); res.end(); }   // a bad URL (e.g. '/%') must not kill the server
});
srv.on('clientError', (e, sock) => sock.destroy());

// The game data comes from a Windows install: names differ in case from what the code asks for (Menu/Menu.snd vs menu.snd),
// so a missing path is looked up again segment by segment, ignoring case.
function resolveCI(f) {
  if (fs.existsSync(f)) return f;
  let cur = ROOT;
  for (const seg of path.relative(ROOT, f).split(path.sep)) {
    let names; try { names = fs.readdirSync(cur); } catch (e) { return null; }
    const hit = names.find(n => n.toLowerCase() === seg.toLowerCase()); if (!hit) return null;
    cur = path.join(cur, hit);
  }
  return cur;
}
// gzip everything except already-compressed media; compressed copies are kept in memory (game data ~28 MB gzipped)
const NOZIP = new Set(['.mp3', '.png', '.jpg', '.ico']), gzCache = new Map();
function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  if (p.includes('\0')) { res.writeHead(400); return res.end(); }
  let f = path.join(ROOT, p); if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  f = resolveCI(f);
  const st = f && fs.statSync(f, { throwIfNoEntry: false });
  if (!st || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
  const ext = path.extname(f).toLowerCase(), etag = '"' + st.size.toString(36) + '-' + st.mtimeMs.toString(36) + '"';
  const head = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'ETag': etag, 'Vary': 'Accept-Encoding',
    'Cache-Control': p.startsWith('/game/') ? 'public, max-age=604800' : 'no-cache' };   // game data never changes; code is revalidated (ETag) after a deploy
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); return res.end(); }
  if (!NOZIP.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    let z = gzCache.get(f);
    if (!z || z.etag !== etag) { z = { etag, buf: zlib.gzipSync(fs.readFileSync(f), { level: 6 }) }; gzCache.set(f, z); }
    res.writeHead(200, { ...head, 'Content-Encoding': 'gzip', 'Content-Length': z.buf.length });
    return res.end(req.method === 'HEAD' ? undefined : z.buf);
  }
  res.writeHead(200, { ...head, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(f).on('error', () => res.destroy()).pipe(res);
}

// ---- WebSocket (RFC 6455, text frames only) ----
function frame(str) {
  const b = Buffer.from(str), n = b.length;
  const h = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : (() => { const x = Buffer.alloc(10); x[0] = 0x81; x[1] = 127; x.writeBigUInt64BE(BigInt(n), 2); return x; })();
  return Buffer.concat([h, b]);
}
// ---- rooms: any number of games at once; a room = one session (unique name) with its own players, track, clock ----
const clients = new Map(); let nextId = 1;
const rooms = new Map();               // lower-case session name -> room { session, maxPlayers, gameType, laps, track, password, created, startDelay, members:Set }
const MAX_ROOMS = 100, MAX_CLIENTS = 1000, MAX_FRAME = 64 * 1024, MAX_RATE = 150;   // MAX_RATE: messages per second per client (state 30 Hz + traffic 10 Hz + pings), the rest is dropped
const send = (c, o) => { try { c.sock.write(frame(JSON.stringify(o))); } catch (e) { } };
const others = c => c.room ? [...c.room.members].filter(x => x !== c) : [];
const freeSlot = (room, c) => { for (let i = 0; i < 8; i++) if (![...room.members].some(x => x !== c && x.slot === i)) return i; return 0; };
const listRooms = () => [...rooms.values()].filter(r => r.members.size).map(r => ({ name: r.session, players: r.members.size, max: r.maxPlayers, type: r.gameType, password: !!r.password }));
// ---- message checks: the relay forwards only well-formed messages with finite, bounded numbers (a NaN or 1e300 position would blow up every peer's physics) ----
const fin = (v, lim) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;
const nums = (a, min, max, lim) => Array.isArray(a) && a.length >= min && a.length <= max && a.every(v => fin(v, lim));
const okBody = q => nums(q, 22, 22, 1e4) && q.slice(3, 9).every(v => Math.abs(v) <= 1.5);   // net.js packBody: pos, up, fwd (unit), vel, ang. vel, flags, slots, steer, w_drive, steer input, throttle
const okTr = c => Array.isArray(c) && c.length <= 64 && c.every(e => nums(e, 9, 31, 1e7) && nums(e.slice(2, 5), 3, 3, 1e4) && (e.length < 31 || okBody(e.slice(9, 31))));
const plateOf = p => p && typeof p === 'object' ? { type: Math.max(0, Math.min(63, p.type | 0)), text: String(p.text || '').slice(0, 16) } : null;
const carOf = (s, d) => /^[\w .-]{1,32}$/.test(String(s)) ? String(s) : d, colOf = v => Math.max(0, Math.min(63, v | 0));
// Origin check: browsers always send Origin on a WebSocket; only the game's own pages may use the relay (production hosts, localhost, or the page's own host for LAN tests)
const ORIGINS = new Set(['yerevan.xn--99axc.xn--y9a3aq', 'xn--y9aha3e3bn.xn--99axc.xn--y9a3aq', 'localhost', '127.0.0.1', '[::1]', ...String(process.env.YD_ORIGINS || '').split(',').filter(Boolean)]);
function originOk(req) {
  const o = req.headers.origin; if (!o) return true;   // not a browser (no page to protect)
  let h; try { h = new URL(o).host; } catch (e) { return false; }
  return ORIGINS.has(h.replace(/:\d+$/, '')) || h === req.headers.host;
}
// host change (left, or the host's tab is hidden: a hidden tab gets no animation frames, so its traffic would stand still for everybody); everybody hears who the host is
function setHost(room, c) { room.host = c; for (const o of room.members) send(o, { t: 'host', id: c.id }); }
const resumes = new Map();   // token -> { id, info, slot, room, until }: a dropped player may come back with the same id for 60 s (net.js reconnect)

function onMsg(c, m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'hello' && !c.room) {
    let room;
    const back = m.resume ? resumes.get(String(m.resume)) : null;
    if (m.resume && (!back || back.until < Date.now() || rooms.get(back.room.session.toLowerCase()) !== back.room || clients.has(back.id))) return send(c, { t: 'error', code: 'noresume', msg: 'cannot resume' });
    if (back) {   // reconnect: same id, name, car and team as before
      room = back.room; resumes.delete(String(m.resume));
      if (room.members.size >= room.maxPlayers) return send(c, { t: 'error', code: 'full', msg: 'session full' });
      clients.delete(c.id); c.id = back.id; clients.set(c.id, c);
    } else if (m.create) {
      const name = String(m.create.session || 'Session').slice(0, 32), key = name.toLowerCase();
      if (rooms.has(key) && !rooms.get(key).members.size) rooms.delete(key);   // an emptied game kept for reconnects gives way to a new one
      if (rooms.has(key)) return send(c, { t: 'error', code: 'taken', msg: 'session name already taken' });
      if (rooms.size >= MAX_ROOMS) return send(c, { t: 'error', code: 'full', msg: 'server full' });
      room = { session: name, maxPlayers: Math.min(8, Math.max(2, +m.create.maxPlayers || 4)), gameType: +m.create.gameType || 0, laps: +m.create.laps || 2, track: Math.floor(Math.random() * 28), password: String(m.create.password || ''), created: Date.now(), host: c, started: false, goAt: 0, members: new Set() };   // the host starts the game with GO TO CITY (message 'start'); everybody then counts down together
      rooms.set(key, room);
    } else {
      const open = [...rooms.values()].filter(r => r.members.size);
      room = m.session ? rooms.get(String(m.session).toLowerCase()) : (open.length === 1 ? open[0] : null);
      if (room && !room.members.size) room = null;
      if (!room) return send(c, { t: 'error', code: 'nosession', msg: open.length ? 'no such session' : 'no session' });
      if (room.password && room.password !== String(m.password || '')) return send(c, { t: 'error', code: 'password', msg: 'wrong password' });
      if (room.members.size >= room.maxPlayers) return send(c, { t: 'error', code: 'full', msg: 'session full' });
    }
    c.room = room; room.members.add(c); if (!room.host || !room.members.has(room.host)) room.host = c;
    c.slot = back && ![...room.members].some(x => x !== c && x.slot === back.slot) ? back.slot : freeSlot(room, c);   // start grid slot inside this room (0..7), not the server-wide client id
    // Gogh & Milica: nobody picks a team; the host's GO TO CITY draws them (FUN_0042b4f0, see 'start'). Until then the team is unknown (null).
    // m.team ('g' robber / 'm' police, from ?team=) is only a TEST AID: that player keeps the asked team at the draw (DEVIATION, never sent by the normal UI)
    c.forceTeam = back ? back.forceTeam : (m.team === 'g' || m.team === 'm') ? m.team : null;
    c.info = back ? back.info : { id: c.id, name: String(m.name || 'Player').slice(0, 24), car: carOf(m.car, 'bmw'), col: colOf(m.col), plate: plateOf(m.plate), team: null, chosen: false };   // chosen = info +0 (CHOICE CAR done, message 2)
    const team = c.info.team;
    c.token = crypto.randomBytes(12).toString('hex');
    send(c, { t: 'welcome', id: c.id, team, slot: c.slot, host: room.host === c, token: c.token, resumed: !!back, room: { session: room.session, gameType: room.gameType, laps: room.laps, track: room.track, started: room.started, untilGo: room.started ? (room.goAt - Date.now()) / 1000 : null }, peers: others(c).map(x => x.info) });
    for (const o of others(c)) send(o, { t: 'join', peer: c.info });
  } else if (m.t === 'ping') {   // lag measurement: echoed to the sender (clients extrapolate remote cars by the one-way lag)
    send(c, { t: 'pong', c: +m.c || 0 });
  } else if (!c.room) {
    return;
  } else if (m.t === 's') {   // car state (p = old format, q = full body state, l = sender's half round trip); relayed when well formed
    if (!nums(m.p, 4, 12, 1e4) || (m.q !== undefined && !okBody(m.q))) return;
    for (const o of others(c)) send(o, { t: 's', id: c.id, p: m.p, q: m.q, l: fin(m.l, 5) ? m.l : 0 });
  } else if (m.t === 'car') {   // CHOICE CAR: the player picked a car/colour/plate (original FUN_00429420 -> network message)
    c.info.car = carOf(m.car, c.info.car); c.info.col = colOf(m.col); c.info.plate = plateOf(m.plate); c.info.auto = m.auto !== false; c.info.chosen = true;   // net2.c case 2: info +0 = 1
    for (const o of others(c)) send(o, { t: 'car', id: c.id, car: c.info.car, col: c.info.col, plate: c.info.plate });
  } else if (m.t === 'start') {   // GO TO CITY (host only): FUN_00426e80 -> start message 4 (FUN_0042b4f0); 3-2-1-Go after 6 s
    const room = c.room; if (room.host !== c || room.started) return;
    // only the players who pressed CHOICE CAR take part (records with info +0 != 0, yd.c 30560); the host's button is enabled only once 2 have (FUN_00426f00, yd.c 27381-27393)
    const inc = [...room.members].filter(x => x.info.chosen).sort((a, b) => a.slot - b.slot);
    if (inc.length < 2) return send(c, { t: 'nostart', need: 2, have: inc.length });
    room.started = true; room.goAt = Date.now() + 6000;
    const slots = {}; inc.forEach((x, i) => { x.slot = i; slots[x.id] = i; });   // record order +0x31 = start slot / spawn index
    let n = inc.length; for (const x of room.members) if (!inc.includes(x)) { x.slot = n++ & 7; x.info.team = null; x.info.siren = false; }   // left out of the start: no team (stays on GMCar; may drive in later like a late joiner)
    for (const r of resumes.values()) if (r.room === room) { r.info.team = null; r.info.siren = false; }   // dropped players waiting to reconnect were not in this draw either
    const o = { t: 'go', in: 6, slots };
    if (room.gameType === 2) {   // Gogh & Milica (original type 4): every included player police (record +0x78 = 1), then floor(n/2) distinct random ones robbers (yd.c 30595-30615)
      for (const x of inc) x.info.team = x.forceTeam || 'm';
      let g = inc.filter(x => x.info.team === 'g').length; const free = inc.filter(x => !x.forceTeam);
      while (g < inc.length >> 1 && free.length) { free.splice(Math.random() * free.length | 0, 1)[0].info.team = 'g'; g++; }
      o.teams = {}; for (const x of inc) { o.teams[x.id] = x.info.team; x.info.siren = x.info.team === 'm'; }   // police: siren / light bar on from the spawn (+0x6d = 1, FUN_00429b00 yd.c 29435)
      if (Array.isArray(m.sp) && m.sp.length <= 8 && m.sp.every(e => nums(e, 4, 4, 1e4))) o.sp = m.sp;   // the host's random block spawns (FUN_00414690), [x, y, z, yaw] per start slot
    }
    for (const x of room.members) send(x, Object.assign({}, o, { slot: x.slot, out: !inc.includes(x) }));
  } else if (m.t === 'restart' || m.t === 'pleaserestart') {   // RESTART GAME (GMMain 0x32, host only: message 5, everybody back to the car choice, then a new start); PLEASE RESTART GAME (0x33, the others: message 10 to the host)
    if (c.room.host !== c || m.t === 'pleaserestart') { if (c.room.host !== c) send(c.room.host, { t: 'pleaserestart', id: c.id, name: c.info.name }); return; }
    c.room.started = false; c.room.goAt = 0;
    for (const o of [...c.room.members, ...[...resumes.values()].filter(r => r.room === c.room)]) { o.info.chosen = false; o.info.team = null; o.info.siren = false; }   // (also players waiting to reconnect) message 5 (net2.c case 5: info +0 = 0): everybody chooses again, the next GO TO CITY draws new teams
    for (const o of c.room.members) send(o, { t: 'restart' });
  } else if (m.t === 'tr') {   // the host simulates the NPC traffic and relays it, so every player sees (and collides with) the same cars
    if (c.room.host !== c || !okTr(m.c)) return;
    for (const o of others(c)) send(o, { t: 'tr', c: m.c, l: fin(m.l, 5) ? m.l : 0 });
  } else if (m.t === 'bust') {   // Gogh & Milica: the host decides who is busted (FUN_00427fc0 on the host) and tells everybody
    if (c.room.host !== c || !Number.isInteger(m.id)) return;
    for (const o of others(c)) send(o, { t: 'bust', id: m.id });
  } else if (m.t === 'over') {   // game over from the host (message 0x12 -> FUN_00427bb0): w = 0 GWin / 1 MWin (Gogh & Milica), order = finish order of the race (player ids)
    if (c.room.host !== c) return;
    const o = { t: 'over' }; if (m.w === 0 || m.w === 1) o.w = m.w; if (Array.isArray(m.order) && m.order.length <= 8 && m.order.every(Number.isInteger)) o.order = m.order;
    for (const x of others(c)) send(x, o);
  } else if (m.t === 'fin') {   // race: this player's own car crossed the line after the last lap (race time on the shared clock); each player is authoritative for its own finish
    if (!fin(m.time, 1e5)) return;
    for (const o of others(c)) send(o, { t: 'fin', id: c.id, time: m.time });
  } else if (m.t === 'vis') {   // the player's tab was hidden / shown again: a hidden host hands the game (traffic, decisions) to a visible player
    c.hidden = !!m.hidden; const room = c.room, vis = [...room.members].find(x => !x.hidden);
    if (room.host.hidden && vis) setHost(room, vis);
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
  if (c.token && c.info) resumes.set(c.token, { id: c.id, info: c.info, slot: c.slot, forceTeam: c.forceTeam, room, until: Date.now() + 60000 });   // may come back with the same id (net.js reconnect)
  if (room.host === c && room.members.size) setHost(room, [...room.members].find(x => !x.hidden) || [...room.members][0]);   // the next (visible) player becomes the host
  if (!room.members.size) { room.host = null; room.emptyAt = Date.now(); }   // an empty game leaves the list at once and is deleted after 60 s (kept for a reconnect)
}
// heartbeat: a socket silent for 6 s gets a WebSocket ping (browsers answer it even in a hidden tab); silent for 20 s = dead (closed, the player leaves the room)
setInterval(() => {
  const now = Date.now();
  for (const c of clients.values()) { if (now - c.seen > 20000) c.sock.destroy(); else if (now - c.seen > 6000) { try { c.sock.write(Buffer.from([0x89, 0])); } catch (e) { } } }
  for (const [k, r] of rooms) if (!r.members.size && now - r.emptyAt > 60000) rooms.delete(k);
  for (const [k, r] of resumes) if (r.until < now) resumes.delete(k);
}, 3000).unref();
srv.on('upgrade', (req, sock) => {
  if (req.url !== '/ws' || !originOk(req) || !req.headers['sec-websocket-key']) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const key = req.headers['sec-websocket-key'];
  if (clients.size >= MAX_CLIENTS) return sock.destroy();
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { id: nextId++, sock, room: null, buf: Buffer.alloc(0), seen: Date.now(), rateT: 0, rateN: 0 }; clients.set(c.id, c);
  sock.on('data', d => {
    c.buf = Buffer.concat([c.buf, d]); c.seen = Date.now();
    if (c.buf.length > MAX_FRAME) return sock.destroy();   // no message is anywhere near this; protects the server's memory
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
      if (op === 1) {
        const s = c.seen / 1000 | 0; if (s !== c.rateT) { c.rateT = s; c.rateN = 0; } if (++c.rateN > MAX_RATE) continue;   // flood: drop the excess
        try { onMsg(c, JSON.parse(payload.toString())); } catch (e) { }
      }
    }
  });
  sock.on('close', () => drop(c)); sock.on('error', () => drop(c));
});
srv.listen(PORT, () => console.log('Yerevan Drive: http://localhost:' + PORT + '/  (multiplayer relay on /ws)'));
