// in-page driving helpers (prepended to scenario scripts). The RAF loop is frozen with G.paused; we step the player like game.js stepWorld does.
G.paused = true;
const P = G.phys, W = G.world, FR = 1 / 60;
const wrapA = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
function sim(inp, dt) { dt = dt || FR; const steps = Math.max(1, Math.ceil(dt / 0.008)), h = dt / steps; for (let i = 0; i < steps; i++) { P.step(h, inp); W.collide(P, h); } if (W.updateMovers) W.updateMovers(dt, [P]); YDSim.placeCar(G.player, dt, W); G.t = (G.t || 0) + dt; }
function place(x, y, z, yaw) { P.pos.set(x, y, z); P.vel.set(0, 0, 0); P.yaw = yaw; P.gy = W.ground(x, z, y + 1); P._init = false; P.speed = 0; sim({ throttle: 0, brake: 0, steer: 0 }, FR); }
function st() { const b = P.basis, u = P._u; return { x: +P.pos.x.toFixed(2), y: +P.pos.y.toFixed(2), z: +P.pos.z.toFixed(2), kmh: +(P.speed * 3.6).toFixed(1), v3: +(P.vel.length() * 3.6).toFixed(1), yaw: +P.yaw.toFixed(2), tun: P.tunnel ? 1 : 0, upY: +u[1].toFixed(2), wh: P.wheels.map(w => w.contact ? 1 : 0).join(''), hit: +(P.hitTimer || 0).toFixed(2), gy: +(P.gy || 0).toFixed(2) }; }
// follow waypoints [[x,z,kmh],...] (three space); steering by heading error; returns log + reached index
function steerSign() { return 1; }   // calibrated below
let SS = null;
function calib() { const s = { x: P.pos.x, y: P.pos.y, z: P.pos.z, yaw: P.yaw }; for (let i = 0; i < 60; i++) sim({ throttle: 1, steer: 0 }); const y0 = P.yaw; for (let i = 0; i < 30; i++) sim({ throttle: 0.5, steer: 1 }); SS = Math.sign(wrapA(P.yaw - y0)) || 1; place(s.x, s.y, s.z, s.yaw); return SS; }
function drive(wps, maxT, opt) {
  opt = opt || {}; const log = []; let k = 0, t = 0, stuck = 0, last = null;
  while (t < maxT && k < wps.length) {
    const [tx, tz, vk] = wps[k], dx = tx - P.pos.x, dz = tz - P.pos.z, d = Math.hypot(dx, dz);
    if (d < (opt.reach || 3)) { k++; continue; }
    const want = Math.atan2(dx, dz), err = wrapA(want - P.yaw), spd = P.speed * 3.6;
    const steer = Math.max(-1, Math.min(1, err * 2.5)) * (SS || 1);
    const reverse = opt.reverse; let inp;
    if (!reverse) inp = { throttle: spd < vk ? 1 : 0, brake: spd > vk + 8 ? 1 : 0, steer };
    else inp = { throttle: 0, brake: 1, steer: -steer };
    sim(inp); t += FR;
    if (Math.round(t * 60) % (opt.every || 15) === 0) log.push(Object.assign({ t: +t.toFixed(2), k }, st()));
    if (Math.abs(spd) < 1.5) stuck += FR; else stuck = 0;
    if (stuck > (opt.stuckT || 4)) { log.push(Object.assign({ t: +t.toFixed(2), k, STUCK: 1 }, st())); break; }
    if (P.pos.y < -200) { log.push({ FELL: 1, ...st() }); break; }
  }
  return { reached: k, of: wps.length, t: +t.toFixed(1), log };
}
