// Multiplayer client for the web port: WebSocket relay (server.js). Each client simulates its own car and broadcasts its state
// at 20 Hz; remote cars are interpolated, placed with sim.js placeCar (so wheels/tilt/shadows behave like AI cars).
(function (global) {
  'use strict';
  class YDNet {
    // hello: {name, car, col, plate, create?:{...}, password?}; hooks: onWelcome(room, peers), onJoin(peer), onLeave(id), onError(msg)
    constructor(hello, hooks) {
      this.hello = Object.assign({ t: 'hello' }, hello); this.hooks = hooks; this.id = 0; this.remote = new Map(); this.acc = 0;
      this.ready = new Promise((res, rej) => { this._res = res; this._rej = rej; });
      const ws = this.ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      ws.onopen = () => ws.send(JSON.stringify(this.hello));
      ws.onerror = () => this._rej(new Error('Server unreachable (start it with ./start.sh)'));
      ws.onclose = () => { this.closed = true; };
      ws.onmessage = e => {
        const m = JSON.parse(e.data);
        if (m.t === 'welcome') { this.id = m.id; this.isHost = !!m.host; this.goAt = m.room.started ? performance.now() + m.room.untilGo * 1000 : 0; this._res(m); }
        else if (m.t === 'go') { this.goAt = performance.now() + m.in * 1000; hooks.onGo && hooks.onGo(m); }
        else if (m.t === 'host') { this.isHost = true; hooks.onHost && hooks.onHost(); }
        else if (m.t === 'car') hooks.onCar && hooks.onCar(m);
        else if (m.t === 'chat') hooks.onChat && hooks.onChat(m);
        else if (m.t === 'tr') hooks.onTraffic && hooks.onTraffic(m);
        else if (m.t === 'siren') { const r = this.remote.get(m.id); if (r) r.siren = m.on; hooks.onSiren && hooks.onSiren(m); }
        else if (m.t === 'error') this._rej(new Error(m.msg));
        else if (m.t === 'join') hooks.onJoin && hooks.onJoin(m.peer);
        else if (m.t === 'leave') hooks.onLeave && hooks.onLeave(m.id);
        else if (m.t === 's') { const r = this.remote.get(m.id); if (r) { r.target = m.p; r.t = performance.now(); } }
      };
    }
    // seconds until the shared start (negative after it): server clock offset taken from the welcome message
    // Infinity while the host has not pressed GO TO CITY (lobby), then counts down to 0 and below
    countdown() { return this.goAt ? (this.goAt - performance.now()) / 1000 : Infinity; }
    sendCar(c) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'car', car: c.car, col: c.col, plate: c.plate, auto: c.auto })); }
    sendTraffic(list) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'tr', c: list })); }
    sendStart() { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'start' })); }
    sendChat(text) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'chat', text })); }
    sendSiren(on) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'siren', on: !!on })); }
    // call every frame: sends the local state at 20 Hz
    sendState(dt, ph) {
      this.acc += dt; if (this.acc < 0.05 || this.ws.readyState !== 1) return; this.acc = 0;
      this.ws.send(JSON.stringify({ t: 's', p: [ph.pos.x, ph.pos.y, ph.pos.z, ph.yaw, ph.steer, ph.speed, ph.pitch || 0, ph.roll || 0, ph.gear || 1].map(v => +v.toFixed(3)) }));
    }
    // smooth remote cars towards their last received state (dead-reckoned along the heading)
    updateRemote(dt) {
      for (const e of this.remote.values()) {
        const p = e.target, ph = e.phys; if (!p) continue;
        const lag = (performance.now() - e.t) / 1000, k = Math.min(1, dt * 12);
        const tx = p[0] + Math.sin(p[3]) * p[5] * lag, tz = p[2] + Math.cos(p[3]) * p[5] * lag;
        if (Math.hypot(tx - ph.pos.x, tz - ph.pos.z) > 25) { ph.pos.set(tx, p[1], tz); ph.yaw = p[3]; }
        ph.pos.x += (tx - ph.pos.x) * k; ph.pos.z += (tz - ph.pos.z) * k; ph.pos.y += (p[1] - ph.pos.y) * k;
        let dy = p[3] - ph.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); ph.yaw += dy * k;
        ph.steer += (p[4] - ph.steer) * k; ph.speed = p[5]; ph.vel.set(Math.sin(ph.yaw) * p[5], 0, Math.cos(ph.yaw) * p[5]); ph.pitch = p[6]; ph.roll = p[7]; ph.gear = p[8];
      }
    }
    close() { try { this.ws.close(); } catch (e) { } }
  }
  global.YDNet = YDNet;
})(window);
