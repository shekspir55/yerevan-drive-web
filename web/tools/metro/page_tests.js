// metro test scenarios (runs inside the game page after drv.js). Returns { results: [{id, pass, info}] }
const R = []; const ok = (id, pass, info) => R.push({ id, pass: pass === null ? null : !!pass, info });
place(-44, 0, 936, 0); calib();   // steering sign on the open road heading north (heading south the calibration run would drive over the forecourt kerb)
R.push({ id: 'calib_steer_sign', pass: null, info: { SS } });
const doorsBefore = W.movers.map(m => [m.p.x, m.p.y, m.p.z]);
const movedDoors = () => W.movers.filter((m, i) => Math.hypot(m.p.x - doorsBefore[i][0], m.p.z - doorsBefore[i][2]) > 0.5).length;
const lostDoors = () => W.movers.filter((m, i) => m.p.y < doorsBefore[i][1] - 3).length;
const reset = () => { W.movers.forEach((m, i) => { m.p.set(...doorsBefore[i]); m.v.set(0, 0, 0); m.w.set(0, 0, 0); m.q.set(0, 0, 0, 1); m.asleep = true; }); };
const minOf = (log, k) => Math.min(...log.map(e => e[k]));
// T1 enter from the road over the 1 m forecourt kerb (z 926), down the steps, through a door row, into the hall
for (const x of [-58, -44]) {
  reset(); place(x, 0, 933, Math.PI);
  const r = drive([[x, 906, 18], [-51, 899, 12]], 25, { every: 10, stuckT: 3 });
  const e = st(); ok('T1_enter_from_road_x' + x, e.z < 902 && e.y < -2.4, { end: e, stuckAt: r.log.find(l => l.STUCK) || null, doorsMoved: movedDoors(), doorsLost: lostDoors() });
}
// T2 enter from the forecourt floor (y -1, past the kerb): steps under the canopy, doors, hall
for (const x of [-58, -44]) {
  reset(); place(x, -0.9, 922, Math.PI);
  const r = drive([[x, 906, 15], [-51, 899, 12]], 25, { every: 10, stuckT: 3 });
  const e = st(); ok('T2_enter_from_forecourt_x' + x, e.z < 902 && e.y < -2.4, { end: e, stuckAt: r.log.find(l => l.STUCK) || null, doorsMoved: movedDoors(), doorsLost: lostDoors() });
  ok('T3_doors_pushed_not_lost_x' + x, e.z < 902 ? movedDoors() >= 1 && lostDoors() === 0 : null, { doorsMoved: movedDoors(), doorsLost: lostDoors() });
}
// T4 down: hall -> escalator (35 deg) -> corridor -> stairs -> Yeritasardakan platform
{ reset(); place(-51, -2.9, 899, Math.PI);
  const r = drive([[-51, 885, 15], [-51, 862, 15], [-50, 800, 25], [-50, 790, 20], [-35, 772, 15], [-12, 760, 15], [-12, 725, 20]], 60, { every: 30, stuckT: 4 });
  const e = st(); ok('T4_down_to_platform', e.y < -34.5 && e.z < 740, { end: e, reached: r.reached + '/' + r.of }); }
// T5 up: corridor -> escalator -> hall -> door row x -58 -> steps -> out of the forecourt over its sloped west side
{ reset(); place(-50.5, -28.4, 845, 0);
  const r = drive([[-51, 862, 30], [-51, 880, 30], [-51, 896, 25], [-58, 905, 15], [-58, 916, 15], [-58, 921, 12], [-64, 923.5, 12], [-73, 923.5, 15], [-79, 915, 15]], 45, { every: 30, stuckT: 4 });
  const e = st(); ok('T5_up_and_out_west', e.y > -0.3 && e.x < -77, { end: e, reached: r.reached + '/' + r.of, stuckAt: r.log.find(l => l.STUCK) || null }); }
// T6 the tubes: from the Yeritasardakan platform to the far station at 110 km/h
const TA = [[-43.4, 706.7], [-43.4, 656.7], [-72.5, 591.8], [-101.5, 526.9], [-130.5, 462.1], [-159.5, 397.2], [-188.4, 332.4], [-217.4, 267.5], [-246.4, 202.6], [-275.4, 137.8], [-304.4, 72.9], [-333.4, 8], [-362.3, -56.8], [-391.3, -121.7], [-420.3, -186.5], [-438.3, -233.2]];
const TB = [[20.5, 706.9], [20.5, 656.9], [-8.7, 590.2], [-37.9, 523.5], [-67.1, 456.8], [-96.3, 390.1], [-125.4, 323.5], [-154.6, 256.8], [-183.7, 190.2], [-212.9, 123.5], [-242.1, 56.9], [-271.2, -9.8], [-300.4, -76.5], [-329.5, -143.1], [-358.7, -209.8], [-376.7, -256.3]];
for (const [nm, L, x0] of [['A', TA, -43.4], ['B', TB, 20.5]]) {
  place(x0, -39, 745, Math.PI);
  const r = drive(L.map(p => [p[0], p[1], 110]), 70, { every: 60, stuckT: 4, reach: 6 });
  const e = st(); ok('T6_tube_' + nm + '_to_far_station', r.reached === L.length && e.upY > 0.8, { end: e, reached: r.reached + '/' + L.length });
}
// T7 fly out of the tube onto the platform (user: possible in the original). B: northbound at speed, steering released before the bend at z 657 (the car hits the
// outer curved wall, climbs it and comes down on the platform side). A: in the straight part, steer 0.5 s into the outer (-x) wall. Pass = the car ends on the
// platform (y -36.5..-33, between the tubes, z 660..756); 'upright' is reported separately (u.y > 0.8).
const onPlatform = () => P.pos.y > -36.5 && P.pos.y < -33 && P.pos.x < 15.5 && P.pos.x > -39 && P.pos.z > 660 && P.pos.z < 756;
for (const V of [150, 170, 200]) {
  const a = [-37.9, -37.7, 523.5], b = [-8.7, 590.2], yaw = Math.atan2(b[0] - a[0], b[1] - a[2]);
  place(a[0], a[1] + 0.5, a[2], yaw); for (let i = 0; i < 20; i++) sim({ throttle: 0, steer: 0 });
  P.vel.set(Math.sin(yaw) * V / 3.6, 0, Math.cos(yaw) * V / 3.6);
  let climbed = 0; for (let i = 0; i < 480; i++) { sim({ throttle: i < 200 ? 1 : 0, brake: i >= 200 ? 1 : 0, steer: 0 }); if (P._u[1] < 0.3) climbed = 1; }
  const e = st(); ok('T7_fly_out_tube_B_bend_' + V, onPlatform(), { end: e, climbedWall: climbed, upright: e.upY > 0.8 });
}
for (const V of [160, 230]) {
  place(-43.4, -39.5, 665, 0); for (let i = 0; i < 20; i++) sim({ throttle: 0, steer: 0 }); P.vel.set(0, 0, V / 3.6);
  let climbed = 0; for (let i = 0; i < 360; i++) { sim({ throttle: i < 150 ? 1 : 0, brake: i >= 150 ? 1 : 0, steer: i < 30 ? -0.7 * (SS || 1) : 0 }); if (P._u[1] < 0.3) climbed = 1; }
  const e = st(); ok('T7_fly_out_tube_A_outer_wall_' + V, onPlatform(), { end: e, climbedWall: climbed, upright: e.upY > 0.8 });
}
return { results: R };
