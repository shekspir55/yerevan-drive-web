# Yerevan Drive v1.1 – original car physics (reverse engineered)

Source: Ghidra decompile of `Yerevan Drive.exe` (functions named below as `FUN_xxxxxxxx`, addresses are VAs).
Port: `web/physics-orig.js` (`window.YDPhysOrig`). Test: `scratchpad/phys-orig-test.js`.
Legend: **EXACT** = taken from the code/constants; **APPROX** = reconstructed because the decompiler lost the vector maths.

Units: metres, kilograms, seconds, newtons. Direct3D space (left-handed, +Y up, +Z forward, +X right). Gravity 9.8 (`_DAT_0049cec4`).
The web port runs mirrored (x' = -x, yaw' = -yaw); `physics-orig.js` simulates in D3D space internally and converts at its edges.

## 1. Architecture

* One class for **every** car: player, race opponents (AI) and city traffic. Vtable `0x4845f0`: `[4]=FUN_00413480` per-frame update,
  `[5]=FUN_0041e120` apply force at point, `[7]=FUN_004108f0` apply impulse at point, `[8]=FUN_0041e7a0` contact response.
  A *controller* object (`car+0x154`) writes input flags each frame: player = `FUN_0041b330`, AI/traffic = `FUN_0041c300`, `FUN_0041b880`.
  They all drive the same physics through the same digital flags (gas, brake, left, right, handbrake, horn, shift).
* Rigid body base class (`FUN_004201b0`, member offsets): position `+0x14`, mass `+0x2c`, inertia `+0x30/34/38`, linear velocity `+0x3c`,
  angular velocity `+0x48/4c/50` (**body-frame** pitch/yaw/roll rates), 4x4 matrix `+0x54`, axes: right `+0x94`, up `+0xa0`, forward `+0xac`.
* 4 wheels (objects of `FUN_00411090`), each with a parameter block, a spring/damper and slip based tyre forces. No separate axle model.

## 2. Timestep (EXACT)

`FUN_00436cb0`: frame time `ft` is clamped to 0.6 s; if `ft > 0.02` the frame is split into `1 + floor(ft/0.02)` equal steps, otherwise a single
step of `dt = ft` (so physics is **variable-step, never larger than 0.02 s**; typical 1/60). Inside every step the wheel force routine runs
**4 sub-steps of dt/4** (`FUN_00413480`: `iStack_54 = 4`, `dt * 0.25`).

Order inside `FUN_00413480(dt)`:
1. drag + downforce + gravity -> velocity
2. orientation integrated by `omega*dt` (body-frame YawPitchRoll(wy,wx,wz), `M = Rz*Rx*Ry`, new axes = `M * old axes`), position += `v*dt` (`FUN_0041d1b0`)
3. controller writes flags/gear; steering; engine and gearbox
4. world collision queries (`FUN_004231c0`, `FUN_00420330`, `FUN_0041e930`)
5. each wheel: ray cast and suspension length (`FUN_004111c0`)
6. 4 x { driveline omega update; each wheel `FUN_004114c0(dt/4)` which applies forces/impulses to the body }

## 3. Body forces (EXACT)

```
speed = |v|
F_lin  = -par.drag(0x164) * speed * v                   (0.3  ->  0.3*v^2 N)
F_down = -par.downforce(0x168) * speed^2 * up           (10   ->  10*v^2 N pushed into the ground along the body up axis!)
v += (F_lin/m + F_down/m) * dt ;  v.y += -9.8 * dt
```
Force at point (`FUN_0041e120`): `d = P - pos`, `tau = d x F`; `w_pitch += (tau.right /I_pitch)*dt`, `w_yaw += (tau.up / I_yaw)*dt`,
`w_roll += (tau.fwd/I_roll)*dt`, `v += F/m*dt`. No gyroscopic term, no angular damping.
Inertias: `I_pitch=par 0x90`, `I_yaw=par 0x94`, `I_roll=par 0x98` (BMW 2500/2100/1800 kg m^2).

