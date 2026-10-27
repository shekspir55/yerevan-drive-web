// Multiplayer client for the web port: WebSocket relay (server.js). Each client simulates its own car and broadcasts its state at ~30 Hz.
// Network model of the original (spec-collision-camera.md B, type 1 FUN_00429540 / receiver FUN_0041cf90 + network controller FUN_0041cce0):
// a remote car is a full OrigCarPhysics body, simulated locally between packets with the sender's input flags; each packet snaps orientation, velocity,
// angular velocity, gear, steer and driveline speed, and moves the position 10 % towards the received one (snap if >= 5 m). DEVIATION for the internet
// (the original ran on a LAN): the received position is extrapolated by the measured one-way lag (half round trip of both peers to the relay, 'ping').
// Contacts need no message: every client resolves its own car against the remote copies (collideCars), each peer is authoritative for its own car.
// Old clients: 's' keeps the old p array (they ignore q); a packet without q (old sender) moves a never-simulated stand-in as before.
(function (global) {
  'use strict';
  const R3 = v => Math.round(v * 1e3) / 1e3, R4 = v => Math.round(v * 1e4) / 1e4;
  const nrm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }, crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  // body state as the original type-1 / 0xf packet, OrigCarPhysics D3D internals: [p(3), up(3), fwd(3), vel(3), body ang. vel(3), flags, slot cur, slot target, steer +0x180, w_drive +0x1b8, steer input, throttle]
  // flags: 1 gas, 2 brake, 4 left, 8 right, 16 handbrake, 32 horn (the resolved flags of +0x17c). inp = null: standing (lobby), handbrake only.
  function packBody(ph, inp, horn) {
    const ext = !ph._init || Math.abs(ph.yaw - ph._lastYaw) > 1e-5 || Math.hypot(ph.pos.x + ph._p[0], ph.pos.z - ph._p[2]) > 2;   // moved from outside since the last step (reset / grid slot): flat at the new yaw (not the wall push-out of world.collide, which moves pos by < 1.1 m without syncing _p when vn >= 0)
    const tele = !ph._init || Math.hypot(ph.pos.x + ph._p[0], ph.pos.z - ph._p[2]) > 4, py = tele && ph._groundAt ? ph._groundAt(-ph.pos.x, ph.pos.z, ph.pos.y + 1) + ph._cgHeight() : ph.pos.y;   // teleported: pos.y is the road, send the CG as _syncIn will put it
    const yd = -ph.yaw, u = ext ? [0, 1, 0] : ph._u, f = ext ? [Math.sin(yd), 0, Math.cos(yd)] : ph._f, w = ext ? [0, 0, 0] : ph._w, st = inp ? inp.steer || 0 : 0;
    const fl = inp ? (ph._gas ? 1 : 0) | (ph._brk ? 2 : 0) | (st > 0 ? 4 : st < 0 ? 8 : 0) | (ph._handbrake ? 16 : 0) : 16;
    return [R3(-ph.pos.x), R3(py), R3(ph.pos.z), R4(u[0]), R4(u[1]), R4(u[2]), R4(f[0]), R4(f[1]), R4(f[2]), R3(-ph.vel.x), R3(ph.vel.y), R3(ph.vel.z), R3(w[0]), R3(w[1]), R3(w[2]),
      fl | (horn ? 32 : 0), ph._idxCur, ph._idxTgt, R4(ph._steer || 0), R3(ph._driveOmega || 0), R3(st), R3(inp ? (ph._thr === undefined ? 1 : ph._thr) : 0)];
  }
  // apply a received body state (FUN_0041cce0): orientation, velocity, angular velocity, gear, steer, w_drive snapped; position + 10 % of the difference
  // to the received one extrapolated by lag seconds (snap if >= 5 m or first packet). Returns the direct input to simulate it with until the next packet, or null.
  function applyBody(ph, q, lag) {
    if (!ph || !ph._p || !Array.isArray(q) || q.length < 22 || !q.every(Number.isFinite)) return null;
    lag = Math.min(0.5, Math.max(0, lag || 0));
    const e = [q[0] + q[9] * lag, q[1] + q[10] * lag, q[2] + q[11] * lag], p = ph._p, snap = !ph._init || Math.hypot(e[0] - p[0], e[1] - p[1], e[2] - p[2]) >= 5;
    for (let i = 0; i < 3; i++) p[i] = snap ? e[i] : p[i] + (e[i] - p[i]) * 0.1;
    const f = nrm([q[6], q[7], q[8]]), r = nrm(crs([q[3], q[4], q[5]], f)); ph._f = f; ph._r = r; ph._u = crs(f, r);   // right = up x fwd (LH), re-orthonormalised
    ph._v = [q[9], q[10], q[11]]; ph._w = [q[12], q[13], q[14]];
    ph._idxCur = q[16] | 0; ph._idxTgt = q[17] | 0; if (ph._idxCur !== ph._idxTgt && !(ph._shiftT > 0)) ph._shiftT = 0.1;
    ph._steer = q[18]; ph._driveOmega = q[19];
    if (!ph._init) { ph._init = true; ph._first = true; }
    const fl = q[15] | 0, inp = { direct: true, throttle: fl & 1 ? 1 : 0, brake: fl & 2 ? 1 : 0, steer: q[20], handbrake: !!(fl & 16), shift: 0, thr: q[21], horn: !!(fl & 32) };
    ph._gas = !!(fl & 1); ph._brk = !!(fl & 2); ph._syncOut(0, inp);   // exposed pos / vel / yaw / speed / gear / pitch, roll; _lastYaw and _lastSpeedMag keep _syncIn from seeing a teleport
    return inp;
  }
  class YDNet {
    // hello: {name, car, col, plate, create?:{...}, password?}; hooks: onWelcome(room, peers), onJoin(peer), onLeave(id), onError(msg)
    constructor(hello, hooks) {
      this.hello = Object.assign({ t: 'hello' }, hello); this.hooks = hooks; this.id = 0; this.remote = new Map(); this.acc = 0; this.half = 0;   // half = smoothed half round trip to the relay (s)
      this.ready = new Promise((res, rej) => { this._res = res; this._rej = rej; });
      const fail = (msg, code) => this._rej(Object.assign(new Error(msg), { code }));
      this.connT = setTimeout(() => { if (!this.id) { fail('Server unreachable (no answer in 10 s)', 'server'); this.close(); } }, 10000);   // connect timeout
      this._vis = () => this.send({ t: 'vis', hidden: document.hidden }); document.addEventListener('visibilitychange', this._vis);   // a hidden host hands the game over (server.js 'vis')
      addEventListener('pagehide', () => { if (this.ws && this.ws.readyState < 2) this.ws.close(); });   // MAIN MENU / tab navigated away: leave at once (else the socket idles ~25 s until the heartbeat, slot taken, car standing); bfcache restore resumes with the token
      this._open(this.hello, fail);
    }
    // one WebSocket; after the first welcome a lost connection is retried with the server's token (same id, car and team) for about 55 s
    _open(hello, fail) {
      const hooks = this.hooks, ws = this.ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      const ping = () => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping', c: performance.now() })); };
      ws.onopen = () => { ws.send(JSON.stringify(hello)); ping(); clearInterval(this.pingT); this.pingT = setInterval(ping, 2000); if (document.hidden) this._vis(); };
      ws.onerror = () => { if (!this.id) fail('Server unreachable (start it with ./start.sh)', 'server'); };
      ws.onclose = () => {
        if (ws !== this.ws) return; clearInterval(this.pingT);
        if (!this.id || this.closing) { this.closed = true; fail('connection closed', 'server'); return; }
        if (!this.down) { this.down = performance.now(); this.tries = 0; hooks.onClose && hooks.onClose(); }   // [STRINGS] Server, then reconnect
        if (performance.now() - this.down > 55000 || !this.token) { this.closed = true; hooks.onGone && hooks.onGone(); return; }
        this.retryT = setTimeout(() => this._open({ t: 'hello', resume: this.token }, fail), Math.min(8000, 500 * 2 ** this.tries++));
      };
      ws.onmessage = e => {
        const m = JSON.parse(e.data);
        if (m.t === 'welcome' && this.id && m.resumed) { this.down = 0; this.token = m.token; this.slot = m.slot || 0; this.isHost = !!m.host; hooks.onRejoin && hooks.onRejoin(m); }   // reconnected: game.js syncs the peers / host role
        else if (m.t === 'welcome') { clearTimeout(this.connT); this.id = m.id; this.token = m.token; this.slot = m.slot || 0; this.isHost = !!m.host; this.goAt = m.room.started ? performance.now() + m.room.untilGo * 1000 : 0; this._res(m); }
        else if (m.t === 'go') { this.goAt = performance.now() + m.in * 1000; if (m.slot !== undefined) this.slot = m.slot; hooks.onGo && hooks.onGo(m); }
        else if (m.t === 'restart') { this.goAt = 0; hooks.onRestart && hooks.onRestart(m); }
        else if (m.t === 'pleaserestart') hooks.onPleaseRestart && hooks.onPleaseRestart(m);
        else if (m.t === 'host') { const was = this.isHost; this.isHost = m.id === undefined || m.id === this.id; if (this.isHost && !was) hooks.onHost && hooks.onHost(); else if (!this.isHost && was) hooks.onUnhost && hooks.onUnhost(); }   // host migration (left / tab hidden)
        else if (m.t === 'bust') hooks.onBust && hooks.onBust(m.id);
        else if (m.t === 'over') hooks.onOver && hooks.onOver(m);
        else if (m.t === 'fin') hooks.onFin && hooks.onFin(m);
        else if (m.t === 'error' && (m.code === 'noresume' || this.id)) {   // the reconnect was refused (expired / session full / gone)
          this.closed = this.closing = true; ws.close(); hooks.onGone && hooks.onGone(); }
        else if (m.t === 'car') hooks.onCar && hooks.onCar(m);
        else if (m.t === 'chat') hooks.onChat && hooks.onChat(m);
        else if (m.t === 'tr') hooks.onTraffic && hooks.onTraffic(m);
        else if (m.t === 'siren') { const r = this.remote.get(m.id); if (r) r.siren = m.on; hooks.onSiren && hooks.onSiren(m); }
        else if (m.t === 'error') fail(m.msg, m.code);
        else if (m.t === 'join') hooks.onJoin && hooks.onJoin(m.peer);
        else if (m.t === 'leave') hooks.onLeave && hooks.onLeave(m.id);
        else if (m.t === 's') { const r = this.remote.get(m.id); if (r) { r.target = m.p; r.t = performance.now(); if (Array.isArray(m.q)) { r.q = m.q; r.ql = +m.l || 0; } else if (r.inp) { r.q = r.inp = null; if (r.phys) r.phys._init = false; } } }   // stored, applied once by updateRemote (FUN_0041cf90 / FUN_0041cce0)
        else if (m.t === 'pong') { const rt = (performance.now() - m.c) / 1000, w = this.rts || (this.rts = []); if (rt >= 0 && rt < 5) { w.push(rt); if (w.length > 5) w.shift(); this.half = Math.min(...w) / 2; } }   // the smallest of the last 5 round trips (a page busy loading delays some answers)
      };
    }
    // seconds until the shared start (negative after it): server clock offset taken from the welcome message
    // Infinity while the host has not pressed GO TO CITY (lobby), then counts down to 0 and below
    countdown() { return this.goAt ? (this.goAt - performance.now()) / 1000 : Infinity; }
    sendCar(c) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'car', car: c.car, col: c.col, plate: c.plate, auto: c.auto })); }
    sendTraffic(list) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'tr', c: list, l: R3(this.half) })); }
    sendRestart() { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'restart' })); }
    sendStart() { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'start' })); }
    sendChat(text) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'chat', text })); }
    sendSiren(on) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'siren', on: !!on })); }
    send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }   // pleaserestart / bust / over / fin (server.js checks who may send what)
    // call every frame: sends the local state at ~30 Hz (the original: every frame; DEVIATION for the internet). inp = this frame's input (null: standing in the lobby), horn = H held
    sendState(dt, ph, inp, horn) {
      this.acc += dt; if (this.acc < 0.03 || this.ws.readyState !== 1) return; this.acc = 0;
      const m = { t: 's', p: [ph.pos.x, ph.pos.y, ph.pos.z, ph.yaw, ph.steer, ph.speed, ph.pitch || 0, ph.roll || 0, ph.gear || 1, ph.brake > 0 || ph.handbrake ? 1 : 0].map(v => +v.toFixed(3)) };   // [9] brake lamps (old clients read only p)
      if (ph._p) { m.q = packBody(ph, inp === undefined ? {} : inp, horn); m.l = R3(this.half); }
      this.ws.send(JSON.stringify(m));
    }
    // once per frame after the physics: apply the newest packet of every remote car (full state: snap + 10 % blend, then simulated with its inputs in
    // game.js stepWorld); cars from old clients (no q) are stand-ins smoothed towards their last state (dead-reckoned along the heading)
    updateRemote(dt) {
      const now = performance.now();
      for (const e of this.remote.values()) {
        const p = e.target, ph = e.phys; if (!p) continue;
        if (e.q) { const q = e.q; e.q = null; const inp = applyBody(ph, q, e.ql + this.half + (now - e.t) / 1000); if (inp) { e.inp = inp; e.live = true; ph.braking = !!(q[15] & 18); ph.handbrake = inp.handbrake; continue; } }
        if (e.inp && ph._init) continue;   // simulated: stepped between packets
        e.live = true;
        const lag = (performance.now() - e.t) / 1000, k = Math.min(1, dt * 12);
        const tx = p[0] + Math.sin(p[3]) * p[5] * lag, tz = p[2] + Math.cos(p[3]) * p[5] * lag;
        if (Math.hypot(tx - ph.pos.x, tz - ph.pos.z) > 25) { ph.pos.set(tx, p[1], tz); ph.yaw = p[3]; }
        ph.pos.x += (tx - ph.pos.x) * k; ph.pos.z += (tz - ph.pos.z) * k; ph.pos.y += (p[1] - ph.pos.y) * k;
        let dy = p[3] - ph.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); ph.yaw += dy * k;
        ph.steer += (p[4] - ph.steer) * k; ph.speed = p[5]; ph.vel.set(Math.sin(ph.yaw) * p[5], 0, Math.cos(ph.yaw) * p[5]); ph.pitch = p[6]; ph.roll = p[7]; ph.gear = p[8]; ph.braking = p[9] === undefined ? undefined : !!p[9];
      }
    }
    close() { this.closing = true; clearTimeout(this.retryT); clearTimeout(this.connT); clearInterval(this.pingT); document.removeEventListener('visibilitychange', this._vis); try { this.ws.close(); } catch (e) { } }
  }
  YDNet.packBody = packBody; YDNet.applyBody = applyBody;   // also used for the host's traffic (sim.js Traffic.snapshot / applyRemote)
  global.YDNet = YDNet;
})(window);
