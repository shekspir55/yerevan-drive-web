// Car loading + parameters + driving model for Yerevan Drive (web port).
(function (global) {
  'use strict';

  // Offsets inside avto.par ('CAR!' + 0x1c8 bytes). Meanings inferred by comparing cars
  // (BMW 760Li / Vaz 2108 / Gazel / Kamaz) and checking against real-world values.
  function readPar(buf) {
    const dv = new DataView(buf), f = o => dv.getFloat32(o, true), u = o => dv.getUint32(o, true);
    if (u(0) !== 0x21524143) throw new Error('not CAR!');
    let name = ''; for (let i = 4; i < 0x20 && dv.getUint8(i); i++) name += String.fromCharCode(dv.getUint8(i));
    const torque = []; for (let o = 0x108; o <= 0x140; o += 4) torque.push(f(o));
    const gears = []; const ng = u(0x178);
    for (let i = 0; i < ng; i++) gears.push(f(0x184 + 4 * i));
    return {
      name, mass: f(0x8c), inertia: [f(0x90), f(0x94), f(0x98)],
      frontAxle: f(0x9c), frontTrack: f(0xa0), rearAxle: f(0xc4), rearTrack: f(0xc8),
      springF: f(0xac), damperF: f(0xb0), springR: f(0xd4), damperR: f(0xd8),
      idleRpm: f(0xf0), maxRpm: f(0xf4), shiftRpm: f(0xf8),
      torque, torqueStep: 500, gears, reverse: f(0x17c), finalDrive: f(0x1a4), wheelDia: f(0x1a8),
      brake: f(0x1b0),
    };
  }

  const hasTexMat = (descs, i) => !!(descs[i] && descs[i].tex);

  const texCache = new Map();
  function texSet(vfs, path) { if (!texCache.has(path)) texCache.set(path, YD.TexSet.load(vfs, path)); return texCache.get(path); }

  async function loadCar(vfs, folder, colorIdx, carcol) {
    const base = 'Cars/' + folder + '/';
    const parBuf = await vfs.bytes(base + 'avto.par');
    const par = readPar(parBuf);
    const parOrig = global.YDPhysOrig ? global.YDPhysOrig.readPar(parBuf) : null;
    const ref = YD.parseRef(await vfs.bytes(base + 'avto.ref'));
    const ts = [await texSet(vfs, base + 'avto.tex'), await texSet(vfs, 'Cars/carmat.tex')];
    const built = await YD.buildRef(ref, ts);
    const parts = built.parts;
    const body = parts.kuzov;
    if (parts.bound) parts.bound.visible = false;

    // paint: exact rule from the binary (render-orig.js): materials whose raw data has a non-zero byte at 0x54
    if (carcol && carcol[colorIdx]) {
      if (global.YDRender) {
        const idx = await global.YDRender.paintMaterialIndices(vfs, folder);
        global.YDRender.applyCarPaint(built.materials, idx, carcol[colorIdx]);
        for (const i of idx) if (built.materials[i]) built.materials[i].userData.paint = true;
      } else if (body) { // fallback heuristic: largest untextured body material
        const tris = new Map();
        body.traverse(o => { if (!o.isMesh) return; o.geometry.groups.forEach(g => { const m = o.material[g.materialIndex]; tris.set(m, (tris.get(m) || 0) + g.count / 3); }); });
        let best = null, bn = 0; for (const [m, n] of tris) { if (!m.map && m.opacity === 1 && n > bn) { best = m; bn = n; } }
        if (best) { best.color = new THREE.Color(carcol[colorIdx][0], carcol[colorIdx][1], carcol[colorIdx][2]); best.userData.paint = true; }
      }
    }

    // wheels: wheel meshes sit at the origin; place them using the axle values from the par file
    const car = new THREE.Group();
    car.add(built.group);
    const wheels = [];
    const rmesh = parts.tire_r, lmesh = parts.tire_l;
    let radius = 0.37;
    // the wheel meshes sit at the origin, so the lowest point of the tyre geometry is -radius (measured on the real mesh: G500 0.52 m, not a fixed 0.37 m)
    if (rmesh) { let lo = 0; rmesh.traverse(o => { if (o.isMesh && o.geometry) { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); lo = Math.min(lo, o.geometry.boundingBox.min.y); } }); if (lo < -0.15 && lo > -1.2) radius = -lo; }
    const spots = [
      { x: -par.frontTrack / 2, z: par.frontAxle, front: true, left: true },
      { x: par.frontTrack / 2, z: par.frontAxle, front: true, left: false },
      { x: -par.rearTrack / 2, z: -par.rearAxle, front: false, left: true },
      { x: par.rearTrack / 2, z: -par.rearAxle, front: false, left: false },
    ];
    for (const s of spots) {
      const src = s.left ? lmesh : rmesh;
      const pivot = new THREE.Group(), spin = new THREE.Group();
      if (src) {
        // clone geometry reference (shared) – each wheel has its own transform
        const clone = src.clone(true); clone.matrixAutoUpdate = true; clone.matrix.identity(); clone.visible = true;
        spin.add(clone);
      }
      pivot.add(spin);
      // wheels live in D3D space (inside built.inner, which is mirrored into three.js space)
      pivot.position.set(s.x, 0, s.z);
      built.inner.add(pivot);
      wheels.push({ pivot, spin, front: s.front, left: s.left, pos: new THREE.Vector3(s.x, 0, s.z) });
    }
    if (parts.tire_r) parts.tire_r.visible = false;
    if (parts.tire_l) parts.tire_l.visible = false;

    // mesh data bounds -> ground offset (lowest body point relative to wheel centre)
    // the original draws the glass (lusamut) solid black in the real game and in the menu preview (verified on an in-game capture)
    if (parts.lusamut) parts.lusamut.traverse(o => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach(mt => { if (mt && mt.transparent) { mt.transparent = false; mt.opacity = 1; mt.color.set(0x000000); if (mt.emissive) mt.emissive.set(0x000000); mt.depthWrite = true; mt.needsUpdate = true; } }); });
    return { obj: car, parts, wheels, par, parOrig, camBytes: Array.from(new Uint8Array(parBuf, 0x1b8, 4)), materials: built.materials, radius, descs: built.descs, folder, groundY: -radius };
  }

  // ---------- simple arcade-sim driving model ----------
  class CarPhysics {
    constructor(par, radius) {
      this.p = par; this.R = radius;
      this.pos = new THREE.Vector3(); this.yaw = 0; this.vel = new THREE.Vector3(); // world velocity
      this.yawRate = 0; this.gear = 1; this.rpm = par.idleRpm || 900; this.steer = 0;
      this.speed = 0; this.slip = 0; this.pitch = 0; this.roll = 0;
      this.throttle = 0; this.brake = 0; this.handbrake = false; this.autoShift = true;
      this.wheelSpin = 0;
    }
    torqueAt(rpm) {
      const t = this.p.torque, s = this.p.torqueStep;
      const x = Math.max(0, Math.min(rpm, (t.length - 1) * s)) / s, i = Math.floor(x), f = x - i;
      const a = t[i], b = t[Math.min(i + 1, t.length - 1)];
      return a + (b - a) * f;
    }
    step(dt, input, groundFn) {
      const p = this.p, g = 9.81;
      const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      let vf = this.vel.dot(fwd), vl = this.vel.dot(right);
      this.throttle = input.throttle; this.brake = input.brake; this.handbrake = input.handbrake;

      // gearbox (automatic unless manual shifts requested)
      const ng = p.gears.length;
      if (input.shiftUp) this.gear = Math.min(ng, this.gear + 1);
      if (input.shiftDown) this.gear = Math.max(-1, this.gear - 1);
      if (this.autoShift) {
        if (this.gear > 0 && this.rpm >= Math.min(p.shiftRpm, p.maxRpm * 0.97) && this.gear < ng) this.gear++;
        else if (this.gear > 1 && this.rpm < p.maxRpm * 0.38) this.gear--;
        if (vf < 0.5 && input.brake > 0.5 && input.throttle < 0.1) this.gear = -1;
        if (this.gear <= 0 && input.throttle > 0.5 && vf > -1) this.gear = 1;
      }
      const ratio = (this.gear > 0 ? p.gears[this.gear - 1] : this.gear < 0 ? p.reverse : 0) * p.finalDrive;
      const wheelW = Math.abs(vf) / this.R;
      const rpmWheel = ratio ? wheelW * ratio * 60 / (2 * Math.PI) : 0;
      this.rpm += (Math.max(p.idleRpm, rpmWheel, p.idleRpm + (this.gear === 0 ? input.throttle * 3000 : 0)) - this.rpm) * Math.min(1, dt * 10);
      this.rpm = Math.min(this.rpm, p.maxRpm);

      // longitudinal forces
      const eff = 0.8;
      let drive = 0;
      if (ratio) {
        const thr = this.gear < 0 ? input.brake : input.throttle;
        if (this.gear < 0 ? true : true) drive = thr * this.torqueAt(this.rpm) * ratio * eff / this.R * (this.rpm >= p.maxRpm ? 0 : 1);
      }
      if (this.gear < 0) drive = -drive;
      let brakeF = 0;
      if (this.gear >= 0) brakeF = input.brake * p.brake * 9 * Math.sign(vf);
      if (this.gear < 0) brakeF = input.throttle * p.brake * 9 * Math.sign(vf);
      const hb = input.handbrake ? p.mass * g * 0.5 * Math.sign(vf) : 0;
      const drag = 0.5 * 1.2 * 0.35 * 2.2 * vf * Math.abs(vf);
      const roll = 0.015 * p.mass * g * Math.sign(vf);
      let Fx = drive - Math.min(Math.abs(brakeF), Math.abs(vf) * p.mass / dt) * Math.sign(brakeF) - drag - roll - Math.min(Math.abs(hb), Math.abs(vf) * p.mass / dt) * Math.sign(hb);
      const grip = 1.05 * p.mass * g; // total tyre force budget
      // traction limit: clamp drive to grip (burn-out)
      const driveShare = input.handbrake ? 0.7 : 1;
      const maxFx = grip * 0.55 * driveShare;
      this.wheelSpin = Math.abs(drive) > maxFx ? 1 : 0;
      Fx = Math.max(-grip, Math.min(grip, Fx));
      if (Math.abs(vf) < 0.15 && !input.throttle && !input.brake) { Fx = 0; vf *= Math.max(0, 1 - dt * 8); }
      vf += (Fx / p.mass) * dt;
      if (this.gear >= 0 && input.brake > 0.1 && vf < 0 && !this.autoShift === false) vf = Math.max(vf, 0);

      // steering (speed-sensitive) + bicycle model for yaw
      const L = p.frontAxle + p.rearAxle;
      const maxLock = 0.58 / (1 + Math.abs(vf) * 0.045);
      this.steer += (input.steer * maxLock - this.steer) * Math.min(1, dt * 7);
      const slipF = Math.atan2(vl + this.yawRate * p.frontAxle, Math.abs(vf) + 0.5) - this.steer * Math.sign(vf || 1);
      const slipR = Math.atan2(vl - this.yawRate * p.rearAxle, Math.abs(vf) + 0.5);
      const stiff = grip * 0.5 * 8;
      const lim = grip * 0.5 * (input.handbrake ? 0.35 : 1);
      const clampF = v => Math.max(-lim, Math.min(lim, v));
      const Fyf = clampF(-stiff * slipF), Fyr = clampF(-stiff * slipR * (input.handbrake ? 0.45 : 1));
      const ay = (Fyf * Math.cos(this.steer) + Fyr) / p.mass;
      const Iz = p.inertia[2] * 2.2;
      this.yawRate += ((Fyf * p.frontAxle * Math.cos(this.steer) - Fyr * p.rearAxle) / Iz) * dt;
      this.yawRate *= 1 - Math.min(1, dt * 0.6);
      vl += (ay - vf * this.yawRate) * dt;
      // vf correction due to rotation
      vf += vl * this.yawRate * dt;
      this.slip = Math.abs(vl) / (Math.abs(vf) + 1);
      this.yaw += this.yawRate * dt;
      const f2 = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)), r2 = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      this.vel.copy(f2.multiplyScalar(vf)).addScaledVector(r2, vl);
      this.speed = vf;
      // body pitch / roll from accelerations
      const tp = -Fx / p.mass * 0.012, tr = -ay * 0.012;
      this.pitch += (tp - this.pitch) * Math.min(1, dt * 6); this.roll += (tr - this.roll) * Math.min(1, dt * 6);
      this.pos.addScaledVector(this.vel, dt);
    }
  }

  // physics factory: the reverse-engineered original model (physics-orig.js), or the arcade model with ?phys=arcade
  function makePhysics(car, world) {
    const O = global.YDPhysOrig;
    if (O && car.parOrig && new URLSearchParams(location.search).get('phys') !== 'arcade') {
      return new O.OrigCarPhysics(car.parOrig, car.radius, { groundFn: world && world.ground ? (x, z, y) => world.ground(x, z, y) : null, rayFn: world && world.rayCast, tunnelFn: world && world.inTunnel });
    }
    return new CarPhysics(car.par, car.radius);
  }

  global.YDCar = { readPar, loadCar, CarPhysics, makePhysics };
})(window);