## 4. CAR! par file – field table (offset -> meaning)

Verified through the loader `FUN_0040ed20` (par -> car-type member) and the consumers. All floats unless noted.

| par offset | member | meaning |
|---|---|---|
| 0x04 | name | string (0x1c bytes) |
| 0x84, 0x88 | +0x28c/+0x290 | unknown ints (model id / price?), not used by physics |
| 0x8c | +0x294 | **mass** kg |
| 0x90 / 0x94 / 0x98 | +0x298/29c/2a0 | inertia: pitch (about right) / yaw (about up) / roll (about fwd) |
| 0x9c | +0x2a4 | front axle distance in front of CG (wheel z = +this) |
| 0xa0 | +0x2a8 | front track (wheel x = -/+ half) |
| 0xa4 | +0x2ac | front suspension **rest length** L0 (0.3) |
| 0xa8 | +0x2b0 | front wheel mount height above CG (0.15) |
| 0xac / 0xb0 | +0x2b4/2b8 | front spring k (N/m) / damper c |
| 0xb4 | +0x2bc | front block[0] = 70, **use unknown** |
| 0xb8 | +0x2c0 | front **wheel inertia** (4.1 kg m^2) |
| 0xbc | +0x2c4 | front **wheel radius** (0.4) |
| 0xc0 | +0x2c8 | front tyre friction coefficient **mu** (1.3) |
| 0xc4 | +0x2cc | rear axle distance behind CG (wheel z = -this); also the 0.5*this look-ahead of the contact-velocity sample |
| 0xc8 | +0x2d0 | rear track |
| 0xcc | +0x2d4 | rear rest length L0 |
| 0xd0 | +0x2d8 | rear mount height |
| 0xd4 / 0xd8 | +0x2dc/2e0 | rear spring k / damper c |
| 0xdc | +0x2e4 | rear block[0] (=70, unknown) |
| 0xe0 | +0x2e8 | rear wheel inertia |
| 0xe4 | +0x2ec | rear wheel radius |
| 0xe8 | +0x2f0 | rear mu |
| 0xec | +0x350 | **engine inertia** (0.6) |
| 0xf0 / 0xf4 / 0xf8 | +0x354/358/35c | idle rpm / max rpm (torque = 0 above) / shift-point rpm (stored as rad/s at +0x38c/390/394; used by AI/sound) |
| 0xfc | +0x360 | engine **brake torque** (N m, applied as -torque when off throttle) |
| 0x100 | +0x364 | rev-limiter torque (subtracted at max rpm) |
| 0x104 .. 0x163 | +0x414.. | **torque curve**, 24 floats, entry i = torque (N m) at `rpm = 500*i` (linear interpolation; **old guess in car.js started one entry late**) |
| 0x164 | +0x2f4 | linear-speed drag coefficient (0.3) |
| 0x168 | +0x2f8 | downforce coefficient (10) |
| 0x16c | +0x2fc | same, used when `speed < 0` (never) |
| 0x170 | +0x340 | drive type: 0 = rear wheel drive (wheels 2,3 driven), non-zero = front wheel drive |
| 0x174 | +0x368 | **driveline inertia** (driven wheels + shaft), 20 kg m^2 |
| 0x178 | +0x398 | gear count |
| 0x17c .. 0x1a0 | +0x39c.. | gear ratio table indexed by gear *slot*: 0 = reverse (3.75), 1 = neutral (0), 2..7 = gears 1..6 |
| 0x1a4 | +0x3c4 | **final drive** ratio |
| 0x1a8 | +0x3c8 | **drivetrain efficiency** (0.7) – *not* a wheel diameter as earlier assumed |
| 0x1ac | +0x344 | **maximum steering lock** (rad) |
| 0x1b0 | +0x348 | **brake torque** at each wheel when braking (N m) |
| 0x1b4 | +0x34c | flag (siren/lights?), unused by physics |
| 0x1b8 .. 0x1c4 | +0x36c.. | colour/cosmetic bytes |

