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
    if (ph.tunnel && ph.basis) {   // underground: the body can be at any attitude (walls, ceiling) -> place it from the physics basis
      const b = ph.basis, f = new THREE.Vector3(b.f[0], b.f[1], b.f[2]), u = new THREE.Vector3(b.u[0], b.u[1], b.u[2]), x = new THREE.Vector3().crossVectors(u, f).normalize();
      (placeCar._m = placeCar._m || new THREE.Matrix4()).makeBasis(x, u, f); car.obj.quaternion.setFromRotationMatrix(placeCar._m);
      const off = (ph._cgHeight ? ph._cgHeight() : 0.6) - car.radius - 0.02;
      car.obj.position.set(ph.pos.x - u.x * off, ph.pos.y - u.y * off, ph.pos.z - u.z * off);
      const rr = ph.speed * dt / car.radius; for (const w of car.wheels) { w.spin.rotation.x += rr; w.pivot.rotation.y = w.front ? -ph.steer : 0; }
      e.gy = ph.gy = ph.pos.y - off; e.tp = e.tr = 0; return;
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
      ph.pos.set(r.xs[i], r.ys[i], r.zs[i]); ph.yaw = heading(r, i); ph.gy = r.ys[i]; ph.vel.set(0, 0, 0); ph.speed = 0; ph.yawRate = 0; ph.gear = 1; ph.steer = 0;
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
        if (!en.done && this.state !== 'countdown' && en.lap >= this.laps) { en.done = true; en.time = this.t; }
      }
      if (this.player.done && this.finishedAt === null) this.finishedAt = this.t;
    }
    standings() { return [...this.entries].sort((a, b) => (b.done - a.done) || (a.done && b.done ? a.time - b.time : b.progress - a.progress)); }
    place(en) { return this.standings().indexOf(en) + 1; }
  }

  // ---------- road traffic along the decoded path network ----------
  class Traffic {
    constructor(world, scene, templates, max) {
      this.world = world; this.scene = scene; this.tpl = templates; this.max = max; this.cars = [];
      this.paths = world.pathLines;
      this.bodies = [];
    }
    pathAt(b, p) { return this.paths.find(q => q.b === b && q.p === p); }
    linkTarget(b, v) { const lo = v & 0xffff, hi = v >>> 16; if (lo === 0) return [b, hi]; const nb = this.world.cit.blocks[b].dw[lo - 1]; return nb === undefined ? null : [nb, hi]; }
    cum(q) { if (!q.cum) { const n = q.pts.length / 3, c = new Float32Array(n); for (let i = 1; i < n; i++) c[i] = c[i - 1] + Math.hypot(q.pts[i * 3] - q.pts[i * 3 - 3], q.pts[i * 3 + 2] - q.pts[i * 3 - 1]); q.cum = c; } return q.cum; }
    sample(q, t, out) {
      const c = this.cum(q), n = c.length; let i = 1; while (i < n - 1 && c[i] < t) i++;
      const seg = (c[i] - c[i - 1]) || 1, f = clamp((t - c[i - 1]) / seg, 0, 1), a = (i - 1) * 3, b = i * 3, p = q.pts;
      out.x = p[a] + (p[b] - p[a]) * f; out.y = p[a + 1] + (p[b + 1] - p[a + 1]) * f; out.z = p[a + 2] + (p[b + 2] - p[a + 2]) * f;
      out.yaw = Math.atan2(p[b] - p[a], p[b + 2] - p[a + 2]);
    }
    spawn(pp) {
      for (let tries = 0; tries < 40; tries++) {
        const q = this.paths[(Math.random() * this.paths.length) | 0]; if (q.length < 12) continue;
        const t = Math.random() * q.length, s = {}; this.sample(q, t, s);
        if (s.y < -2) continue;   // never underground (metro: only the player)
        const d = Math.hypot(s.x - pp.x, s.z - pp.z); if (d < 60 || d > 200) continue;   // keep traffic close: far cars cost draw calls and are tiny anyway
        if (this.cars.some(o => Math.hypot(o.pos.x - s.x, o.pos.z - s.z) < 9)) continue;   // never spawn inside another car
        const tpl = this.tpl[(Math.random() * this.tpl.length) | 0]; const obj = tpl.obj.clone(true); this.scene.add(obj);
        const walk = path => { let n = obj; for (const i of path) n = n.children[i]; return n; };
        const wheels = (tpl.wheels || []).map(w => ({ front: w.front, pivot: walk(w.pivot), spin: walk(w.spin) }));
        const c = { id: (this.nextId = (this.nextId || 0) + 1), wheels, wheelBase: tpl.wheelBase || 2.6, steer: 0, waited: 0, q, t, speed: 7 + Math.random() * 7, obj, pos: new THREE.Vector3(s.x, s.y, s.z), yaw: s.yaw, vel: new THREE.Vector3(), stun: 0, radius: tpl.radius, kin: true };
        this.cars.push(c); return true;
      }
      return false;
    }
    update(dt, pp) {
      if (this.cars.length < this.max && pp.y > -2.5 && Math.random() < dt * 3) this.spawn(pp);
      for (let i = this.cars.length - 1; i >= 0; i--) {
        const c = this.cars[i]; c.stun = Math.max(0, c.stun - dt);
        if (c.pos.y < -2 || pp.y < -2.5 && Math.hypot(c.pos.x - pp.x, c.pos.z - pp.z) < 120) { this.scene.remove(c.obj); this.cars.splice(i, 1); continue; }   // metro: no traffic
        // car following: slow down (to a stop) for any car (traffic, rivals, the player) right in front on the same lane, so traffic cars never drive through each other
        if (c.cruise === undefined) c.cruise = c.speed;
        let lim = c.cruise; const sy = Math.sin(c.yaw), cyw = Math.cos(c.yaw);
        const look = (px, pz, vx, vz, prio) => {
          const dx = px - c.pos.x, dz = pz - c.pos.z, ahead = dx * sy + dz * cyw, lat = Math.abs(dx * cyw - dz * sy);
          if (ahead > 0 && ahead <= 26 && lat <= 2.7) { const along = Math.max(0, vx * sy + vz * cyw), gap = ahead - 5.0; lim = Math.min(lim, along + Math.max(0, gap) * 0.7); }
          // crossing / merging traffic: anybody close in front or beside that has priority (older car, rival, the player) -> wait; the older car keeps going, so no deadlock
          if (prio && ahead > -1.5 && Math.hypot(dx, dz) < 6.2 && lat < 3.2) lim = 0;
        };
        for (const o of this.cars) if (o !== c) look(o.pos.x, o.pos.z, o.vel.x, o.vel.z, o.id < c.id);
        if (this.others) for (const o of this.others) look(o.pos.x, o.pos.z, o.vel.x, o.vel.z, true);
        c.waited = lim < 0.3 ? c.waited + dt : 0; if (c.waited > 14) { this.scene.remove(c.obj); this.cars.splice(i, 1); continue; }   // stuck for a long time: remove
        c.speed += clamp(lim - c.speed, -14 * dt, 3 * dt);
        let sp = c.stun > 0 ? 0 : c.speed; c.t += sp * dt;
        if (c.t >= c.q.length) { // follow a random outgoing link
          const pa = this.world.cit.blocks[c.q.b].paths[c.q.p]; const nx = pa.next.length ? pa.next[(Math.random() * pa.next.length) | 0] : null;
          const tgt = nx === null ? null : this.linkTarget(c.q.b, nx); const nq = tgt && this.pathAt(tgt[0], tgt[1]);
          if (!nq) { this.scene.remove(c.obj); this.cars.splice(i, 1); continue; }
          c.q = nq; c.t = 0;
        }
        // bicycle model + pure pursuit: the car drives along its own heading and steers towards a point further along the path,
        // so turns are arcs (the body rotates, front wheels steer) instead of the car snapping to the polyline
        const s = {}; this.sample(c.q, c.t, s);
        const Ld = 4 + Math.abs(c.speed) * 0.35, tg = {}; this.sample(c.q, Math.min(c.q.length, c.t + Ld), tg);
        let al = Math.atan2(tg.x - c.pos.x, tg.z - c.pos.z) - c.yaw; al = Math.atan2(Math.sin(al), Math.cos(al));
        const spd = c.stun > 0 ? 0 : c.speed, want = c.stun > 0 ? 0 : clamp(Math.atan(2 * c.wheelBase * Math.sin(al) / Ld), -0.55, 0.55);
        c.steer += (want - c.steer) * Math.min(1, dt * 6);
        const yr = spd * Math.tan(c.steer) / c.wheelBase; c.yaw += yr * dt;
        const ox = c.pos.x, oz = c.pos.z; c.pos.x += Math.sin(c.yaw) * spd * dt; c.pos.z += Math.cos(c.yaw) * spd * dt;
        const ex = s.x - c.pos.x, ez = s.z - c.pos.z, ed = Math.hypot(ex, ez), k = Math.min(1, dt * 1.5);   // gentle pull back onto the lane
        if (ed > 0.01) { c.pos.x += ex * k; c.pos.z += ez * k; }
        if (ed > 6) c.t = Math.max(c.t - sp * dt, 0);   // fell behind the lane (sharp junction): let the path wait for the car
        if (c.pushX || c.pushZ) { c.pos.x += c.pushX * dt; c.pos.z += c.pushZ * dt; const dk = Math.exp(-1.6 * dt); c.pushX *= dk; c.pushZ *= dk; if (Math.hypot(c.pushX, c.pushZ) < 0.05) c.pushX = c.pushZ = 0; }   // shoved by a collision
        c.pos.y = s.y;
        c.vel.set((c.pos.x - ox) / Math.max(dt, 1e-4), 0, (c.pos.z - oz) / Math.max(dt, 1e-4)); if (c.stun > 0) c.vel.set(0, 0, 0);
        { const rr = (c.stun > 0 ? 0 : c.speed) * dt / c.radius; for (const w of c.wheels) { w.spin.rotation.x += rr; w.pivot.rotation.y = w.front ? -c.steer : 0; } }
        s.x = c.pos.x; s.z = c.pos.z; s.yaw = c.yaw;
        const gh = this.world.ground(s.x, s.z, s.y + 0.5); c.obj.position.set(s.x, (gh === null ? s.y : gh) + c.radius + 0.02, s.z);
        c.obj.rotation.set(0, s.yaw, 0);
        if (Math.hypot(s.x - pp.x, s.z - pp.z) > 260) { this.scene.remove(c.obj); this.cars.splice(i, 1); }
      }
    }
  }

  // ---------- car vs car collisions (2 circles each) ----------
  function collideBodies(bodies) {
    const R = 1.1, off = 1.3;
    for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j];
      if (Math.abs(a.pos.x - b.pos.x) > 8 || Math.abs(a.pos.z - b.pos.z) > 8) continue;
      if (a.kin && b.kin) continue;
      const fa = [Math.sin(a.yaw), Math.cos(a.yaw)], fb = [Math.sin(b.yaw), Math.cos(b.yaw)];
      for (const sa of [-off, off]) for (const sb of [-off, off]) {
        const ax = a.pos.x + fa[0] * sa, az = a.pos.z + fa[1] * sa, bx = b.pos.x + fb[0] * sb, bz = b.pos.z + fb[1] * sb;
        let dx = ax - bx, dz = az - bz; const d = Math.hypot(dx, dz); if (d >= 2 * R || d < 1e-5) continue;
        dx /= d; dz /= d; const pen = 2 * R - d;
        const PH = global.YDPhysOrig;
        if (a.kin || b.kin) {
          // traffic cars are dynamic bodies in the original: a hit pushes them with the momentum they receive (FUN_0041f900 impulse), they are not frozen
          const kin = a.kin ? a : b; kin.stun = 0.25;
          if (PH) {
            if (kin.mass === undefined) kin.mass = 1300;
            const vx = kin.vel.x, vz = kin.vel.z; PH.resolveCarCollision(a, b, dx, dz, pen, undefined, undefined, undefined, { dt: 0.008 }); kin.vel.x = vx; kin.vel.z = vz;
            const sg = a.kin ? 1 : -1, sx = dx * sg, sz = dz * sg, other = a.kin ? b : a, rel = Math.max(0, (other.vel.x - vx) * sx + (other.vel.z - vz) * sz);
            kin.pushX = (kin.pushX || 0) + sx * rel * 0.012; kin.pushZ = (kin.pushZ || 0) + sz * rel * 0.012;   // shoved away with the momentum it receives
            continue;
          }
          const dyn = a.kin ? b : a, sgn = a.kin ? -1 : 1;
          dyn.pos.x += dx * sgn * pen; dyn.pos.z += dz * sgn * pen;
          const vn = dyn.vel.x * dx * sgn + dyn.vel.z * dz * sgn; if (vn < 0) { dyn.vel.x -= 1.2 * vn * dx * sgn; dyn.vel.z -= 1.2 * vn * dz * sgn; }
        } else if (PH) {
          PH.resolveCarCollision(a, b, dx, dz, pen, undefined, undefined, undefined, { dt: 0.008 });
        } else {
          a.pos.x += dx * pen / 2; a.pos.z += dz * pen / 2; b.pos.x -= dx * pen / 2; b.pos.z -= dz * pen / 2;
          const vn = (a.vel.x - b.vel.x) * dx + (a.vel.z - b.vel.z) * dz;
          if (vn < 0) { const j2 = -1.25 * vn / 2; a.vel.x += j2 * dx; a.vel.z += j2 * dz; b.vel.x -= j2 * dx; b.vel.z -= j2 * dz; }
        }
      }
    }
  }

  // ---------- minimap ----------
  // Minimap (FUN_00425530): a square panel in the top-left corner, NDC (-1,-1) 0.4 x 0.533 = 205x205 px of a 1024x768 screen,
  // map rotating with the car (up = heading), car markers as dots.  (The original draws the 540x540 `map.dds` road sketch under
  // the markers; my road polylines come from the decoded path network so markers always line up with the roads.)
  class Minimap {
    constructor(canvas) { this.c = canvas; this.g = canvas.getContext('2d'); this.R = 210; canvas.width = 205; canvas.height = 205; }
    draw(world, ph, race, ais, traffic) {
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
  class Ambience {
    constructor(ctx, world, vfs) { this.ctx = ctx; this.world = world; this.vfs = vfs; this.bufs = new Map(); this.active = new Map(); this.timer = 0; this.ready = false; this.vol = 0.5; }
    async init() {
      const files = YD.readBFX(await this.vfs.bytes('Sound/ambient.snd'));
      for (const [name, data] of files) { try { this.bufs.set(name, await this.ctx.decodeAudioData(data.slice(0))); } catch (e) { /* skip undecodable */ } }
      this.ready = true;
    }
    update(dt, pp) {
      if (!this.ready) return; this.timer -= dt; if (this.timer > 0) return; this.timer = 0.25;
      const near = [];
      this.world.emitters.forEach((e, i) => { const d = Math.hypot(e.x - pp.x, e.z - pp.z); if (d < e.max && this.bufs.has(e.name)) near.push([d, i]); });
      near.sort((a, b) => a[0] - b[0]); const keep = new Set(near.slice(0, 5).map(n => n[1]));
      for (const [i, a] of this.active) if (!keep.has(i)) { try { a.src.stop(); } catch (e) { } this.active.delete(i); }
      for (const [d, i] of near.slice(0, 5)) {
        const e = this.world.emitters[i]; const g = this.vol * Math.pow(1 - clamp((d - e.min) / (e.max - e.min), 0, 1), 1.5);
        let a = this.active.get(i);
        if (!a) { const src = this.ctx.createBufferSource(); src.buffer = this.bufs.get(e.name); src.loop = true; const gn = this.ctx.createGain(); gn.gain.value = 0; src.connect(gn).connect(this.ctx.destination); src.start(0, Math.random() * src.buffer.duration); a = { src, gn }; this.active.set(i, a); }
        a.gn.gain.setTargetAtTime(g, this.ctx.currentTime, 0.2);
      }
    }
    stop() { for (const [, a] of this.active) { try { a.src.stop(); } catch (e) { } } this.active.clear(); }
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
        for (let i = 0; i < 4 && i < ws.length; i++) {
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

  global.YDSim = { TyreFx, updateLamps, makeShadow, updateShadow, placeCar, buildRoute, parseTrc, AIDriver, Race, Traffic, collideBodies, Minimap, Ambience, nearest, heading };
})(window);
