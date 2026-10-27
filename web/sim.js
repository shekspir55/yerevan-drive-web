// Gameplay layer: car placement (slope tilt), AI drivers, races (.trc), road traffic, minimap, ambience.
// All positions are in the mirrored three.js space used by world.js (x' = -x, yaw' = -yaw).
(function (global) {
  'use strict';
  const TAU = Math.PI * 2;
  const wrap = a => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------- put a car's mesh on the ground (tilted to the 4 wheel contact heights) ----------
  function placeCar(e, dt, world) {
    const ph = e.phys, car = e.car, cy = Math.cos(ph.yaw), sy = Math.sin(ph.yaw);
    if (ph.basis) {   // physics body (OrigCarPhysics): the mesh takes its full 3D attitude (slopes, kerbs, tube walls and ceiling)
      const b = ph.basis, f = new THREE.Vector3(b.f[0], b.f[1], b.f[2]), u = new THREE.Vector3(b.u[0], b.u[1], b.u[2]), x = new THREE.Vector3().crossVectors(u, f).normalize();
      (placeCar._m = placeCar._m || new THREE.Matrix4()).makeBasis(x, u, f); car.obj.quaternion.setFromRotationMatrix(placeCar._m);
      const off = (ph._cgHeight ? ph._cgHeight() : 0.6) - car.radius - 0.02;
      car.obj.position.set(ph.pos.x - u.x * off, ph.pos.y - u.y * off, ph.pos.z - u.z * off);
      const rr = ph.speed * dt / car.radius; for (const w of car.wheels) { w.spin.rotation.x += rr; w.pivot.rotation.y = w.front ? -ph.steer : 0; }
      e.gy = ph.gy === undefined ? ph.pos.y - off : ph.gy; e.tp = e.tr = 0; return;   // gy = mean wheel contact height (shadow, tyre marks)
    }
    let sum = 0, n = 0, hF = 0, nF = 0, hR = 0, nR = 0, hP = 0, nP = 0, hN = 0, nN = 0;
    const ref = ph.gy === undefined ? 0 : ph.gy;
    for (const w of car.wheels) {
      const lx = -w.pos.x, lz = w.pos.z;
      const wx = ph.pos.x + lx * cy + lz * sy, wz = ph.pos.z - lx * sy + lz * cy;
      let h = world.ground ? world.ground(wx, wz, ref) : 0; if (h === null || h === undefined) h = ref;
      sum += h; n++;
      if (w.front) { hF += h; nF++; } else { hR += h; nR++; }
      if (lx > 0) { hP += h; nP++; } else { hN += h; nN++; }
    }
    const gy = sum / n; ph.gy = gy; e.gy = gy;
    const L = Math.abs(car.wheels[0].pos.z - car.wheels[2].pos.z) || 3, T = Math.abs(car.wheels[0].pos.x - car.wheels[1].pos.x) || 1.6;
    const tp = nF && nR ? -Math.atan2(hF / nF - hR / nR, L) : 0, tr = nP && nN ? Math.atan2(hP / nP - hN / nN, T) : 0;
    const LIM = 0.22, k = Math.min(1, dt * 10); // body tilt from the wheel contact heights, limited like a real suspension
    e.tp = (e.tp || 0) + (clamp(tp, -LIM, LIM) - (e.tp || 0)) * k; e.tr = (e.tr || 0) + (clamp(tr, -LIM, LIM) - (e.tr || 0)) * k;
    const o = car.obj; o.position.set(ph.pos.x, gy + car.radius + 0.02, ph.pos.z);
    o.rotation.set(0, 0, 0); o.rotateY(ph.yaw); o.rotateX(clamp(e.tp + ph.pitch, -0.35, 0.35)); o.rotateZ(clamp(e.tr + ph.roll, -0.35, 0.35));
    const roll = ph.speed * dt / car.radius;
    for (const w of car.wheels) { w.spin.rotation.x += roll; w.pivot.rotation.y = w.front ? -ph.steer : 0; }
  }


  // ---------- planar car shadow (FUN_00410940 region: car mesh projected onto the ground plane along the sun direction) ----------
  const SHADOW_ALPHA = 0.3, SHADOW_LIFT = 0.05;   // _DAT_0048461c = 0.3, _DAT_00484620 = 0.05
  const SHADOW_DEBUG = /[?&]shadowdebug/.test(location.search);
  const shadowMat = () => new THREE.MeshBasicMaterial({ color: SHADOW_DEBUG ? 0xff0000 : 0x000000, transparent: true, opacity: SHADOW_DEBUG ? 0.85 : SHADOW_ALPHA, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  function makeShadow(car, scene) {   // the original projects the car's 'bound' mesh (type+0x6e4) with the shadow material
    const mat = shadowMat(), src = [], group = new THREE.Group();
    const root = (car.parts && car.parts.bound) || car.obj;
    root.traverse(o => {
      if (!o.isMesh) return;
      const m = new THREE.Mesh(o.geometry, mat); m.matrixAutoUpdate = false; m.frustumCulled = false; m.renderOrder = 2;
      group.add(m); src.push([o, m]);
    });
    scene.add(group);
    return { group, src, mat };
  }
  const _S = new THREE.Matrix4();
  // light: unit direction the sunlight travels (three/mirrored space); planeY: ground height under the car
  function updateShadow(sh, carObj, light, planeY, visible) {
    sh.group.visible = visible && Math.abs(light.y) > 0.05;
    if (!sh.group.visible) return;
    const h = planeY + SHADOW_LIFT, dx = light.x / light.y, dz = light.z / light.y;
    _S.set(1, -dx, 0, dx * h,
           0, 0, 0, h,
           0, -dz, 1, dz * h,
           0, 0, 0, 1);
    carObj.updateMatrixWorld(true);
    for (const [o, m] of sh.src) { m.matrix.multiplyMatrices(_S, o.matrixWorld); m.matrixWorldNeedsUpdate = true; }
  }

  // brake lights (tormz: drawn only while braking) and reverse lights (zadni: only in reverse gear) – original draw code near yd.c:14009
  function updateLamps(car, braking, reverse) {
    if (car.parts.tormz) car.parts.tormz.visible = !!braking;
    if (car.parts.zadni) car.parts.zadni.visible = !!reverse;
  }

  // ---------- race route from a track's path list ----------
  function buildRoute(world, segs) {
    const xs = [], ys = [], zs = [];
    for (const [b, p] of segs) {
      const path = world.cit.blocks[b] && world.cit.blocks[b].paths[p]; if (!path) continue;
      const pts = path.pts;
      for (let i = 0; i < pts.length; i += 3) {
        const x = -pts[i], y = pts[i + 1], z = pts[i + 2], m = xs.length;
        if (m && Math.hypot(x - xs[m - 1], z - zs[m - 1]) < 0.5) continue;
        xs.push(x); ys.push(y); zs.push(z);
      }
    }
    const n = xs.length, d = new Float32Array(n + 1);
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; d[i + 1] = d[i] + Math.hypot(xs[j] - xs[i], zs[j] - zs[i]); }
    return { xs, ys, zs, n, d, len: d[n] };
  }
  function parseTrc(buf) {
    const dv = new DataView(buf); const startBlock = dv.getUint32(4, true), startPath = dv.getUint32(8, true);
    const grid = [];
    for (let i = 0; i < 8; i++) { const o = 12 + i * 64; const m = []; for (let k = 0; k < 16; k++) m.push(dv.getFloat32(o + k * 4, true)); grid.push({ pos: new THREE.Vector3(-m[12], m[13], m[14]), yaw: -Math.atan2(m[8], m[10]) }); }
    const nSeg = dv.getUint32(0x20c, true), segs = [];
    for (let i = 0; i < nSeg; i++) segs.push([dv.getUint32(0x210 + i * 8, true), dv.getUint32(0x214 + i * 8, true)]);
    return { startBlock, startPath, grid, segs };
  }
  function nearest(r, x, z, hint, win) {
    let best = -1, bd = 1e18; const n = r.n;
    const lo = hint < 0 ? 0 : -win, hi = hint < 0 ? n - 1 : win;
    for (let o = lo; o <= hi; o++) {
      const i = hint < 0 ? o : ((hint + o) % n + n) % n; const dx = r.xs[i] - x, dz = r.zs[i] - z, d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function ahead(r, i, dist) { let acc = 0, j = i, guard = 0; while (acc < dist && guard++ < r.n) { const k = (j + 1) % r.n; acc += Math.hypot(r.xs[k] - r.xs[j], r.zs[k] - r.zs[j]); j = k; } return j; }
  function heading(r, i) { const k = (i + 1) % r.n; return Math.atan2(r.xs[k] - r.xs[i], r.zs[k] - r.zs[i]); }

  // ---------- AI driver following the route ----------
  class AIDriver {
    constructor(route, skill) { this.r = route; this.skill = skill; this.idx = -1; this.stuck = 0; this.rev = 0; this.fails = 0; this.off = 0; this.vmax = 26 + skill * 22; }
    drive(e, dt) {
      const ph = e.phys, r = this.r;
      this.idx = nearest(r, ph.pos.x, ph.pos.z, this.idx, 70);
      const sp = Math.abs(ph.speed), La = 6 + sp * 0.5;
      const t = ahead(r, this.idx, La);
      const desired = Math.atan2(r.xs[t] - ph.pos.x, r.zs[t] - ph.pos.z);
      let steer = clamp(wrap(desired - ph.yaw) * 2.6, -1, 1);
      // corner speed: worst curvature over the next ~90 m (near part matters now, far part tells us to brake early)
      const hA = heading(r, ahead(r, this.idx, 6)), hB = heading(r, ahead(r, this.idx, 35)), hC = heading(r, ahead(r, this.idx, 85));
      const c1 = Math.abs(wrap(hB - hA)) / 29, c2 = Math.abs(wrap(hC - hB)) / 50;
      const vt = clamp(Math.min(this.vmax / (1 + c1 * 90), this.vmax / (1 + c2 * 90) + 6 + sp * 0.1), 8, this.vmax);
      let throttle = sp < vt ? clamp((vt - sp) * 0.5 + 0.35, 0, 1) : 0, brake = sp > vt + 1.5 ? clamp((sp - vt) / 8, 0, 1) : 0;
      // far from the route for long -> put it back
      const dr = Math.hypot(r.xs[this.idx] - ph.pos.x, r.zs[this.idx] - ph.pos.z);
      this.off = dr > 22 ? this.off + dt : 0;
      if (this.off > 5) { e.needRespawn = true; this.off = 0; }
      if (this.rev > 0) { this.rev -= dt; throttle = 0; brake = 1; steer = -steer; }
      else if (sp < 1.3 && throttle > 0.5) {
        this.stuck += dt;
        if (this.stuck > 1.4) { this.stuck = 0; this.fails++; if (this.fails >= 3) { e.needRespawn = true; this.fails = 0; } else this.rev = 1.2; }
      } else { this.stuck = 0; if (sp > 6) this.fails = 0; }
      return { throttle, brake, steer, handbrake: false, shiftUp: false, shiftDown: false };
    }
    respawn(e) {
      const r = this.r, i = ahead(r, this.idx < 0 ? 0 : this.idx, 14), ph = e.phys;
      ph.pos.set(r.xs[i], r.ys[i], r.zs[i]); ph.yaw = heading(r, i); ph.gy = r.ys[i]; ph.vel.set(0, 0, 0); ph.speed = 0; ph.yawRate = 0; ph.gear = 1; ph.steer = 0; ph._init = false;   // re-placed on the ground by the next step
      this.idx = i; this.stuck = 0; this.rev = 0; e.needRespawn = false;
    }
  }

  // ---------- race state ----------
  class Race {
    constructor(world, route, laps, entries, player) {
      this.world = world; this.route = route; this.laps = laps; this.entries = entries; this.player = player;
      this.state = 'countdown'; this.t = -5.0; this.finishedAt = null;   // original: timer starts at 5.0 s (game+0xafc), cars locked until it reaches 0
      for (const en of entries) { en.lap = -9; en.idx = -1; en.progress = 0; en.done = false; en.time = null; }
    }
    update(dt) {
      const r = this.route; this.t += dt;
      if (this.state === 'countdown' && this.t >= 0) this.state = 'go';
      for (const en of this.entries) {
        const ph = en.phys; const prev = en.idx;
        en.idx = nearest(r, ph.pos.x, ph.pos.z, prev, 60);
        if (en.lap === -9) en.lap = en.idx > r.n * 0.5 ? -1 : 0;
        else if (prev > r.n * 0.8 && en.idx < r.n * 0.2) en.lap++;
        else if (prev < r.n * 0.2 && en.idx > r.n * 0.8) en.lap--;
        en.progress = en.lap * r.len + r.d[en.idx];
        if (!en.done && !en.ext && this.state !== 'countdown' && en.lap >= this.laps) { en.done = true; en.time = this.t; }   // ext: network player, finished by its owner's 'fin' message
      }
      if (this.player.done && this.finishedAt === null) this.finishedAt = this.t;
    }
    standings() { return [...this.entries].sort((a, b) => (b.done - a.done) || (a.done && b.done ? a.time - b.time : b.progress - a.progress)); }
    place(en) { return this.standings().indexOf(en) + 1; }
  }

  // ---------- road traffic along the decoded path network ----------
  // Every traffic car is a full OrigCarPhysics body (mass, inertia and wheels from its template's avto.par) driven by the traffic controller FUN_0041b880
  // (drive(): digital flags like the keyboard), so a hit pushes and spins it and the controller steers it back. Network clients show the host's cars as
  // kinematic stand-ins (applyRemote / updateRemote; linear-only bodies for collideCars).
  class Traffic {
    constructor(world, scene, templates, max) {
      this.world = world; this.scene = scene; this.tpl = templates; this.max = max; this.cars = [];
      this.paths = world.pathLines;
    }
    // entries for TyreFx: simulated cars have real wheels (phys.wheels slip); kinematic ones only get slip when braking hard
    fxEnts() { return this.cars.map(c => { if (c.phys) { const f = c.fx || (c.fx = { id: 't' + c.id, car: c.car, phys: c.phys }); f.gy = c.gy; return f; } const f = c.fx || (c.fx = { id: 't' + c.id, car: c.car, phys: { wheels: [0, 1, 2, 3].map(() => ({ contact: true, slip: 0 })), speed: 0 } }); for (const w of f.phys.wheels) w.slip = c.slip || 0; f.phys.speed = Math.abs(c.speed); f.gy = c.obj.position.y - c.radius - 0.02; return f; }); }
    colliders() { return this.cars.map(c => c.phys || c); }   // bodies for collideBodies / crash sounds (noteHit writes hitJ on these)
    // one physics step of every simulated car inside stepWorld's sub-step loop (first = the frame's first step: a gear shift is an edge)
    // cars more than 60 m from every player / rival take one step per frame (the original's own rate: one physics step per frame up to 0.02 s), the near ones the sub-steps
    step(h, first) { const w = this.world; for (const c of this.cars) { const ph = c.phys; if (!ph || !c.inp || !(c.near || first)) continue; if (first && !this.remoteMode) { const fd = this.frameDt || h; c.stA = (c.stA || 0) + (c.inp.steer || 0) * fd; c.stT = (c.stT || 0) + fd; } const dt = c.near ? h : this.frameDt || h; ph.step(dt, first || !c.inp.shift ? c.inp : Object.assign({}, c.inp, { shift: 0 })); if (w.collide) w.collide(ph, dt); } }
    pathAt(b, p) { return this.paths.find(q => q.b === b && q.p === p); }
    linkTarget(b, v) { const lo = v & 0xffff, hi = v >>> 16; if (lo === 0) return [b, hi]; const nb = this.world.cit.blocks[b].dw[lo - 1]; return nb === undefined ? null : [nb, hi]; }
    cum(q) { if (!q.cum) { const n = q.pts.length / 3, c = new Float32Array(n); for (let i = 1; i < n; i++) c[i] = c[i - 1] + Math.hypot(q.pts[i * 3] - q.pts[i * 3 - 3], q.pts[i * 3 + 2] - q.pts[i * 3 - 1]); q.cum = c; } return q.cum; }
    sample(q, t, out) {
      const c = this.cum(q), n = c.length; let i = 1; while (i < n - 1 && c[i] < t) i++;
      const seg = (c[i] - c[i - 1]) || 1, f = clamp((t - c[i - 1]) / seg, 0, 1), a = (i - 1) * 3, b = i * 3, p = q.pts;
      out.x = p[a] + (p[b] - p[a]) * f; out.y = p[a + 1] + (p[b + 1] - p[a + 1]) * f; out.z = p[a + 2] + (p[b + 2] - p[a + 2]) * f;
      out.yaw = Math.atan2(p[b] - p[a], p[b + 2] - p[a + 2]);
    }
    // one traffic car from template ti (shared by the local spawner and the cars received from the host in network games)
    // dyn: simulated here (OrigCarPhysics + controller state), else a kinematic stand-in for a car the host simulates
    build(ti, id, x, y, z, yaw, dyn) {
      const tpl = this.tpl[ti], obj = tpl.obj.clone(true); this.scene.add(obj);
      const walk = path => { let n = obj; for (const i of path) n = n.children[i]; return n; };
      const wheels = (tpl.wheels || []).map(w => ({ front: w.front, pivot: walk(w.pivot), spin: walk(w.spin), pos: w.pos || new THREE.Vector3() })), parts = {};
      for (const k in tpl.parts || {}) parts[k] = walk(tpl.parts[k]);   // tormz / zadni (lamps), bound (shadow)
      const c = { id, ti, wheels, parts, car: { obj, wheels, radius: tpl.radius }, box: tpl.box, bnd: tpl.bnd, mass: tpl.par ? tpl.par.mass : 1300, boxLift: tpl.radius + 0.02, wheelBase: tpl.wheelBase || 2.6, steer: 0, waited: 0, speed: 0, braking: false, obj, pos: new THREE.Vector3(x, y, z), yaw, vel: new THREE.Vector3(), radius: tpl.radius };
      const O = global.YDPhysOrig;
      if (dyn && tpl.par && O) {
        const ph = c.phys = new O.OrigCarPhysics(tpl.par, tpl.radius, { groundFn: (gx, gz, gy) => this.world.ground(gx, gz, gy) });
        ph.pos.set(x, y, z); ph.yaw = yaw; ph.gy = y; ph.bnd = tpl.bnd; ph.box = tpl.box; ph.boxLift = c.boxLift; c.pos = ph.pos; c.vel = ph.vel;
        c.cruise = Math.random() * 12 + 10; c.n = 0; c.stuckT = 0; c.revT = -1; c.lowT = 0;   // +0x74 cruise speed rand01*12 + 10 m/s; +0xb4 frame counter; +0xc4 timer; +0xc8 reverse mode
      } else c.kin = true;   // the host's car (pos.y = its CG, as sent)
      return c;
    }
    // network games: the host simulates the traffic and sends it; the other players show the same cars (so nobody drives through a car only they cannot see)
    // entry: [id, ti, x, y, z, yaw, speed, steer, brake] (old clients read only these) + the full body state of the original's 0xf message (YDNet.packBody, 22 numbers)
    snapshot() { const N = global.YDNet; return this.cars.map(c => { const a = [c.id, c.ti, +c.pos.x.toFixed(2), +c.pos.y.toFixed(2), +c.pos.z.toFixed(2), +c.yaw.toFixed(3), +c.speed.toFixed(1), +c.steer.toFixed(2), c.braking ? 1 : 0]; if (N && c.phys) { a.push(...N.packBody(c.phys, c.inp && c.stT ? Object.assign({}, c.inp, { steer: c.stA / c.stT }) : c.inp || {})); c.stA = c.stT = 0; } return a; }); }   // steer input = mean since the last snapshot (the controller pulses left/right per frame)
    // host change (network): the simulated cars stay where they are (traffic handover). A new host gives each car the controller state of the path it is on
    // (cars with no path within 6 m along their heading are dropped), a former host keeps its cars as copies that the new host's snapshots correct (same ids).
    setRemote(on) {
      if (this.remoteMode === on) return; this.remoteMode = on;
      const keep = this.cars.filter(c => c.phys && c.phys._init && (on || this.adopt(c)));
      for (const c of this.cars) if (!keep.includes(c)) this.scene.remove(c.obj);
      this.cars.splice(0, this.cars.length, ...keep); this.rt = new Map(on ? keep.map(c => [c.id, c]) : []);
      if (!on) this.nextId = Math.max(this.nextId || 0, ...keep.map(c => c.id));
    }
    adopt(c) {
      const ph = c.phys, fx = Math.sin(ph.yaw), fz = Math.cos(ph.yaw); let best = 36, bq = null;
      for (const q of this.paths) {
        const p = q.pts, n = p.length / 3; if (q.length < 12 || ph.pos.x < q.x0 - 6 || ph.pos.x > q.x1 + 6 || ph.pos.z < q.z0 - 6 || ph.pos.z > q.z1 + 6) continue;
        for (let i = 0; i < n - 1; i++) {
          const ax = p[i * 3], az = p[i * 3 + 2], ex = p[i * 3 + 3] - ax, ez = p[i * 3 + 5] - az, l2 = ex * ex + ez * ez || 1e-9; if ((ex * fx + ez * fz) / Math.sqrt(l2) < 0.5) continue;
          const f = clamp(((ph.pos.x - ax) * ex + (ph.pos.z - az) * ez) / l2, 0, 1), dx = ax + ex * f - ph.pos.x, dz = az + ez * f - ph.pos.z, d = dx * dx + dz * dz; if (d < best) { best = d; bq = q; }
        }
      }
      if (!bq) return false;
      c.q = bq; c.t = this.project(bq, ph.pos.x, ph.pos.z, 0, 1e9); c.nq = undefined; c.cruise = Math.random() * 12 + 10; c.n = 0; c.stuckT = 0; c.revT = -1; c.lowT = 0; c.kin = false;
      return true;
    }
    // clients: the host's cars as OrigCarPhysics bodies (network controller FUN_0041cce0: snap + 10 % blend, simulated with the host's flags between snapshots,
    // colliding with everybody here); entries without the body state (old host) stay kinematic stand-ins. lag = one-way lag (s) for the extrapolation
    applyRemote(list, lag) {
      if (!this.rt) this.rt = new Map(); const seen = new Set(), N = global.YDNet;
      for (const e of list) {
        if (!Array.isArray(e)) continue; const [id, ti, x, y, z, yaw, speed, steer, brk] = e, q = N && e.length >= 31 ? e.slice(9, 31) : null;
        seen.add(id); let c = this.rt.get(id);
        if (c && !c.phys !== !q) { this.scene.remove(c.obj); this.cars.splice(this.cars.indexOf(c), 1); c = null; }   // the host changed (old <-> new format): rebuild as a simulated body / a stand-in
        if (!c) { if (!this.tpl[ti]) continue; c = this.build(ti, id, x, y, z, yaw, !!q); this.rt.set(id, c); this.cars.push(c); }
        if (c.phys && q) { const inp = N.applyBody(c.phys, q, lag); if (inp) { c.inp = inp; c.braking = !!brk; continue; } }
        c.tx = x; c.ty = y; c.tz = z; c.tyaw = yaw; c.braking = brk === undefined ? speed < c.speed - 0.05 || speed < 0.3 : !!brk; c.speed = speed; c.tsteer = steer;
      }
      for (const [id, c] of this.rt) if (!seen.has(id)) { this.scene.remove(c.obj); this.cars.splice(this.cars.indexOf(c), 1); this.rt.delete(id); }
    }
    updateRemote(dt) {
      const k = Math.min(1, dt * 10);
      for (const c of this.cars) {
        if (c.phys) { if (!c.phys._init) continue; const ph = c.phys; c.yaw = ph.yaw; c.speed = ph.speed; c.steer = ph.steer; placeCar(c, dt, this.world); continue; }   // simulated copy
        if (c.tx === undefined) continue;
        const ox = c.pos.x, oz = c.pos.z; const ex = c.tx + Math.sin(c.tyaw) * c.speed * 0.05, ez = c.tz + Math.cos(c.tyaw) * c.speed * 0.05;   // dead-reckon along the heading
        if (Math.hypot(ex - c.pos.x, ez - c.pos.z) > 20) { c.pos.set(ex, c.ty, ez); c.yaw = c.tyaw; } else { c.pos.x += (ex - c.pos.x) * k; c.pos.z += (ez - c.pos.z) * k; c.pos.y += (c.ty - c.pos.y) * k; let dy = c.tyaw - c.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); c.yaw += dy * k; }
        c.steer += (c.tsteer - c.steer) * k; c.vel.set((c.pos.x - ox) / Math.max(dt, 1e-4), 0, (c.pos.z - oz) / Math.max(dt, 1e-4));
        const rr = c.speed * dt / c.radius; for (const w of c.wheels) { w.spin.rotation.x += rr; w.pivot.rotation.y = w.front ? -c.steer : 0; }
        const gh = this.world.ground(c.pos.x, c.pos.z, c.pos.y + 0.5); c.obj.position.set(c.pos.x, (gh === null ? c.pos.y : gh) + c.radius + 0.02, c.pos.z); c.obj.rotation.set(0, c.yaw, 0);
      }
    }
    spawn(pp) {
      for (let tries = 0; tries < 40; tries++) {
        const q = this.paths[(Math.random() * this.paths.length) | 0]; if (q.length < 12) continue;
        const t = Math.random() * q.length, s = {}; this.sample(q, t, s);
        if (s.y < -2) continue;   // never underground (metro: only the player)
        const d = Math.hypot(s.x - pp.x, s.z - pp.z); if (d < 60 || d > 200) continue;   // keep traffic close: far cars cost draw calls and are tiny anyway
        if (this.cars.some(o => Math.hypot(o.pos.x - s.x, o.pos.z - s.z) < 9) || (this.others || []).some(o => Math.hypot(o.pos.x - s.x, o.pos.z - s.z) < 9)) continue;   // never spawn inside another car
        const ti = (Math.random() * this.tpl.length) | 0, c = this.build(ti, (this.nextId = (this.nextId || 0) + 1), s.x, s.y, s.z, s.yaw, true);
        c.q = q; c.t = t; c.nq = undefined;
        this.cars.push(c); return true;
      }
      return false;
    }
    // ---- path helpers (FUN_00421710 projection, FUN_00421870 point `dist` further along the path and into the chosen next link; reconstructed) ----
    nextPath(q) { const pa = this.world.cit.blocks[q.b].paths[q.p], nx = pa.next.length ? pa.next[(Math.random() * pa.next.length) | 0] : null, tg = nx === null ? null : this.linkTarget(q.b, nx); return (tg && this.pathAt(tg[0], tg[1])) || null; }
    project(q, x, z, t0, win) {   // arc length of the point of q closest to (x, z), searched within t0 +- win
      const c = this.cum(q), p = q.pts, n = c.length; let bt = t0, bd = 1e18;
      for (let i = 0; i < n - 1; i++) {
        if (c[i + 1] < t0 - win || c[i] > t0 + win) continue;
        const ax = p[i * 3], az = p[i * 3 + 2], ex = p[i * 3 + 3] - ax, ez = p[i * 3 + 5] - az, l2 = ex * ex + ez * ez || 1e-9, f = clamp(((x - ax) * ex + (z - az) * ez) / l2, 0, 1);
        const dx = ax + ex * f - x, dz = az + ez * f - z, d = dx * dx + dz * dz; if (d < bd) { bd = d; bt = c[i] + (c[i + 1] - c[i]) * f; }
      }
      return bt;
    }
    plen(q) { const c = this.cum(q); return c[c.length - 1]; }
    pointAhead(c, dist, out) { let q = c.q, t = c.t + dist; if (t > this.plen(q) && c.nq) { t -= this.plen(q); q = c.nq; } this.sample(q, Math.min(t, this.plen(q)), out); return out; }
    // every 15th frame: where the car is on its path, the 8 m / 40 m points (+0x84 / +0x78) and the car ahead (FUN_0041ae80); false = no path left
    track(c, all) {
      const ph = c.phys; c.t = this.project(c.q, ph.pos.x, ph.pos.z, c.t, 40);
      if (c.nq === undefined) c.nq = this.nextPath(c.q);
      if (c.t >= this.plen(c.q) - 0.3) {   // reached the end of the path: continue on the chosen link
        if (!c.nq) return false;
        c.q = c.nq; c.nq = this.nextPath(c.q); c.t = this.project(c.q, ph.pos.x, ph.pos.z, 0, 30);
      }
      c.t8 = this.pointAhead(c, 8, c.t8 || {}); c.t40 = this.pointAhead(c, 40, c.t40 || {});
      c.ahead = this.carAhead(ph, all);
      return true;
    }
    // FUN_0041ae80: the nearest body ahead along the horizontal heading within 20 m whose lateral (3D) offset is < 1.1*(maxX_A + maxX_B), closer than 10 m or
    // closing at > 0.1 m/s with < 5 s to impact (players, rivals and other traffic alike)
    carAhead(ph, all) {
      const fx = Math.sin(ph.yaw), fz = Math.cos(ph.yaw), mx = b => (b.bnd ? b.bnd.max[0] : 0.95) * 1.1; let best = 20, hit = null;
      for (const o of all) {
        if (o === ph) continue; const dx = o.pos.x - ph.pos.x, dy = (o.pos.y || 0) - ph.pos.y, dz = o.pos.z - ph.pos.z, t = dx * fx + dz * fz; if (t <= 0 || t >= best) continue;
        if (Math.hypot(dx - fx * t, dy, dz - fz * t) >= mx(o) + mx(ph)) continue;
        if (t >= 10) { const cl = (ph.vel.x - o.vel.x) * fx + (ph.vel.z - o.vel.z) * fz; if (!(cl > 0.1 && t / cl < 5)) continue; best = t; }   // as in the asm only far hits shorten the search
        hit = o;
      }
      return hit;
    }
    // traffic controller FUN_0041b880 (constants EXACT): once per frame before the physics steps, writes c.inp (digital flags for OrigCarPhysics direct mode).
    // others: the player, rivals and remote cars. Returns nothing; cars without a path left are removed.
    drive(dt, others) {
      this.frameDt = dt;
      if (this.remoteMode) { for (const c of this.cars) if (c.phys) c.near = (others || []).some(o => Math.abs(o.pos.x - c.pos.x) < 60 && Math.abs(o.pos.z - c.pos.z) < 60); return; }   // clients: the host's flags (applyRemote), only the step rate is chosen here
      const all = this.colliders().concat(others || []), mz = b => (b.bnd ? b.bnd.max[2] : 2.2); this.frameDt = dt;
      for (let i = this.cars.length - 1; i >= 0; i--) {
        const c = this.cars[i], ph = c.phys; if (!ph) continue;
        const inp = c.inp = { direct: true, throttle: 0, brake: 0, steer: 0, handbrake: false, shift: 0 };
        const sp = ph.vel.length(), fx = Math.sin(ph.yaw), fz = Math.cos(ph.yaw), rx = -fz, rz = fx;   // driver's right in the mirrored space
        const ang = (dx, dz) => Math.asin(clamp((dx * rx + dz * rz) / (Math.hypot(dx, dz) || 1), -1, 1));   // FUN_00472b90: > 0 = target on the right
        const steerTo = a => { const s = -ph.steer; if (a < -0.01 && a < s) inp.steer = 1; if (a > 0.01 && s < a) inp.steer = -1; };   // left FUN_004107d0 / right FUN_004107c0 against the D3D steer (+0x180)
        c.n++; c.near = (others || []).some(o => Math.abs(o.pos.x - ph.pos.x) < 60 && Math.abs(o.pos.z - ph.pos.z) < 60);
        if (c.revT >= 0) {   // stuck rule: slot 0 (reverse) with gas for 2.0 s, steering by the 40 m point seen from behind; then 1st gear (slot 2) again
          ph._idxCur = ph._idxTgt = 0; c.revT += dt;
          if (c.revT > 2) { ph._idxCur = ph._idxTgt = 2; c.revT = -1; c.lowT = 0; continue; }
          inp.throttle = 1; if (c.t40) { steerTo(ang(ph.pos.x - c.t40.x, ph.pos.z - c.t40.z)); c.t8 = Object.assign({}, c.t40); }
          c.braking = false; continue;
        }
        if (ph._idxTgt === 1) ph._idxTgt = 2; if (ph._idxCur === 1) ph._idxCur = 2;   // never neutral
        const P = ph.par, vref = P.maxRpm * 0.10471976 / ((P.ratios[ph._idxTgt] || 1e-6) * P.finalDrive) * P.rear.radius;   // own gearbox: up above 0.95, down below 0.35 of the gear's top speed
        if (ph._idxCur > 1) { if (sp > 0.95 * vref) inp.shift = 1; else if (ph._idxTgt > 2 && sp < 0.35 * vref) inp.shift = -1; }
        if (c.n % 15 === 1 && !this.track(c, all)) { this.scene.remove(c.obj); this.cars.splice(i, 1); continue; }
        steerTo(ang(c.t8.x - ph.pos.x, c.t8.z - ph.pos.z));
        let brake = false; const o = c.ahead;
        if (o) {   // brake when the car ahead is closer than 1.3*(maxZ_A + maxZ_B), or 1.7 times that while it is slower than us
          const d = Math.hypot(o.pos.x - ph.pos.x, (o.pos.y || 0) - ph.pos.y, o.pos.z - ph.pos.z), S = 1.3 * (mz(o) + mz(ph));
          if (d < S || (d < 1.7 * S && o.vel.length() < sp)) brake = true;
        }
        { const dx = c.t40.x - ph.pos.x, dz = c.t40.z - ph.pos.z; if (Math.acos(clamp((dx * fx + dz * fz) / (Math.hypot(dx, dz) || 1), -1, 1)) > 0.3926991 && sp > 7) brake = true; }   // sharp turn ahead (> 22.5 deg) above 7 m/s
        if (brake) inp.brake = 1; if (sp < c.cruise) inp.throttle = 1;   // gas only while below the cruise speed (and not braking: OrigCarPhysics gasFlag)
        c.braking = brake;
        if (sp < 1) { c.lowT += dt; if (c.lowT > 2.5) { c.revT = 0; c.lowT = 0; } } else c.lowT = 0;   // below 1 m/s for 2.5 s -> reverse mode
      }
    }
    // after the physics steps: spawning, removal, visuals (simulated cars) / the host's cars (network clients)
    update(dt, pp) {
      if (this.remoteMode) { this.updateRemote(dt); return; }
      const players = this.players && this.players.length ? this.players : [pp], above = players.filter(p => p.y > -2.5);
      if (this.cars.length < this.max && above.length && Math.random() < dt * 3) this.spawn(above[(Math.random() * above.length) | 0]);
      for (let i = this.cars.length - 1; i >= 0; i--) {
        const c = this.cars[i], ph = c.phys; if (!ph) continue;
        c.yaw = ph.yaw; c.speed = ph.speed; c.steer = ph.steer;
        const far = !players.some(p => Math.hypot(c.pos.x - p.x, c.pos.z - p.z) < 260), stuck = (c.waited = Math.abs(c.speed) < 0.3 ? c.waited + dt : 0) > 30 && !players.some(p => Math.hypot(c.pos.x - p.x, c.pos.z - p.z) < 50);
        if (far || stuck || !isFinite(c.pos.x + c.pos.z) || c.pos.y < -2 || players.some(p => p.y < -2.5 && Math.hypot(c.pos.x - p.x, c.pos.z - p.z) < 120)) { this.scene.remove(c.obj); this.cars.splice(i, 1); continue; }   // metro: no traffic; stuck > 30 s out of sight (not in the original: it keeps them until the block unloads)
        placeCar(c, dt, this.world);
      }
    }
  }

  // ---------- car vs car collisions ----------
  // FUN_004231c0 broad phase: a car's world AABB (8 box corners) grown by (0.3, 1.0, 0.3) against every other car's; each overlapping pair is resolved from
  // BOTH cars' updates (YDPhysOrig.collideCars(A, B) tests B's points in A's box, then (B, A)). Bodies: OrigCarPhysics or kinematic {pos, vel, yaw, mass, bnd}.
  function collideBodies(bodies, dt) {
    const PH = global.YDPhysOrig; if (!PH || !PH.collideCars) return;
    const bb = bodies.map(b => PH.carAABB(b));
    for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
      const A = bb[i], B = bb[j];
      if (A[0] - 0.3 > B[3] || A[3] + 0.3 < B[0] || A[1] - 1 > B[4] || A[4] + 1 < B[1] || A[2] - 0.3 > B[5] || A[5] + 0.3 < B[2]) continue;
      PH.collideCars(bodies[i], bodies[j], dt || 1 / 60); PH.collideCars(bodies[j], bodies[i], dt || 1 / 60);
    }
  }

  // ---------- minimap ----------
  // As the original: FUN_00428c80 builds the map once per game, FUN_00425530 draws it. (The 'map' material = map.dds is only looked up by
  // FUN_00418230 and never drawn; the road sketch is drawn with GDI from the path network.)
  // Build: 512x512 R5G6B5 surface, black; each path with flags == 0x20000000 as ONE straight line first->last point, pen 6 RGB(150,150,255);
  //   flags == 0x80000000 the same, pen 8 RGB(200,200,200) (0x40000000 paths are not drawn); race (route): pen 8 RGB(180,100,100) through the
  //   first points of route paths 1..n-1,0 (the 0->1 piece is missing in the original too); Ellipse +-6 px, pen 10 RGB(255,190,70), white
  //   default brush, around the last point of the track's start path. Texel = (x*0.19692+256, 256-z*0.19692), original x (port x = -x): 2600 m.
  // Draw: box sprite NDC (-1,-1) 0.4 x 0.533 colour 0x50000000; viewport 20% x 26.7% of the screen (205x205 at 1024x768); ortho window
  //   zoom x zoom map units (minimap+0x138: 0.4 at start, numpad + / - held: -/+1 per s, 0.11..1.2, FUN_00425ac0/FUN_00425a90), eye (x,z)/2600,
  //   up = car heading; the map is the unit quad +-0.5 (vertex buffer dev+0x2c68: uv = (X+0.5, 0.5-Y)), blend SRCCOLOR/INVSRCCOLOR (black = clear).
  //   Dots: material carPoint (point.dds, 8x8 disc), quad 0.07*zoom (14 px) at the player, then the other 7 racers / players (no traffic):
  //   paint colour (car+0x1e0); Gogh & Milica: robber (0,0.9,0), busted 0.5 grey, cop blue, siren on red while frac(time) > 0.5; a robber
  //   only sees cars within 150 m. Without the path flags or point.dds the older polyline map below (drawOld) is used.
  const mkCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
  class Minimap {
    constructor(canvas) { this.c = canvas; this.g = canvas.getContext('2d'); this.zoom = 0.4; canvas.width = 205; canvas.height = 205; this.tex = null; this.pt = null; this.tints = new Map(); }
    get R() { return this.zoom * 1300; }   // half the window in metres
    set R(v) { this.zoom = Math.max(0.11, Math.min(1.2, v / 1300)); }
    zoomBy(d) { this.zoom = Math.max(0.11, Math.min(1.2, this.zoom + d)); }
    build(world, trc, point) {   // FUN_00428c80 (trc = race track or null; point = decoded point.dds {width, height, data})
      const blocks = world && world.cit && world.cit.blocks; if (!blocks || !point || !blocks.some(b => b.paths.some(p => p.flags !== undefined))) return false;
      const S = 512 / 2600, c = mkCanvas(512, 512), g = c.getContext('2d'), X = x => Math.trunc(x * S + 256) + 0.5, Y = z => Math.trunc(256 - z * S) + 0.5;
      g.fillStyle = '#000'; g.fillRect(0, 0, 512, 512); g.lineCap = g.lineJoin = 'round';
      const pen = (w, col, flag) => { g.lineWidth = w; g.strokeStyle = col; g.beginPath(); for (const b of blocks) for (const p of b.paths) { if (p.flags !== flag || p.pts.length < 6) continue; const n = p.pts.length; g.moveTo(X(p.pts[0]), Y(p.pts[2])); g.lineTo(X(p.pts[n - 3]), Y(p.pts[n - 1])); } g.stroke(); };
      pen(6, 'rgb(150,150,255)', 0x20000000); pen(8, 'rgb(200,200,200)', 0x80000000);
      const path = bp => blocks[bp[0]] && blocks[bp[0]].paths[bp[1]];
      if (trc && trc.segs && trc.segs.length) {
        const n = trc.segs.length; g.lineWidth = 8; g.strokeStyle = 'rgb(180,100,100)'; g.beginPath(); let first = true;
        for (let i = 1; i <= n; i++) { const pa = path(trc.segs[i % n]); if (!pa) continue; const x = X(pa.pts[0]), y = Y(pa.pts[2]); if (first) g.moveTo(x, y); else g.lineTo(x, y); first = false; }
        g.stroke();
        const sp = path([trc.startBlock, trc.startPath]);
        if (sp) { const n3 = sp.pts.length, x = sp.pts[n3 - 3] * S + 256, y = 256 - sp.pts[n3 - 1] * S; g.beginPath(); g.ellipse(x, y, 6, 6, 0, 0, TAU); g.fillStyle = '#fff'; g.fill(); g.lineWidth = 10; g.strokeStyle = 'rgb(255,190,70)'; g.stroke(); }
      }
      // R5G6B5, then SRCCOLOR/INVSRCCOLOR (out = T*T + dst*(1-T) per channel) as one canvas alpha: a = max(T), colour T*T/a (exact on grey texels and on the strongest channel)
      const id = g.getImageData(0, 0, 512, 512), d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = (d[i] & 0xf8) | d[i] >> 5, gg = (d[i + 1] & 0xfc) | d[i + 1] >> 6, bb = (d[i + 2] & 0xf8) | d[i + 2] >> 5, a = Math.max(r, gg, bb);
        if (a < 1) { d[i + 3] = 0; continue; }
        d[i] = Math.min(255, r * r / a); d[i + 1] = Math.min(255, gg * gg / a); d[i + 2] = Math.min(255, bb * bb / a); d[i + 3] = a;
      }
      g.putImageData(id, 0, 0); this.tex = c;
      const pc = mkCanvas(point.width, point.height); pc.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(point.data), point.width, point.height), 0, 0); this.pt = pc;
      return true;
    }
    tinted(argb) {   // carPoint: emissive = the dot colour (FUN_004069c0), times the white disc texture
      let t = this.tints.get(argb); if (t) return t;
      t = mkCanvas(this.pt.width, this.pt.height); const g = t.getContext('2d'); g.drawImage(this.pt, 0, 0);
      g.globalCompositeOperation = 'multiply'; g.fillStyle = '#' + (argb & 0xffffff).toString(16).padStart(6, '0'); g.fillRect(0, 0, t.width, t.height);
      g.globalCompositeOperation = 'destination-in'; g.drawImage(this.pt, 0, 0); this.tints.set(argb, t); return t;
    }
    // o: { ents: [player, ...others] ({phys, car, team, busted}), color(e) -> ARGB paint, gm: Gogh & Milica, siren(e), t: seconds }
    draw(world, ph, race, ais, traffic, o) {
      if (!this.tex || !o) return this.drawOld(world, ph, race, ais, traffic);
      const g = this.g, W = this.c.width, S = 512 / 2600, k = W / (this.zoom * 512), cs = Math.cos(ph.yaw) * k, sn = Math.sin(ph.yaw) * k;
      const uc = 256 - ph.pos.x * S, vc = 256 - ph.pos.z * S, e0 = W / 2 - (cs * uc - sn * vc), f0 = W / 2 - (sn * uc + cs * vc);   // port x = -original x
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, W); g.fillStyle = 'rgba(0,0,0,0.3137)'; g.fillRect(0, 0, W, W);
      g.imageSmoothingEnabled = true; g.setTransform(cs, sn, -sn, cs, e0, f0); g.drawImage(this.tex, 0, 0); g.setTransform(1, 0, 0, 1, 0, 0);
      const me = o.ents[0], robberView = o.gm && me && me.team === 'g', sz = 0.07 * W;
      for (const e of o.ents) {
        if (!e || !e.phys) continue; const p = e.phys.pos;
        if (robberView && e !== me && Math.hypot(p.x - me.phys.pos.x, p.y - me.phys.pos.y, p.z - me.phys.pos.z) >= 150) continue;
        const col = !o.gm ? o.color(e) : e.team === 'g' ? (e.busted ? 0xff808080 : 0xff00e600) : (o.siren(e) && o.t - Math.floor(o.t) > 0.5 ? 0xffff0000 : 0xff0000ff);
        const u = 256 - p.x * S, v = 256 - p.z * S, x = cs * u - sn * v + e0, y = sn * u + cs * v + f0;
        if (x < -sz || y < -sz || x > W + sz || y > W + sz) continue;
        g.drawImage(this.tinted(col >>> 0), x - sz / 2, y - sz / 2, sz, sz);
      }
    }
    drawOld(world, ph, race, ais, traffic) {
      const g = this.g, W = this.c.width, H = this.c.height, cx = W / 2, cy = H / 2, sc = (W / 2) / this.R;
      const sy = Math.sin(ph.yaw), cyw = Math.cos(ph.yaw);
      const tx = (x, z) => { const dx = x - ph.pos.x, dz = z - ph.pos.z; return [cx + (dx * -cyw + dz * sy) * sc, cy - (dx * sy + dz * cyw) * sc]; };
      g.clearRect(0, 0, W, H); g.save(); g.beginPath(); g.rect(0, 0, W, H); g.clip();
      g.fillStyle = 'rgba(30,50,80,.40)'; g.fillRect(0, 0, W, H);   // real game: translucent bluish box, scene shows through
      g.strokeStyle = 'rgba(235,238,245,.85)'; g.lineWidth = 3; g.beginPath();
      for (const q of world.pathLines) {
        if (q.x1 < ph.pos.x - this.R || q.x0 > ph.pos.x + this.R || q.z1 < ph.pos.z - this.R || q.z0 > ph.pos.z + this.R) continue;
        for (let i = 0; i < q.pts.length; i += 3) { const [x, y] = tx(q.pts[i], q.pts[i + 2]); i ? g.lineTo(x, y) : g.moveTo(x, y); }
      }
      g.stroke();
      if (race) {
        const r = race.route; g.strokeStyle = '#c0554a'; g.lineWidth = 4; g.beginPath(); let started = false;
        for (let i = 0; i < r.n; i += 2) {
          if (Math.abs(r.xs[i] - ph.pos.x) > this.R * 1.2 || Math.abs(r.zs[i] - ph.pos.z) > this.R * 1.2) { started = false; continue; }
          const [x, y] = tx(r.xs[i], r.zs[i]); started ? g.lineTo(x, y) : g.moveTo(x, y); started = true;
        }
        g.stroke();
        const DOT = ['#d02828', '#2fb52f', '#2a3fd0', '#d0c828', '#c828c8', '#28c8c8', '#d07a28']; ais.forEach((e, i) => { const [x, y] = tx(e.phys.pos.x, e.phys.pos.z); g.fillStyle = DOT[i % 7]; g.beginPath(); g.arc(x, y, 3.8, 0, TAU); g.fill(); });
      }
      if (traffic) { g.fillStyle = 'rgba(120,200,255,.9)'; for (const c of traffic.cars) { const [x, y] = tx(c.pos.x, c.pos.z); g.fillRect(x - 1.5, y - 1.5, 3, 3); } }
      g.restore();
      g.fillStyle = '#ff9a3c'; g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, 6, 0, TAU); g.fill(); g.stroke();   // player: orange dot
    }
  }

  // ---------- positional ambience (Sound/ambient.snd) ----------
  // Ambient emitters (CIT types 7/10), as FUN_00420820 per emitter. SoundDef p[0] flags: bit31 loop, bit30 'name0..N-1.wav' variants, bit29 3D buffer;
  // p[1] buffers (voices) or variants, p[2]/p[3] min/max distance, p[4] repeat interval. Without bit29 a def only gets a 2D buffer that the emitter never
  // plays (the hay*/hayfm* radio loops are silent in the original too). Loops (fant1 fountain, getak1 water) play while the listener is within max;
  // one-shots (Ptica = Ptica0..9 birds) start a random free variant every 3 s + rand*interval unless the last one still plays. Gain = min(1, min/d)
  // (DirectSound3D rolloff 1), nothing beyond max. decode: WAV -> PCM (the archive has MS/IMA ADPCM); out: the Sound-volume node.
  class Ambience {
    constructor(ctx, world, vfs, decode, out) { this.ctx = ctx; this.world = world; this.vfs = vfs; this.decode = decode; this.out = out || ctx.destination; this.defs = new Map(); this.st = []; this.t = 0; this.ready = false; }
    async init() {
      const files = YD.readBFX(await this.vfs.bytes('Sound/ambient.snd'));
      for (const e of this.world.emitters) {
        if (this.defs.has(e.name)) continue; const d = { loop: (e.flags & 0x80000000) !== 0, bufs: [], end: [] }; this.defs.set(e.name, d);
        if (!(e.flags & 0x20000000)) continue;
        const vari = (e.flags & 0x40000000) !== 0, names = vari ? Array.from({ length: e.count }, (_, i) => e.name.replace(/\.wav$/, i + '.wav')) : [e.name];
        for (const n of names) { const b = files.get(n); if (!b) continue; try { const buf = await this.ctx.decodeAudioData(this.decode ? this.decode(b) : b.slice(0)); for (let k = 0; k < (vari ? 1 : e.count); k++) d.bufs.push(buf); } catch (er) { console.warn('ambient ' + n, er); } }
      }
      this.ready = true;
    }
    _play(d) {   // FUN_00408180(-1): a random buffer, the first free one if that is busy, none if all are busy
      const now = this.ctx.currentTime; let i = Math.floor(Math.random() * d.bufs.length); if (d.end[i] > now) { i = d.bufs.findIndex((b, k) => !(d.end[k] > now)); if (i < 0) return null; }
      const src = this.ctx.createBufferSource(), gn = this.ctx.createGain(); src.buffer = d.bufs[i]; src.loop = d.loop; gn.gain.value = 0; src.connect(gn).connect(this.out); src.start();
      d.end[i] = d.loop ? Infinity : now + src.buffer.duration; return { src, gn, d, i, until: d.end[i] };
    }
    _stop(s) { if (!s.h) return; try { s.h.src.stop(); } catch (e) { } if (s.h.d.end[s.h.i] === s.h.until) s.h.d.end[s.h.i] = 0; s.h = null; }   // a finished one-shot's buffer may already belong to another emitter
    update(dt, L) {
      if (!this.ready) return; const now = this.ctx.currentTime; this.t += dt;
      this.world.emitters.forEach((e, k) => {
        const d = this.defs.get(e.name); if (!d || !d.bufs.length) return;
        const s = this.st[k] || (this.st[k] = { h: null, next: 0 }), dist = Math.hypot(e.x - L.x, e.y - L.y, e.z - L.z);
        if (dist > e.max) { this._stop(s); return; }
        if (s.h && !d.loop && now >= s.h.until) s.h = null;
        if (d.loop) { if (!s.h) s.h = this._play(d); }
        else if (this.t >= s.next) { s.next = this.t + Math.random() * e.every + 3; if (!s.h) s.h = this._play(d); }
        if (s.h) s.h.gn.gain.value = Math.min(1, e.min / Math.max(dist, 1e-3));
      });
    }
    stop() { for (const s of this.st) if (s) this._stop(s); }
  }


  // ---- tyre smoke (tsmoke.tga sprites) and skid marks (sled.dds quads) from Graph/citstdmat.tex ----
  // Emitted per wheel while its slip ratio is high (physics wheels[i].slip, original threshold 0.2 for grip loss).
  class TyreFx {
    constructor(scene, smokeTex, sledTex) {
      this.scene = scene; this.t = 0;
      this.sprites = []; this.next = 0;
      const sm = smokeTex ? new THREE.SpriteMaterial({ map: smokeTex, transparent: true, depthWrite: false, color: 0xffffff }) : null;
      for (let i = 0; sm && i < 80; i++) { const sp = new THREE.Sprite(sm.clone()); sp.visible = false; sp.userData = { age: 9, life: 1 }; scene.add(sp); this.sprites.push(sp); }
      this.maxQuads = 400; this.q = 0;
      const g = new THREE.BufferGeometry();
      this.pos = new Float32Array(this.maxQuads * 12); this.uv = new Float32Array(this.maxQuads * 8); this.alpha = new Float32Array(this.maxQuads * 4);
      const idx = []; for (let i = 0; i < this.maxQuads; i++) idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
      g.setIndex(idx); g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2));
      g.setDrawRange(0, 0);
      this.skidMat = new THREE.MeshBasicMaterial({ map: sledTex || null, color: sledTex ? 0xffffff : 0x111111, transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
      this.skid = new THREE.Mesh(g, this.skidMat); this.skid.frustumCulled = false; this.skid.renderOrder = 1; scene.add(this.skid);
      this.last = new Map();
    }
    _puff(x, y, z, strength) {
      if (!this.sprites.length) return;
      const sp = this.sprites[this.next++ % this.sprites.length];
      sp.position.set(x + (Math.random() - 0.5) * 0.3, y + 0.15, z + (Math.random() - 0.5) * 0.3);
      sp.userData = { age: 0, life: 0.9 + Math.random() * 0.5, size: 0.7 + strength * 0.8, vy: 0.5 + Math.random() * 0.6 };
      sp.material.opacity = 0.0; sp.visible = true;
    }
    _mark(key, x, z, y, yaw) {
      const l = this.last.get(key);
      this.last.set(key, { x, z, y });
      if (!l || Math.hypot(x - l.x, z - l.z) > 3) return;     // a gap (new skid) -> no quad
      const dx = x - l.x, dz = z - l.z, len = Math.hypot(dx, dz); if (len < 0.15) { this.last.set(key, l); return; }
      const nx = -dz / len * 0.12, nz = dx / len * 0.12, i = (this.q++) % this.maxQuads, o = i * 12;
      const P = this.pos, yy = y + 0.03;
      P.set([l.x - nx, l.y + 0.03, l.z - nz, l.x + nx, l.y + 0.03, l.z + nz, x + nx, yy, z + nz, x - nx, yy, z - nz], o);
      this.uv.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
      const g = this.skid.geometry; g.attributes.position.needsUpdate = true; g.attributes.uv.needsUpdate = true; g.setDrawRange(0, Math.min(this.q, this.maxQuads) * 6);
    }
    // ents: [{phys, car, gy, id}]
    update(dt, ents, camPos) {
      for (const e of ents) {
        const ws = e.phys && e.phys.wheels; if (!ws || !e.car.wheels) continue;
        if (camPos && e.car.obj.position.distanceTo(camPos) > 120) continue;
        for (let i = 0; i < 4 && i < ws.length && i < e.car.wheels.length; i++) {
          const w = ws[i], key = (e.id || e.name || 'p') + i;
          if (w.contact && w.slip > 0.35 && Math.abs(e.phys.speed || 0) > 1.5 || (w.contact && w.slip > 0.6 && Math.abs(e.phys.speed || 0) > 0.5)) {
            const v = new THREE.Vector3(); e.car.wheels[i].pivot.getWorldPosition(v);
            const gy = e.gy !== undefined ? e.gy : v.y - (e.car.radius || 0.35);
            this._mark(key, v.x, v.z, gy);
            if (Math.random() < Math.min(1, dt * 25)) this._puff(v.x, gy, v.z, Math.min(1, w.slip));
          } else this.last.delete(key);
        }
      }
      for (const sp of this.sprites) {
        if (!sp.visible) continue; const u = sp.userData; u.age += dt;
        if (u.age >= u.life) { sp.visible = false; continue; }
        const f = u.age / u.life; sp.position.y += u.vy * dt; sp.scale.setScalar(u.size * (1 + f * 2.2));
        sp.material.opacity = Math.min(1, f * 8) * (1 - f) * 0.35;
      }
    }
  }

  // ---- collision sparks (FUN_0041a4f0 -> FUN_00419e50): a ring of 50 entries; each hit that plays a crash sound places 12 'boundparticle' (bparticle.tga)
  // quads at P + (0.5 - rand)*0.5 per axis that stay for 0.25 s (FUN_0041a150). The original stretches them with the camera speed (FUN_00419f60, not ported).
  class Sparks {
    constructor(scene, tex) {
      this.N = 50; this.age = new Float32Array(this.N); this.i = 0; const pos = this.pos = new Float32Array(this.N * 12 * 3).fill(-1e5), g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      this.pts = new THREE.Points(g, new THREE.PointsMaterial({ map: tex || null, color: tex ? 0xffffff : 0xffd070, size: 0.3, sizeAttenuation: true, transparent: true, depthWrite: false, alphaTest: 0.05 }));
      this.pts.frustumCulled = false; this.pts.renderOrder = 3; scene.add(this.pts);
    }
    add(P) { const k = this.i; this.i = (this.i + 1) % this.N; this.age[k] = 0.25; for (let j = 0; j < 12; j++) { const o = (k * 12 + j) * 3; this.pos[o] = P.x + (0.5 - Math.random()) * 0.5; this.pos[o + 1] = (P.y || 0) + (0.5 - Math.random()) * 0.5; this.pos[o + 2] = P.z + (0.5 - Math.random()) * 0.5; } this.pts.geometry.attributes.position.needsUpdate = true; }
    update(dt) { let ch = false; for (let k = 0; k < this.N; k++) if (this.age[k] > 0 && (this.age[k] -= dt) <= 0) { this.pos.fill(-1e5, k * 36, k * 36 + 36); ch = true; } if (ch) this.pts.geometry.attributes.position.needsUpdate = true; }
  }

  global.YDSim = { Sparks, TyreFx, updateLamps, makeShadow, updateShadow, placeCar, buildRoute, parseTrc, AIDriver, Race, Traffic, collideBodies, Minimap, Ambience, nearest, heading };
})(window);