Constants not in the par file: wheel brake torque when not braking = 10 N m (`car+0x1a0`), shift delay 0.2 s (`type+0x388`),
default steering ramp 2 rad/s, auto-shift factor 0.95 (`_DAT_004848a4`), engine-follow rate 4 /s (`_DAT_00484834`).

Wheel geometry (EXACT, `type+0x3e4..0x410`): FL `(-frontTrack/2, 0xa8, +0x9c)`, FR `(+frontTrack/2, 0xa8, +0x9c)`,
RL `(-rearTrack/2, 0xd0, -0xc4)`, RR `(+rearTrack/2, 0xd0, -0xc4)`. The model origin is the CG; BMW CG sits 0.48 m above the road at rest.

## 5. Input flags and the controller (EXACT, `FUN_0041b330`, `FUN_004106e0`, `FUN_00410730`)

Digital: gas (flag only if not braking this frame), brake, left, right, handbrake, horn. `Transmission` in `config.ini [MYCAR]` (1 = automatic).

**Automatic** (slot index `idx`; neutral slot 1 is skipped; start in slot 2 = 1st gear):
```
speed   = |v . forward|
vUp     = (wMax / (ratio[idx]   * final)) * R_rear * 0.95        wMax = maxRpm*0.10472 rad/s
vDown   = (wMax / (ratio[idx-1] * final)) * R_rear * 0.95        (ratio of the gear below; idx=0 uses the same)
in forward gear:  Down = brake flag, Up = gas flag
    if speed > vUp             -> shift up   (target slot++, only if slot <= gearCount)
    else if idx > 2 and speed < vDown -> shift down
    if slot == 2 and speed < 4 m/s and Down -> reverse (target = current = 0)
in reverse (target 0): Up = brake flag, Down = gas flag (keys swap!); if speed < 4 and Up -> slot 2
```
A shift sets the *target* slot and starts a 0.2 s timer; the *current* slot changes when the timer expires (the old gear stays engaged meanwhile). No hysteresis, so gears can hunt.
**Manual**: shift up/down keys change the target slot (neutral reachable); Up = gas, Down = brake.

## 6. Steering (EXACT)

```
k      = (speed > 15) ? max(15/speed, 0.3) : 1
lock   = par.maxSteer * k
steer += 2*dt while the right key is held (to +maxSteer), -= 2*dt for left; with no key it returns to 0 at 2 rad/s
steer  = clamp(steer, -lock, +lock)               (speed is |v| of the 3D velocity)
```
Positive steer = right turn in D3D space. Only the front wheels are rotated (`D3DXMatrixRotationY(steer)`), both by the same angle (no Ackermann).

## 7. Engine and gearbox (EXACT, `FUN_00413480`, `FUN_0040f880`)

```
torqueCurve(w):  rpm = w*9.5493 (clamped up to idle); rpm > max -> 0; t = rpm/500; i = floor(t); lerp(tbl[i], tbl[i+1], t-i)
T_eng     = -engineBrake                                   (off throttle)
T_eng     = torqueCurve(w_engine) * throttle               (gas)
w_implied = w_drive * final * ratio[slot]   (x -1 for reverse)
clutch open (slot 1 or handbrake):  w_engine += T_eng / I_engine * dt
clutch closed:                      w_engine += (w_implied - w_engine) * dt * 4
w_engine  = min(w_engine, wMax); at wMax: T_eng -= limiterTorque ;  w_engine >= 0
T_drive   = efficiency * final * T_eng * ratio[slot]   (reverse: negative of ratio[0] term; neutral: 0)
per wheel sub-step (unless handbrake):  w_drive += (dt/4) * T_drive / driveInertia
```
`w_drive` is a single angular speed shared by both driven wheels; the sub-step loop clamps it to >= 0 in forward gears and <= 0 in reverse.
Brake: every wheel gets torque 2000 (par 0x1b0) against its spin when braking, else 10. Handbrake locks the two rear wheels (`w = 0`) and disconnects the driveline.

