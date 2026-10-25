// Port of the ORIGINAL Yerevan Drive v1.1 car physics (reverse engineered from the exe, see spec-physics.md).
//
//   window.YDPhysOrig = { readPar(buf), OrigCarPhysics, resolveCarCollision, resolveWorldContact, impulseAt }
//
// OrigCarPhysics is a drop-in for YDCar.CarPhysics (web/car.js): same constructor(par, wheelRadius) and
// step(dt, input) interface, same exposed fields, in the mirrored three.js space (x' = -x, yaw' = -yaw,
// forward = (sin yaw, 0, cos yaw), internal steer positive = yaw increases = turning toward the driver's left).
// Internally the simulation runs in the game's own Direct3D space (left-handed, Y up) so the equations are
// the original's. EXACT = taken directly from the decompiled code; APPROX = reconstructed (see the spec).
(function (global) {
  'use strict';

  const GRAVITY = 9.8;            // EXACT  (_DAT_0049cec4 = -9.8)
  const MAX_STEP = 0.02;          // EXACT  frame is split into steps of at most 0.02 s (FUN_00436cb0)
  const WHEEL_SUBSTEPS = 4;       // EXACT  FUN_00413480: 4 x FUN_004114c0(dt * 0.25)
  const RPM_PER_RAD = 9.549296;   // EXACT  (_DAT_004845d4)
  const RAD_PER_RPM = 0.10471976; // EXACT  (_DAT_00484544)
  const DAMPER_SCALE = 100;       // EXACT  (_DAT_00484660) damper uses (dL per step) * c * 100
  const REF_DT = 1 / 60;          // damper reference frame time (original dL is per *frame*; we normalise to 60 fps)
  const damperMaxStep = 0.05;     // EXACT  clamp of dL per step (+-0.05 m)

  // ---------------------------------------------------------------------------------------------------
  // CAR! parameter file (avto.par): 'CAR!' + name[0x1c] + 0x1c8-byte struct. Offsets verified against the loader
  // FUN_0040ed20 (field -> car-type member) and the code that consumes each member.
  function readPar(buf) {
    const dv = new DataView(buf), f = o => dv.getFloat32(o, true), u = o => dv.getUint32(o, true);
    if (u(0) !== 0x21524143) throw new Error('not CAR!');
    let name = ''; for (let i = 4; i < 0x20 && dv.getUint8(i); i++) name += String.fromCharCode(dv.getUint8(i));
    const gearCount = u(0x178);
    const ratios = [];                       // index 0 = reverse, 1 = neutral (0), 2.. = 1st.. gear (EXACT: table at type+0x39c)
    for (let i = 0; i < 10; i++) ratios.push(f(0x17c + 4 * i));
    const torque = [];                       // torque (N*m) at rpm = 500*i, i = 0..23 (EXACT: type+0x414, index = rpm/500)
    for (let i = 0; i < 24; i++) torque.push(f(0x104 + 4 * i));
    const axle = o => ({                     // 8-float wheel parameter block built by the loader (type+0x300 / +0x320)
      w0: f(o[0]), inertia: f(o[1]), restLen: f(o[2]), mountY: f(o[3]), spring: f(o[4]), damper: f(o[5]), radius: f(o[6]), mu: f(o[7]),
    });
    const front = axle([0xb4, 0xb8, 0xa4, 0xa8, 0xac, 0xb0, 0xbc, 0xc0]);
    const rear = axle([0xdc, 0xe0, 0xcc, 0xd0, 0xd4, 0xd8, 0xe4, 0xe8]);
    const par = {
      name,
      id: u(0x84),                                                  // unknown int (price / model id), unused by physics
      mass: f(0x8c), inertia: [f(0x90), f(0x94), f(0x98)],          // EXACT: pitch (about right axis), yaw (about up), roll (about forward)
      frontAxle: f(0x9c), frontTrack: f(0xa0),                      // EXACT: wheel mounts (+/-track/2, mountY, +frontAxle)
      rearAxle: f(0xc4), rearTrack: f(0xc8),                        // EXACT: wheel mounts (+/-track/2, mountY, -rearAxle)
      front, rear,
      engineInertia: f(0xec),                                       // EXACT type+0x350
      idleRpm: f(0xf0), maxRpm: f(0xf4), shiftRpm: f(0xf8),         // EXACT type+0x354/358/35c (rpm)
      engineBrake: f(0xfc), limiterTorque: f(0x100),                // EXACT type+0x360 (torque when off throttle), +0x364 (limiter)
      torque, torqueStep: 500,
      drag: f(0x164), downforce: f(0x168), downforceRev: f(0x16c),  // EXACT type+0x2f4/2f8/2fc
      driveType: u(0x170),                                          // EXACT type+0x340: 0 = rear wheel drive, else front wheel drive
      driveInertia: f(0x174),                                       // EXACT type+0x368: driveline + driven wheels inertia
      gearCount, ratios, reverse: ratios[0], gears: ratios.slice(2, 2 + gearCount),
      finalDrive: f(0x1a4), efficiency: f(0x1a8),                   // EXACT type+0x3c4 / 0x3c8
      maxSteer: f(0x1ac), brakeTorque: f(0x1b0),                    // EXACT type+0x344 (rad) / 0x348 (N*m at each wheel when braking)
      flag34c: u(0x1b4),
      // legacy names used elsewhere in the web code (web/car.js readPar) -------------------------------------------
      inertiaPYR: [f(0x90), f(0x94), f(0x98)],
      springF: f(0xac), damperF: f(0xb0), springR: f(0xd4), damperR: f(0xd8), brake: f(0x1b0), wheelDia: f(0xbc) * 2,
    };
    return par;
  }

  // ---------------------------------------------------------------------------------------------------
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const sgn = v => (v > 0 ? 1 : v < 0 ? -1 : 0);

  class OrigCarPhysics {
    // opts: { transmission: 1 (auto, default) | 0 (manual), groundFn, halfExtents }
    constructor(par, wheelRadius, opts) {
      opts = opts || {};
      this.p = par; this.par = par;
      const T = global.THREE;
      this.pos = new T.Vector3(); this.vel = new T.Vector3();
      // --- exposed state (same names/meaning as YDCar.CarPhysics) ---
      this.yaw = 0; this.yawRate = 0; this.steer = 0; this.speed = 0;
      this.gear = 1; this.rpm = par.idleRpm; this.pitch = 0; this.roll = 0; this.slip = 0; this.wheelSpin = 0;
      this.throttle = 0; this.brake = 0; this.handbrake = false;
      this.autoShift = opts.transmission === 0 ? false : true;
      this.gy = 0;                     // ground height used when no ground function is set (and updated from wheel contacts)
      this.ground = opts.groundFn || null; // ground(x3, z3, refY) -> y | null  (three.js space)
      this.rayFn = opts.rayFn || null; this.tunnelFn = opts.tunnelFn || null;   // underground: wheel rays along the car's own down axis (metro tubes: driving on walls and ceiling)
      this.tunnel = false; this.basis = null;
      this.wheelRadius = wheelRadius || par.rear.radius;
      this.halfExtents = opts.halfExtents || [1.0, 0.7, 2.4];   // OBB for carCarResponse (the 'bound' mesh box in the original)
      this.wheels = [];                // per-wheel public data: {compression, omega, contact, slip, load}
      // --- internal state, Direct3D space ---
      this._p = [0, 0, 0]; this._v = [0, 0, 0];
      this._r = [1, 0, 0]; this._u = [0, 1, 0]; this._f = [0, 0, 1];   // body axes (right, up, forward) in world
      this._w = [0, 0, 0];                                              // angular velocity, body frame (pitch, yaw, roll)
      this._steer = 0;                                                  // car+0x180, positive = right turn (D3D)
      this._idxCur = 1; this._idxTgt = 1; this._shiftT = 0;             // car+0x194 / +0x198 / +0x190 (0=R, 1=N, 2..=gears)
      this._eOmega = par.idleRpm * RAD_PER_RPM;                         // car+0x1c0 engine angular speed
      this._driveOmega = 0;                                             // car+0x1b8 driven-wheel angular speed (shared)
      this._engTorque = 0; this._driveTorque = 0;                       // car+0x1c4 / +0x1bc
      this._init = false; this._lastYaw = 0; this._lastSpeedMag = 0;
      this._mkWheels();
    }

    _mkWheels() {
      const par = this.par, rwd = par.driveType === 0;
      const mk = (front, left) => {
        const b = front ? par.front : par.rear;
        const half = (front ? par.frontTrack : par.rearTrack) * 0.5;
        return {
          front, left, driven: rwd ? !front : front, b,
          mount: [left ? -half : half, b.mountY, front ? par.frontAxle : -par.rearAxle],   // EXACT (type+0x3e4..0x410)
          L: b.restLen, Lprev: b.restLen, omega: 0, hit: false, n: [0, 1, 0], groundY: 0,
          fw: [0, 0, 1], lw: [1, 0, 0], M: [0, 0, 0], P: [0, 0, 0],
        };
      };
      this._wh = [mk(true, true), mk(true, false), mk(false, true), mk(false, false)];   // FL, FR, RL, RR
      this.wheels = this._wh.map(() => ({ compression: 0, omega: 0, contact: false, slip: 0, load: 0 }));
    }

    // ---------------------------------------------------------------- public API
    step(dt, input, groundFn) {
      if (groundFn) this.ground = groundFn;
      input = input || {};
      this._syncIn(dt);
      const n = dt > MAX_STEP ? 1 + Math.floor(dt / MAX_STEP) : 1, ds = dt / n;     // EXACT sub-division of FUN_00436cb0
      for (let i = 0; i < n; i++) this._simStep(ds, input);
      this._syncOut(dt, input);
    }

    // ---------------------------------------------------------------- state in/out
    _syncIn(dt) {
      const ex = this.pos, ev = this.vel;
      const mag = this.tunnel ? Math.hypot(ev.x, ev.y, ev.z) : Math.hypot(ev.x, ev.z);
      const wasMoving = this._lastSpeedMag > 0.5;
      // external teleport/reset detection
      const yawChanged = Math.abs(this.yaw - this._lastYaw) > 1e-5;
      const reset = !this._init || (wasMoving && mag < 1e-6) || Math.hypot(ex.x + this._p[0], ex.z - this._p[2]) > 4;
      this._p[0] = -ex.x; this._p[2] = ex.z; this._v[0] = -ev.x; this._v[2] = ev.z;
      if (this.tunnel && this._init && !reset) { this._p[1] = ex.y; this._v[1] = ev.y; }   // underground the body is free in 3D: take collision pushes in y too
      if (!this._init || reset) {
        this._setYaw(-this.yaw);
        this._w = [0, 0, 0]; this._driveOmega = 0; this._eOmega = this.par.idleRpm * RAD_PER_RPM; this._steer = 0;
        for (const w of this._wh) { w.omega = 0; w.hit = false; }
        if (!this._init || reset) { this._v[1] = 0; this._p[1] = this._groundAt(this._p[0], this._p[2], ex.y + 1) + this._cgHeight(); this._first = true; }
        this._idxCur = this._idxTgt = 1; this._shiftT = 0;
        this._init = true;
      } else if (yawChanged) {
        this._setYaw(-this.yaw); this._w = [0, 0, 0];
      }
      // vertical state stays internal; if ground jumped far from the body (reset onto a new level) snap back
      const g = this._groundAt(this._p[0], this._p[2], this._p[1]);
      if (!this.tunnel && Math.abs(this._p[1] - g - this._cgHeight()) > 3) { this._p[1] = g + this._cgHeight(); this._v[1] = 0; }
    }

    _setYaw(yd) { // yaw in D3D space: forward = (sin, 0, cos)
      const s = Math.sin(yd), c = Math.cos(yd);
      this._f = [s, 0, c]; this._r = [c, 0, -s]; this._u = [0, 1, 0];
    }

    _syncOut(dt, input) {
      const p = this._p, v = this._v, f = this._f, r = this._r, u = this._u;
      this.pos.set(-p[0], p[1], p[2]); this.vel.set(-v[0], v[1], v[2]);
      this.yaw = Math.atan2(-f[0], f[2]); this._lastYaw = this.yaw;
      this.speed = dot(v, f);
      this._lastSpeedMag = Math.hypot(v[0], v[2]);
      this.steer = -this._steer;                                 // mirrored sign: positive = toward driver's left
      this.yawRate = -(this._w[1] * u[1]);                       // approx world yaw rate (mirrored sign)
      this.rpm = this._eOmega * RPM_PER_RAD;
      this.gear = this._idxCur === 0 ? -1 : this._idxCur === 1 ? 0 : this._idxCur - 1;
      // attitude relative to the ground plane through the wheel contacts (so that sim.js placeCar slope tilt is not doubled)
      const wh = this._wh, L = Math.abs(wh[0].mount[2] - wh[2].mount[2]) || 3, Tw = Math.abs(wh[0].mount[0] - wh[1].mount[0]) || 1.6;
      const hF = (wh[0].groundY + wh[1].groundY) / 2, hR = (wh[2].groundY + wh[3].groundY) / 2;
      const hLeft = (wh[0].groundY + wh[2].groundY) / 2, hRight = (wh[1].groundY + wh[3].groundY) / 2;   // D3D left = three +X
      const bodyPitch = -Math.asin(clamp(f[1], -1, 1)), bodyRoll = -Math.asin(clamp(r[1], -1, 1));
      const slopePitch = -Math.atan2(hF - hR, L), slopeRoll = Math.atan2(hLeft - hRight, Tw);
      this.pitch = bodyPitch - slopePitch; this.roll = bodyRoll - slopeRoll;
      if (this.tunnel) { this.basis = { r: [-r[0], r[1], r[2]], u: [-u[0], u[1], u[2]], f: [-f[0], f[1], f[2]] }; this.pitch = 0; this.roll = 0; } else this.basis = null;   // full 3D attitude for placeCar
      let slipMax = 0, spin = 0;
      for (let i = 0; i < 4; i++) { const w = wh[i], o = this.wheels[i]; o.compression = w.b.restLen - w.L; o.omega = w.omega; o.contact = w.hit; o.slip = w._slip || 0; o.load = w._load || 0; slipMax = Math.max(slipMax, o.slip); if (w.driven && o.slip > 0.2) spin = 1; }
      this.slip = slipMax; this.wheelSpin = spin;
      this.throttle = this._gas ? 1 : 0; this.brake = this._brk ? 1 : 0; this.handbrake = !!input.handbrake;
      const gys = wh.filter(w => w.hit).map(w => w.groundY); if (gys.length) this.gy = gys.reduce((a, b) => a + b, 0) / gys.length;
    }

    _cgHeight() { // static CG height above ground (EXACT geometry: R + L_static - mountY)
      const b = this.par.rear, x = this.par.mass * GRAVITY / 4 / b.spring;
      return b.radius + (b.restLen - x) - b.mountY;
    }

    _groundAt(x, z, refY) { // D3D x,z -> ground height (three.js ground(x3,z3,refY))
      if (this.ground) { const y = this.ground(-x, z, refY); return y === null || y === undefined ? (this.gy || 0) : y; }
      return this.gy || 0;
    }

    // ---------------------------------------------------------------- one physics step (FUN_00413480)
    _simStep(dt, input) {
      const par = this.par, m = par.mass;
      const v = this._v, p = this._p, r = this._r, u = this._u, f = this._f, w = this._w;
      // 1. drag / downforce / gravity (EXACT)
      const sp = Math.hypot(v[0], v[1], v[2]);
      const cq = sp < 0 ? par.downforceRev : par.downforce;                  // (sp<0 never true)
      const lin = -sp * par.drag, down = -(cq * sp * sp);
      v[0] += ((lin * v[0] + down * u[0]) / m) * dt;
      // metro tubes: at speed the car sticks to the surface it drives on (gravity blends towards -up), so it can run along walls and ceiling without peeling off and tumbling
      const k = this.tunnel && global.YD_ASSIST ? Math.min(1, Math.max(0, (sp - 6) / 14)) : 0, gx = -u[0] * k * GRAVITY, gy = -(1 - k) * GRAVITY - u[1] * k * GRAVITY, gz = -u[2] * k * GRAVITY;
      v[0] += ((lin * v[0] + down * u[0]) / m + gx) * dt;
      v[1] += ((lin * v[1] + down * u[1]) / m + gy) * dt;
      v[2] += ((lin * v[2] + down * u[2]) / m + gz) * dt;
      if (this.tunnel) { const d = Math.exp(-1.2 * dt); w[0] *= d; w[2] *= d; for (let i = 0; i < 3; i++) w[i] = Math.max(-4, Math.min(4, w[i])); }   // tumble damping (pitch / roll) and a cap so a hit cannot start a wild spin
      // 2. integrate orientation (body frame YawPitchRoll(wy, wx, wz)*dt) and position (EXACT, FUN_0041d1b0)
      this._rotate(w[0] * dt, w[1] * dt, w[2] * dt);
      p[0] += v[0] * dt; p[1] += v[1] * dt; p[2] += v[2] * dt;
      // 3. controller: flags + gear selection (FUN_0041b330), steering, engine/gearbox
      this._controller(input, dt);
      this._steering(dt, input);
      this._engine(dt);
      // 4. wheels: ray casts / suspension length (FUN_004111c0), then 4 force sub-steps (FUN_004114c0)
      this._wheelPre(dt);
      const ds4 = dt / WHEEL_SUBSTEPS;
      for (let k = 0; k < WHEEL_SUBSTEPS; k++) {
        if (!this._handbrake) this._driveOmega += ds4 * (this._driveTorque / par.driveInertia);   // EXACT
        for (const wh of this._wh) this._wheelForce(wh, ds4);
        if (this._idxCur > 1 && this._driveOmega < 0) this._driveOmega = 0;
        if (this._idxCur === 0 && this._driveOmega > 0) this._driveOmega = 0;
      }
    }

    _rotate(wx, wy, wz) { // M = Rz(roll) * Rx(pitch) * Ry(yaw) with D3DX row-vector matrices, new axes = M * old axes
      const cx = Math.cos(wx), sx = Math.sin(wx), cy = Math.cos(wy), sy = Math.sin(wy), cz = Math.cos(wz), sz = Math.sin(wz);
      const RX = [[1, 0, 0], [0, cx, sx], [0, -sx, cx]], RY = [[cy, 0, -sy], [0, 1, 0], [sy, 0, cy]], RZ = [[cz, sz, 0], [-sz, cz, 0], [0, 0, 1]];
      const mul = (A, B) => A.map((_, i) => [0, 1, 2].map(j => A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]));
      const M = mul(mul(RZ, RX), RY);
      const ax = [this._r, this._u, this._f];
      const nw = [0, 1, 2].map(i => [0, 1, 2].map(k => M[i][0] * ax[0][k] + M[i][1] * ax[1][k] + M[i][2] * ax[2][k]));
      // re-orthonormalise (Gram-Schmidt around forward, then up)
      const f = norm(nw[2]); let r = nw[0]; const d = dot(r, f); r = norm([r[0] - d * f[0], r[1] - d * f[1], r[2] - d * f[2]]);
      const uu = cross(f, r);                                                                // LH numeric basis: up = forward x right
      this._r = r; this._f = f; this._u = uu;
    }

    // Input -> flags and gear logic, replicating the player controller FUN_0041b330 (automatic and manual).
    _controller(input, dt) {
      const par = this.par, v = this._v, f = this._f;
      const keyUp = (input.throttle || 0) > 0.05, keyDown = (input.brake || 0) > 0.05;
      this._gas = false; this._brk = false; this._handbrake = !!input.handbrake;
      this._thr = clamp(input.throttle || 0, 0, 1);
      const gasFlag = () => { if (!this._brk) this._gas = true; };      // FUN_00410780: gas only if not braking
      const brakeFlag = () => { this._brk = true; };                    // FUN_004107a0
      const shiftUp = () => { if (this._idxTgt <= par.gearCount) { this._idxTgt++; if (this._shiftT <= 0) this._shiftT = 0.2; } };   // FUN_004106e0 (type+0x388 = 0.2 s)
      const shiftDn = () => { if (this._idxTgt !== 0) { this._idxTgt--; if (this._shiftT <= 0) this._shiftT = 0.2; } };               // FUN_00410730
      if (!this.autoShift) {                                            // manual (Transmission = 0)
        if (input.shiftUp) shiftUp(); if (input.shiftDown) shiftDn();
        if (keyDown) brakeFlag(); if (keyUp) gasFlag();
        return;
      }
      if (this._idxTgt === 1) this._idxTgt = 2; if (this._idxCur === 1) this._idxCur = 2;       // neutral is skipped in auto mode
      const speed = Math.abs(dot(v, f));
      const fin = par.finalDrive, idx = this._idxTgt, R = par.rear.radius, wmax = par.maxRpm * RAD_PER_RPM;
      const ratioCur = par.ratios[idx] * fin;
      const ratioLow = idx !== 0 ? par.ratios[idx - 1] * fin : ratioCur;
      const vUp = (wmax / ratioCur) * R * 0.95;                          // EXACT (_DAT_004848a4 = 0.95)
      const vDown = (wmax / ratioLow) * R * 0.95;
      if (this._idxCur > 1) {
        if (keyDown) brakeFlag(); if (keyUp) gasFlag();
        if (speed <= vUp) { if (this._idxTgt > 2 && speed < vDown) shiftDn(); } else shiftUp();
        if (this._idxCur === 2 && speed < 4 && keyDown) { this._idxTgt = 0; this._idxCur = 0; }   // stop -> reverse
      }
      if (this._idxTgt === 0) {                                          // reverse: keys swap meaning
        if (keyUp) brakeFlag(); if (keyDown) { gasFlag(); this._thr = clamp(input.brake || 0, 0, 1); }   // reverse: the Down key is the accelerator
        if (speed < 4 && keyUp) { this._idxTgt = 2; this._idxCur = 2; }
      }
    }

    // Steering (EXACT, FUN_00413480): 2 rad/s ramp, lock = maxSteer * clamp(15/speed, 0.3, 1)
    _steering(dt, input) {
      const par = this.par, sp = Math.hypot(this._v[0], this._v[1], this._v[2]);
      let k = 1; if (sp > 15) { k = 15 / sp; if (k < 0.3) k = 0.3; }
      const lock = par.maxSteer * k, rate = 2 * dt;
      const want = clamp(-(input.steer || 0), -1, 1) * par.maxSteer;       // input.steer>0 = left -> D3D steer negative
      let s = this._steer;
      if (Math.abs(want - s) <= rate) s = want; else s += Math.sign(want - s) * rate;
      this._steer = clamp(s, -lock, lock);
    }

    _torque(omega) { // EXACT FUN_0040f880
      const par = this.par; let rpm = omega * RPM_PER_RAD;
      if (rpm < par.idleRpm) rpm = par.idleRpm;
      if (rpm > par.maxRpm) return 0;
      const t = rpm * 0.002, i = Math.floor(t), tb = par.torque;
      return tb[i] + (t - i) * (tb[i + 1] - tb[i]);
    }

    // Gear delay, engine speed, torque to the driveline (EXACT, FUN_00413480 middle part)
    _engine(dt) {
      const par = this.par;
      if (this._shiftT >= 0) { this._shiftT -= dt; if (this._shiftT < 0 && this._idxCur !== this._idxTgt) this._idxCur = this._idxTgt; }
      this._brakeT = this._brk ? par.brakeTorque : 10;               // car+0x1a0: wheel brake torque (10 N*m drag when not braking)
      let T = -par.engineBrake;                                       // car+0x1c4
      if (this._gas) T = this._torque(this._eOmega) * this._thr;
      const gi = this._idxCur, fin = par.finalDrive;
      let implied = this._driveOmega * fin * par.ratios[gi];
      if (gi === 0) implied *= -1;
      let dEngine;
      if (gi === 1 || this._handbrake) dEngine = (T / par.engineInertia) * dt;      // clutch open: engine free-revs
      else dEngine = (implied - this._eOmega) * dt * 4;                              // clutch closed: follows the wheels (rate 4/s)
      this._eOmega += dEngine;
      const wmax = par.maxRpm * RAD_PER_RPM;
      if (this._eOmega >= wmax) { this._eOmega = wmax; T -= par.limiterTorque; }
      if (this._eOmega < 0) this._eOmega = 0;
      this._engTorque = T;
      this._driveTorque = 0;
      if (gi === 0) this._driveTorque = -(par.efficiency * fin * T * par.ratios[0]);
      else if (gi >= 2) this._driveTorque = par.efficiency * fin * T * par.ratios[gi];
      // DEVIATION (creep guard): the original applies its constant engine-braking torque even at standstill, which makes a
      // parked car in gear creep backwards (~0.3 km/h). Fade the off-throttle torque out below 0.5 m/s.
      if (!this._gas) this._driveTorque *= clamp(Math.abs(dot(this._v, this._f)) / 0.5, 0, 1);
    }

    // wheel pre-update FUN_004111c0: wheel axes, ground ray, suspension length
    _wheelPre(dt) {
      this.tunnel = !!(this.tunnelFn && this._init && this.tunnelFn(-this._p[0], this._p[1], this._p[2], this.tunnel && this._u[1] < 0.7));   // tilted onto the wall/ceiling inside a tube: stay in tube mode even above the entry depth (the tube top is higher than the floor)
      const p = this._p, r = this._r, u = this._u, f = this._f, steer = this._steer;
      const cs = Math.cos(steer), sn = Math.sin(steer);
      for (const w of this._wh) {
        w.Lprev = w.L;
        const mt = w.mount;
        w.M = [p[0] + mt[0] * r[0] + mt[1] * u[0] + mt[2] * f[0], p[1] + mt[0] * r[1] + mt[1] * u[1] + mt[2] * f[1], p[2] + mt[0] * r[2] + mt[1] * u[2] + mt[2] * f[2]];
        if (w.front) {                                                  // D3DXMatrixRotationY(steer): forward turns toward +right
          w.fw = [cs * f[0] + sn * r[0], cs * f[1] + sn * r[1], cs * f[2] + sn * r[2]];
          w.lw = [cs * r[0] - sn * f[0], cs * r[1] - sn * f[1], cs * r[2] - sn * f[2]];
        } else { w.fw = f.slice(); w.lw = r.slice(); }
        // ground query below the mount point (APPROX: vertical ray + finite-difference normal)
        const refY = w.M[1] - (w.b.restLen + w.b.radius) * 0.85;
        const x = w.M[0], z = w.M[2];
        let h = this._groundAt(x, z, refY);
        w.groundY = h;
        let n = [0, 1, 0];
        if (this.ground) {
          const e = 0.5, hx = this._groundAt(x + e, z, refY), hz = this._groundAt(x, z + e, refY);
          const dhdx = (hx - h) / e, dhdz = (hz - h) / e;                                             // dh/dx_d, dh/dz
          n = norm([-dhdx, 1, -dhdz]);
        }
        const d = (w.M[1] - h) / Math.max(u[1], 0.3);
        if (d < w.b.restLen + w.b.radius) { w.hit = true; w.L = d - w.b.radius; w.n = n; w.hy = h; }
        else { w.hit = false; w.L = w.b.restLen; w.n = n; }
        if (this.tunnel && this.rayFn) {   // ray along -up against the underground triangles; the nearer of ray and vertical ground wins
          const reach = w.b.restLen + w.b.radius, hr = this.rayFn(-w.M[0], w.M[1], w.M[2], u[0], -u[1], -u[2], reach);
          if (hr && (!w.hit || hr.t < d)) { w.hit = true; w.L = hr.t - w.b.radius; w.n = [-hr.nx, hr.ny, hr.nz]; w.hy = w.groundY = w.M[1] - u[1] * hr.t; }
        }
        if (this._first) w.Lprev = w.L;
      }
      this._first = false;
    }

    // velocity of the body at world point q
    _velAt(q) {
      const v = this._v, p = this._p, r = this._r, u = this._u, f = this._f, w = this._w;
      const om = [w[0] * r[0] + w[1] * u[0] + w[2] * f[0], w[0] * r[1] + w[1] * u[1] + w[2] * f[1], w[0] * r[2] + w[1] * u[2] + w[2] * f[2]];
      const c = cross(om, [q[0] - p[0], q[1] - p[1], q[2] - p[2]]);
      return [v[0] + c[0], v[1] + c[1], v[2] + c[2]];
    }

    // FUN_0041e120: force F at world point P for time dt (EXACT)
    _applyForce(P, F, dt) {
      const par = this.par, p = this._p, r = this._r, u = this._u, f = this._f, w = this._w, v = this._v;
      const d = [P[0] - p[0], P[1] - p[1], P[2] - p[2]], tq = cross(d, F);
      w[0] += (dot(tq, r) / par.inertia[0]) * dt;
      w[1] += (dot(tq, u) / par.inertia[1]) * dt;
      w[2] += (dot(tq, f) / par.inertia[2]) * dt;
      const im = 1 / par.mass; v[0] += F[0] * im * dt; v[1] += F[1] * im * dt; v[2] += F[2] * im * dt;
    }

    // FUN_004114c0: one wheel, one sub-step.  EXACT parts: spring/damper constants, slip falloff, grip limits,
    // wheel spin / brake torque handling.  APPROX: vector decomposition (decompiler lost it).
    _wheelForce(w, ds) {
      const par = this.par, b = w.b, u = this._u, f = this._f, R = b.radius;
      const driven = w.driven;
      if (driven) w.omega = this._driveOmega;
      if (!w.front && this._handbrake) w.omega = 0;                         // rear wheels lock with the handbrake
      const Iw = driven ? par.driveInertia : b.inertia;
      const applyBrakeTorque = () => {                                      // car+0x1a0 applied against the spin (EXACT)
        let T = this._brakeT; if (w.omega > 0) T = -T;
        if (Math.abs((w.omega * Iw) / T) <= ds) w.omega = 0; else w.omega += (T / Iw) * ds;
      };
      if (!w.hit) {                                                          // airborne / fully extended
        applyBrakeTorque(); if (driven) this._driveOmega = w.omega; w._slip = 0; w._load = 0; return;
      }
      // spring + damper (EXACT constants)
      const Fs = (b.restLen - w.L) * b.spring;
      // original: dL = clamp(L - Lprev, +-0.05) per *frame*; normalised here to a 60 fps frame so it is independent of our step size
      const dL = clamp(((w.L - w.Lprev) / (ds * WHEEL_SUBSTEPS)) * REF_DT, -damperMaxStep, damperMaxStep);
      const Fd = -(dL * b.damper * DAMPER_SCALE);
      const n = w.n, un = Math.max(dot(u, n), 0);
      const Fsp = Math.max(Fs, 0) * un;                                      // spring force along the ground normal
      const Fspring = [n[0] * Fsp, n[1] * Fsp, n[2] * Fsp];
      const Fdamp = [u[0] * Fd, u[1] * Fd, u[2] * Fd];
      const load = Fsp;
      // contact point and its velocity (the original samples 0.5*rearAxle ahead of the contact)
      const P = [w.M[0] - u[0] * (R + w.L), w.M[1] - u[1] * (R + w.L), w.M[2] - u[2] * (R + w.L)];
      const Q = [P[0] + f[0] * 0.5 * par.rearAxle, P[1] + f[1] * 0.5 * par.rearAxle, P[2] + f[2] * 0.5 * par.rearAxle];
      const vc = this._velAt(Q);
      // slip ratio -> grip factor (EXACT constants 0.2 / 0.4 / 0.8 / +10 m/s)
      const rolling = R * w.omega;
      const sx = rolling * w.fw[0] - vc[0], sy = rolling * w.fw[1] - vc[1], sz = rolling * w.fw[2] - vc[2];
      const slip = Math.hypot(sx, sy, sz) / (Math.max(Math.abs(rolling), 0.01) + 10);
      let g = 1;
      if (slip > 0.2) { g = 1 - (slip - 0.2) * 0.4; if (g < 0.8) g = 0.8; if (g > 1) g = 1; }
      w._slip = slip; w._load = load;
      const Fmax = load * b.mu * g;
      applyBrakeTorque();                                                    // brake torque acts on the wheel before the tyre
      // longitudinal: friction torque until the wheel speed matches the ground (impulse limited)
      const vf = dot(vc, w.fw), omFree = vf / R, dOm = w.omega - omFree;
      let Fx = 0;
      if (Fmax > 0) {
        let T = -sgn(dOm) * Fmax * R; if (T === 0) T = 1e-5;
        const t = Math.min(Math.abs((dOm * Iw) / T), ds);
        w.omega += (t / Iw) * T;
        Fx = (-T / R) * (t / ds);
      }
      if (driven) this._driveOmega = w.omega;
      // lateral: cancels sideways velocity of a quarter of the car within the step, capped at 1.02 * Fmax
      const vl = dot(vc, w.lw);
      const Fy = -sgn(vl) * Math.min((Math.abs(vl) * par.mass * 0.25) / ds, 1.02 * Fmax);
      const F = [Fspring[0] + Fdamp[0] + Fx * w.fw[0] + Fy * w.lw[0], Fspring[1] + Fdamp[1] + Fx * w.fw[1] + Fy * w.lw[1], Fspring[2] + Fdamp[2] + Fx * w.fw[2] + Fy * w.lw[2]];
      this._applyForce(P, F, ds);
    }
  }

  // ---------------------------------------------------------------------------------------------------
  // COLLISION RESPONSE (original rules, see spec-physics.md "Collision response")
  //  * every car (player, AI opponent, traffic) is the same dynamic rigid-body class, kept in per-block lists; each car's
  //    update tests all other cars near it, so the response is symmetric and mass weighted (no kinematic bodies).
  //  * car vs car (FUN_0041f900): positional separation split by mass (the lighter car moves more); then an equal and
  //    opposite impulse  J = (vA - vB) * (mA*mB*0.1/(mA+mB))  applied for a "time" of 0.1  => each frame the relative
  //    velocity only drops by ~1% (very soft: cars grind past each other, nobody is thrown). No restitution, no damage.
  //  * car vs static world (FUN_0041e930/FUN_0041e7a0): hard positional push-out along the surface normal (x1.01),
  //    then at the contact point a normal impulse that removes 10% of the normal velocity per frame (mass * 0.1 * vn)
  //    and a Coulomb friction impulse of 0.5 * |normal impulse| along the tangent. Restitution is 0 (no bounce).
  //  The original applies these once per physics frame (about 60 per second); `dt` scales the fractions accordingly.
  const FRAME = 1 / 60;
  const massOf = b => (b.par ? b.par.mass : (b.mass || 1500));
  const frameFrac = (f, dt) => 1 - Math.pow(1 - f, Math.min(Math.max((dt || FRAME) / FRAME, 0), 4));

  // linear + angular impulse (Delta momentum = imp, three-space vector) at world point P (three space) for an OrigCarPhysics
  function impulseAt(body, P, imp) {
    if (body._applyForce && body._init) {
      body._v[0] = -body.vel.x; body._v[1] = body.vel.y; body._v[2] = body.vel.z;
      body._p[0] = -body.pos.x; body._p[1] = body.pos.y; body._p[2] = body.pos.z;
      body._applyForce([-P[0], P[1], P[2]], [-imp[0], imp[1], imp[2]], 1);        // force * 1 s == impulse
      body.vel.set(-body._v[0], body._v[1], body._v[2]);
    } else {                                                                       // plain {pos, vel, mass} body: linear only
      const m = massOf(body); body.vel.x += imp[0] / m; body.vel.y += imp[1] / m; body.vel.z += imp[2] / m;
    }
  }

  // a, b: OrigCarPhysics (or any {pos, vel, mass|par.mass}); (nx,nz) = horizontal unit normal pointing from b to a; pen = overlap depth;
  // (px,py,pz) = contact point (three space, defaults to the midpoint). opts.dt = elapsed time since the last call.
  function resolveCarCollision(a, b, nx, nz, pen, px, py, pz, opts) {
    opts = opts || {};
    const ma = massOf(a), mb = massOf(b), tot = ma + mb;
    if (px === undefined) { px = (a.pos.x + b.pos.x) / 2; pz = (a.pos.z + b.pos.z) / 2; py = ((a.pos.y || 0) + (b.pos.y || 0)) / 2; }
    a.pos.x += nx * pen * (mb / tot); a.pos.z += nz * pen * (mb / tot);          // heavier body moves less
    b.pos.x -= nx * pen * (ma / tot); b.pos.z -= nz * pen * (ma / tot);
    const k = frameFrac(0.1 * 0.1, opts.dt);                                       // 0.1 (impulse scale) * 0.1 (momentum fraction) per frame
    const mu = (ma * mb) / tot;                                                    // reduced mass
    const jx = (a.vel.x - b.vel.x) * mu * k, jy = (a.vel.y - b.vel.y) * mu * k, jz = (a.vel.z - b.vel.z) * mu * k;
    impulseAt(a, [px, py, pz], [-jx, -jy, -jz]);
    impulseAt(b, [px, py, pz], [jx, jy, jz]);
  }

  // phys: OrigCarPhysics (or {pos, vel, mass}); (nx,nz) horizontal unit normal pointing away from the wall; pen = penetration depth.
  function resolveWorldContact(phys, nx, nz, pen, px, py, pz, opts) {
    opts = opts || {};
    const m = massOf(phys);
    phys.pos.x += nx * pen * 1.01; phys.pos.z += nz * pen * 1.01;                  // x1.01 over-correction (_DAT_00484c44)
    if (px === undefined) { px = phys.pos.x; py = phys.pos.y || 0; pz = phys.pos.z; }
    const vn = phys.vel.x * nx + phys.vel.z * nz;
    if (vn >= 0) return;                                                           // moving away: nothing
    const kn = frameFrac(0.1, opts.dt);
    const Jn = -vn * m * kn;                                                       // normal impulse magnitude (removes 10%/frame of vn)
    let tx = phys.vel.x - vn * nx, tz = phys.vel.z - vn * nz; const tl = Math.hypot(tx, tz);
    const imp = [nx * Jn, 0, nz * Jn];
    if (tl > 1e-6) { const jf = Math.min(0.5 * Jn, tl * m); imp[0] -= (tx / tl) * jf; imp[2] -= (tz / tl) * jf; }
    impulseAt(phys, [px, py, pz], imp);
  }

  // 3D version for the metro tubes (FUN_0041e930 body corner rays): the body is translated along the surface normal by pen*1.01, then the contact impulse
  // (10% of the normal velocity per frame + 0.5 friction) is applied AT THE CORNER (so a hit also turns the car). n, P in three space.
  function resolveContact3D(phys, n, pen, P, opts) {
    opts = opts || {};
    const m = massOf(phys);
    phys.pos.x += n[0] * pen * 1.01; phys.pos.y += n[1] * pen * 1.01; phys.pos.z += n[2] * pen * 1.01;
    const vn = phys.vel.x * n[0] + phys.vel.y * n[1] + phys.vel.z * n[2];
    if (vn >= 0) return;
    const kn = frameFrac(0.1, opts.dt), Jn = -vn * m * kn;
    const tx = phys.vel.x - vn * n[0], ty = phys.vel.y - vn * n[1], tz = phys.vel.z - vn * n[2], tl = Math.hypot(tx, ty, tz);
    const imp = [n[0] * Jn, n[1] * Jn, n[2] * Jn];
    if (tl > 1e-6) { const jf = Math.min(0.5 * Jn, tl * m); imp[0] -= (tx / tl) * jf; imp[1] -= (ty / tl) * jf; imp[2] -= (tz / tl) * jf; }
    impulseAt(phys, P, imp);
  }

  global.YDPhysOrig = { readPar, OrigCarPhysics, resolveCarCollision, resolveWorldContact, resolveContact3D, impulseAt };
})(typeof window !== 'undefined' ? window : globalThis);