## 8. Wheels (`FUN_004111c0`, `FUN_004114c0`)

Wheel flags: `0x80000000` front, `0x40000000` rear, `0x20000000` left, `0x10000000` right, `0x8000000` steered, `0x4000000` driven.
Per wheel a block `[w0, I_w, L0, mountY, k, c, R, mu]` (par table above).

**Ray / suspension (EXACT structure, APPROX ground query).** Ray from the mount point along `-up`, length `L0 + R`. Hit at distance `d` -> `L = d - R`,
contact point `P = mount - up*(R + L)`; no hit -> `L = L0` (airborne: only the brake-torque branch runs).
**Spring/damper (EXACT constants).**
`F_s = (L0 - L) * k`, force along the ground normal `n`: `F_s * (up.n) * n`.
`dL = clamp(L - L_prev, -0.05, +0.05)` where `L_prev` is the value of the previous *frame step* (copied once per step, shared by the 4 sub-steps);
`F_d = -(dL * c * 100)` along body up. (So the original damping depends on the frame time; the port normalises to a 60 fps frame.)
**Tyre.** Contact velocity `vc` is sampled at `P + forward * 0.5*rearAxle` (EXACT; looks odd but is in the code).
`rolling = R*w`, slip vector `s = rolling*wheelForward - vc`, `slip = |s| / (max(|rolling|,0.01) + 10)`,
grip factor `g = 1` for `slip <= 0.2`, else `g = max(0.8, 1 - (slip-0.2)*0.4)` (EXACT constants), `F_max = |F_s*(up.n)| * mu * g`.
Longitudinal (APPROX reconstruction of the impulse-limited friction): `dOm = w - (vc.fwd)/R`, torque `T = -sign(dOm)*F_max*R` applied for `t = min(|dOm|*I/(F_max*R), dt/4)`,
`w += T*t/I`, force on the car `Fx = -T/R * t/(dt/4)` along the wheel forward axis. `I` = `I_w` for free wheels, `driveInertia` for driven wheels (writes back to the shared `w_drive`).
Lateral (EXACT shape): `Fy = min(|vc.lat| * m * 0.25 / (dt/4), 1.02 * F_max)` opposing `vc.lat`; i.e. each wheel cancels the sideways velocity of a quarter of the car in one sub-step, capped at `1.02*F_max`.
Total force = spring + damper + `Fx*fwd + Fy*lat`, applied at `P`. Longitudinal and lateral limits are independent (no friction circle).
Consequences: tyres are very grippy (`mu*g` ~1.3, +downforce growing with v^2), cars rarely slide, top speeds are high (BMW ~400 km/h with these numbers).

## 9. Collision response  (**verdict: the original is symmetric and very soft – every car is a dynamic body, mass-weighted, no bounce, nobody is thrown**)

* **Which bodies:** player, AI opponents and traffic are the *same* dynamic class (same `FUN_00413480`). Each car sits in its block's linked list
  (`block+0x94`, car init `FUN_00401470`); `FUN_004231c0` collects every other car whose bounding box overlaps (lists `block+0x98`/`+0x8c`, array `DAT_004da4d0`),
  and `FUN_00420330` calls `FUN_0041f900(car, other)` for each. So player-vs-AI, player-vs-traffic and AI-vs-AI take exactly the same path, each pair is processed from both cars' updates (A tests B's points in A's box, then B tests A's points in B's box; the second pass only acts if overlap is left after the ~3 cm bisection).
  There are **no kinematic cars**. If a car has no block (`car+0xb8 == 0`) its physics is skipped.
* **Car vs car (`FUN_0041f900`; corrected 2026-10-27 from the asm, details in `spec-collision-camera.md` A.3):** the test points of the other car B are its **8 box corners plus 6 face centres**
  in full 3D (pitch and roll included; box = raw `bound` vertex AABB, not centred), tested against this car's 3D OBB (`FUN_0041db70`). The contact point P is the inside point **closest to A's centre**.
  The push direction is **not** a contact normal: it is the horizontal centre-to-centre line `n = normalize(B.pos - A.pos, y = 0)` (guard `n = 0` in a port: the original would loop forever).
  A coarse march (0.5 m steps) plus a 4-step bisection finds the exit distance `t` of P along n; the bodies are moved apart **in proportion to the other's mass**
  (B moves `mA/(mA+mB)*t`, A moves `mB/(mA+mB)*t`: the lighter car moves further) via `FUN_0041d680`, and P follows B. Then
  `J = (vA - vB) * 0.1*mA*mB/(mA+mB)` (full 3D relative CG velocity, applied even when separating) goes to both cars with opposite signs at P (`slot 7`, `FUN_004108f0` -> `FUN_0041de20`, scale 0.2):
  **the linear part is unscaled** (`dvA = -0.1*(vA-vB)*mB/(mA+mB)`, `dvB = +0.1*(vA-vB)*mA/(mA+mB)`), **only the angular part uses 0.2** (`omega += I^-1 (r x 0.2 J)`).
  So **10 % of the relative velocity per call** (up to 19 % per frame with both passes; ~8 % left after 0.4 s), mass weighted, momentum conserved. Masses are the par masses.
  Restitution 0; no velocity clamp, no damage, no stun, no stopping of traffic. (The earlier text here said "deepest corner", "about 1 % per frame" and "scale 0.1": wrong.)
* **Sound/effects only:** `FUN_00410880` records the impact strength when `|J| > 200` (`car+0x15c`) and the point; the update plays a crash sound (strength clamped at 5000, volume `(s-200)/4800`) with a 0.2 s cooldown (`car+0x158`).
* **Car vs static world (`FUN_0041e930`, response `FUN_0041e7a0`):** rays from the car centre to its 8 body corners (`car+0xbc`) are cast against the city triangles (`FUN_00423270`) and static colliders (`DAT_004da548`: poles, trees, kiosks from `block+0xb0`).
  Penetration `pen = (hitDist - cornerDist)`: the car is **pushed out along the surface normal by `pen*(dir.n)*1.01`** (hard position correction, `FUN_0041d680`),
  then `FUN_0041e7a0` at the corner: `vn = v_point . n`; normal force `-(vn)*n*m*0.1` (10% of the normal velocity removed per call), plus tangential Coulomb friction of `0.5 * |normal force|` opposing the tangential velocity; applied with scale 1.0 (`slot 7`). Restitution 0: **no bounce**, speed bleeds off over several frames while the car is held out of the wall.
* **Port:** `YDPhysOrig.collideCars(A, B, h)` implements the car-car rule literally (called from `YDSim.collideBodies` for both orders of every pair; traffic cars are `OrigCarPhysics` bodies, and so are network players' cars and, on network clients, the host's traffic: simulated with the sender's input flags and corrected per packet, `net.js`, spec-collision-camera.md B; no contact message, each peer resolves its own car against the copies);
  `YDPhysOrig.resolveWorldContact(phys, nx, nz, pen, px, py, pz, {dt})` the world rule (fractions are rescaled from "per 60 fps frame" using `dt`). `resolveCarCollision` is the old 2D variant, unused.
  The world response `FUN_0041e7a0` uses the point velocity at the contact (v + w x r); `resolveWorldContact` uses the CG velocity.

## 10. Port interface (`web/physics-orig.js`)

`new YDPhysOrig.OrigCarPhysics(YDPhysOrig.readPar(avtoParBuffer), wheelRadius, {transmission:1, groundFn})` is a drop-in for `YDCar.CarPhysics`:
`step(dt, input)`; fields `pos`, `vel`, `yaw`, `yawRate`, `steer`, `speed`, `gear` (-1 R, 0 N, 1..), `rpm`, `pitch`, `roll`, `slip`, `wheelSpin`, `throttle`, `brake`, `handbrake`, `gy`.
Set `phys.ground = (x3, z3, refY) => world.ground(x3, z3, refY)` (three-space ground height or null) for real terrain; without it the road is flat at `phys.gy`.
`phys.wheels[i] = {compression, omega, contact, slip, load}` (FL, FR, RL, RR) for suspension/wheel-spin visuals; `pitch`/`roll` are the body attitude relative to the ground plane through the wheel contacts (so `sim.js placeCar` slope tilt is not doubled; if you use the original model stop adding the dynamic pitch of `CarPhysics`).
`pos.y` is the real CG height (suspension travel included); world code may keep ignoring it.
Input: `throttle` (analog scales torque), `brake`, `steer` (+ = left, game.js convention), `handbrake`, `shiftUp/shiftDown` (manual only).
External code may move/reset `pos`, `vel`, `yaw` between steps; the port detects teleports and resets spin/gear state.

## 11. Test results (flat road, 60 Hz, `scratchpad/phys-orig-test.js`)

| car | settle (CG / comp F,R) | 0-100 km/h O (arcade) | top O (arcade) | brake 100->0 O (arcade) | turn 50 km/h, input 0.4: radius / lateral g (O) |
|---|---|---|---|---|---|
| BMW 760Li 2000 kg | 0.479 m / 62,78 mm | 5.0 s (4.1) | 399 km/h (281) | 39 m, 0.94 g (42 m) | 17.4 m / 1.13 g |
| Vaz 2108 1720 kg | 0.497 m / 51,54 mm | 5.3 s (4.2) | 327 km/h (269) | 37 m, 0.93 g (37 m) | 15.9 m / 1.24 g |
| Gazel 1720 kg | 0.640 m / 59,62 mm | 15.8 s (13.0) | 179 km/h (166) | 69 m, 0.56 g (70 m) | 17.1 m / 1.13 g |
| Kamaz 4000 kg | 0.624 m / 70,80 mm | 15.4 s (10.2) | 271 km/h (243) | 114 m, 0.35 g (82 m) | 22.2 m / 0.64 g |

Static equilibrium and step-size independence hold (0-100 identical at dt = 1/60 and 0.008). Plausibility: acceleration/braking are in the range of the real cars; **top speeds are optimistic** (BMW ~400 km/h) because
the par torque tables (600 N m up to 7000 rpm) combine with only `0.3*v^2` drag – that is what the data says, not a port error. Full steering lock at speed scrubs speed (front tyres plough) as in the original.

## 12. Not resolved / approximated

* Exact tyre vector algebra of `FUN_004114c0` (x87/vector thunks lost): the force decomposition (impulse-limited longitudinal friction, mass-based lateral force with 1.02*F_max cap) is reconstructed to match the constants and the visible structure; the 1-wheel numbers could differ in detail (APPROX).
* Ground contact: the original ray casts along `-up` against the city triangles and reads a surface flag (`hit+0x1c`) that disables the skid logic for some surfaces and may change grip; the port uses a vertical height query plus a finite-difference normal and ignores surface types.
* Meaning of par `0xb4/0xdc` (=70), `0x84/0x88`, `0x1b4..0x1c4`; the 70 is not read by any code path I found (possibly sound pitch).
* Body-corner vs world collision (`FUN_0041e930`) and static collider tests (`FUN_0041d8c0/9b0`) are described but not ported literally; `resolveWorldContact` implements the response, the caller supplies the contact geometry.
* Skid marks/smoke/sounds/horn/siren (`car+0x1c8`, `0x2a8`, `0x2bc` objects) and the AI/traffic controllers (`FUN_0041c300`, `FUN_0041b880`) were not analysed beyond the fact that they set the same flags.
* DEVIATION: engine-braking torque is faded out below 0.5 m/s (the original applies it at standstill and the car creeps back at ~0.3 km/h); damper normalised to a 60 fps reference; analog throttle/steer inputs are allowed (original is digital).
* Menu modes seen while reading: `Walker` ("Walk on city"), `Gonka` ("Championat"), `GM` ("Gox & Milica", a two-player chase mode with "Busted"/"GOXER WINS"/"MILICANER WINS"); the siren key `M` only works in GM.
