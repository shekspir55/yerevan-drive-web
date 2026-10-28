# Race opponent (rival) AI: original `FUN_0041c300` vs the port

Scope: the controller that drives the race opponents in single-player races (GAPS.md #49). Sources:
- `ghidra/yd.c` (Ghidra decompile, line numbers below) and `re/yd.asm` (objdump of `yd_orig.exe`, line numbers below). Both are in the session scratchpad
  `/tmp/claude-1000/-home-ruben-Downloads-YerevanDrive-v1-1/39abd004-3122-41ca-97d8-6770759667bf/scratchpad/`.
- Float constants were read from the exe with `re/pe.py yd_orig.exe f <addr>`.
- The decompile of `FUN_0041c300` is wrong in places. It hides the D3DX calls (`thunk_FUN_00439bf9` = `jmp [0x49d06c]`, the D3DX vector normalise)
  and stack temporaries (`&stack0xffffffa4` is really the speed, and `fVar7` at yd.c:20867 is really 1.1*half width, not the speed). Everything
  below was re-traced in the asm (yd.asm:37097-37796, `0x41c300-0x41cc4e`), and stack offsets were followed through every push.

Tags: **VERIFIED** = read in the code (asm/decompile), with the location given. **INFERRED** = deduced, not read directly.
Nothing here was checked by running the original game.

---------------------------------------------------------------------------------------------------------------------------------------

## 1. Objects and wiring

| What | Where | Tag |
|---|---|---|
| Rival controller class: size 0xd0, vtable `0x484a94` (slot 0 = `0x416d10`, slot 1 = **`FUN_0041c300` update**, slot 3 = `0x41cc50` `return 0`) | yd.c:19903-19910, vtable dump at 0x484a94 | VERIFIED |
| Created by `FUN_0041a760` (7 slots at `game+0x291c4`; car at `+0x291e0`). It calls **`FUN_004131d0`**, the same car init as the player (`FUN_0041a540`, yd.c:19788) and traffic/net (`FUN_0041a830`). It then calls the constructor `FUN_0041c190` | yd.c:19883-19923 | VERIFIED |
| Called from the race setup `FUN_00429df0` once per opponent: start path `DAT_004b0264`, grid matrix `DAT_004b0a80 + i*0x44`, car type, colour, opponent record (`+0x94` -> name, `+0x70` speech) | yd.c:29540-29555 | VERIFIED |
| Hardness: `game+0xaf0` (set by `FUN_00426b80(gameType, nOpp, oppCars, hardness, laps, traffic)`, yd.c:27146-27152; the value comes from `[SINGLE] Hardness`, 0..3, yd.c:26956) | yd.c:29533-29547 | VERIFIED |
| The same physics as the player: the rival is a normal car body (`FUN_004131d0`), and the physics `FUN_00413480` reads the same input flag word `car+0x17c`. The only rival-specific physics value is the torque multiplier `car+0x1dc` (section 6) | yd.c:15438ff, asm 0x41383c-0x413849 | VERIFIED |

### Controller fields (rival object `R`, car `C = R+4`)

| Off | Meaning | Set by | Tag |
|---|---|---|---|
| +0x04 | car | FUN_0041ae10 | VERIFIED |
| +0x08 / +0x14 | car ahead / "car ahead found" flag | FUN_0041ae80 | VERIFIED |
| +0x18 / +0x1c | current path / previous path (lap counter FUN_0041b1f0) | ctor = start path | VERIFIED |
| +0x20 | lap counter (-1 at start) | FUN_0041b1f0, ctor | VERIFIED |
| +0x28 / +0x34 / +0x40 | projection of the car on the path: point / unit tangent of that segment / distance to the path | FUN_00421710 | VERIFIED |
| +0x44 (byte) | **hold**: brake only. 1 at construction, cleared for all racers at GO (`0x4283da`, in FUN_00428460, run when the countdown `game+0xafc` is 0.0), set again when the racer has finished (`0x427dc7`: lap counter == laps) | ctor, asm | VERIFIED |
| +0x48 | earliest game time of the next respawn (cooldown) | FUN_0041b0b0 | VERIFIED |
| +0x74 | `rand01*15 + 10`. **Never read by FUN_0041c300** (no `[esi+0x74]` access in 0x41c300-0x41cc4e) | ctor yd.c:20668 | VERIFIED |
| +0x78 / +0x9c | far point on the route / its unit tangent | FUN_00421870 | VERIFIED |
| +0x84 / +0xa8 | near point on the route / its unit tangent | FUN_00421870 | VERIFIED |
| +0x90 | **steering target** (near point + lateral offset) | FUN_0041c300 | VERIFIED |
| +0xb4 / +0xb8 | chosen next-link index / pre-chosen next path | FUN_0041c300 | VERIFIED |
| +0xbc | opponent record (`+0x70` = speech sound) | ctor | VERIFIED |
| +0xc0 | frame counter, starts at `rand() % 200` (so the rivals do not all re-plan on the same frame) | ctor yd.c:20677 | VERIFIED |
| +0xc4 (byte) | "brake this frame" flag | FUN_0041c300 | VERIFIED |
| +0xc8 | timer (s): stuck timer, and the reverse-mode timer | FUN_0041c300 | VERIFIED |
| +0xcc | mode word: `0x8000000` = reverse mode (it is not the car's handbrake flag) | FUN_0041c300 | VERIFIED |

Car fields used: `+0x14` pos, `+0x3c` velocity, `+0x94` right axis, `+0xa0` up axis (`+0xa4` = up.y), `+0xac` forward axis, `+0x180` wheel
steer angle (rad), `+0x194/+0x198` current/target gear slot (0 = R, 1 = N, 2 = 1st ...), `+0x17c` input flags, `+0x274` car type
(`+0x338` wheel radius, `+0x388` shift time, `+0x390` max engine w, `+0x398` gear count, `+0x39c[]` ratios, `+0x3c4` final drive,
`+0x710` bound box object, whose `+0x28` = half width max.x). VERIFIED (same offsets as spec-physics.md).

Input flags set through the helpers (yd.c:13656-13757, VERIFIED):
gas `FUN_00410780` (`|0x80000000`, **ignored if brake 0x40000000 is already set this frame**), brake `FUN_004107a0` (`0x40000000`),
right `FUN_004107c0` (`0x10000000`), left `FUN_004107d0` (`0x20000000`), horn `FUN_004107e0` (`0x4000000`), shift up `FUN_004106e0`,
shift down `FUN_00410730`. **The handbrake `FUN_004107b0` (`0x8000000`) is never called by the rival** (VERIFIED: no call in the function).

### Route = the .trc ring, with no forks
The track loader (yd.c:16156-16203, VERIFIED) frees the `prev`/`next` link arrays of every route path and sets **nPrev = nNext = 1**
(`+0x1c/+0x1d`). It sets prev = previous seg, next = following seg (the seg after the last is seg 0), and `path+8` = ordinal (seg0 -> n-1, seg k -> k-1).
These are the city's own path objects (`FUN_00423360`), so the rival walks the loop path by path. The random fork choice in FUN_0041c300 (`rand() % nNext`)
therefore never happens in a race: nNext = 1, so `+0xb4 = +0xb8 = 0` (asm 0x41c5b0-0x41c5de). VERIFIED.

Path object (`FUN_00421150`): `+0xc` flags, `+0x10` nPts (u16), `+0x14` length, **`+0x18` width**, `+0x1c` nPrev, `+0x1d` nNext,
`+0x20` pts (xyz), `+0x24` prev[], `+0x28` next[]. The rival uses the width as its lane limit (section 3.3). This confirms that spec-cit-trc.md's "width"
is really a road width.

---------------------------------------------------------------------------------------------------------------------------------------

## 2. Constants (all from the exe; VERIFIED)

| Addr | Value | Use in FUN_0041c300 |
|---|---|---|
| 0x4848d4 | 1.5 | reverse-mode duration (s); respawn cooldown (FUN_0041b0b0) |
| 0x484bf8 / 0x4845a0 | -0.01 / +0.01 | steering dead band (rad) |
| 0x4848a4 | 0.95 | shift up above 0.95 * top speed of the gear |
| 0x484894 | 0.35 | shift down below 0.35 * top speed of the gear |
| 0x484648, 0x484c18 | 0.25, 8.0 | near look-ahead = 0.25*v + 8 m |
| 0x4845dc, 0x484630 | 3.0, 15.0 | far look-ahead = 3*v + 15 m |
| 0x484c14, 0x483314 | 0.75, 10.0 | car-ahead search range = 0.75*v + 10 m (argument of FUN_0041ae80) |
| 0x484c10, 0x483314 | 0.7, 10.0 | avoid the car ahead only if it is closer than 0.7*v + 10 m |
| 0x484be4 | 1.1 | own half width * 1.1 (search width and lane limit) |
| 0x4848a0 | 1.2 | other car's half width * 1.2 (avoidance offset) |
| 0x484c10 | 0.7 | lane limit = 0.7 * path width - 1.1 * own half width |
| 0x484630 | 15.0 | horn / voice when the relative speed to the car ahead is > 15 m/s |
| 0x484c0c | 0.6283185 (pi/5, 36 deg) | corner angle that triggers the brake |
| 0x484c08 | 16.0 | ... only above 16 m/s (57.6 km/h) |
| 0x484c04 | 65.0 | gas only below 65 m/s (234 km/h) |
| 0x48330c | 1.0 | "stuck" if v < 1 m/s; respawn point lifted by 1 m |
| 0x48461c | 0.3 | "stuck" if up.y < 0.3 (on its side or on its roof) |
| 0x483304 | 0.0 | "stuck" if forward . path tangent < 0 (facing backwards) |
| 0x484c00 | 1.4 | stuck time before a reaction (s) |
| 0x484bf4 | 20.0 | respawn at once if more than 20 m from the route |
| 0x483300 | 0.2 | the respawn keeps 20 % of the speed (FUN_0041b0b0) |
| 0x4833c4 | pi/2 | yaw from the direction (FUN_0041b0b0) |
| (FUN_00410650) | 1.2 (0x3f99999a) | blink timer `car+0x1d8` after a respawn |
| 0x3fb33333 / 0x3fe66666 | 1.4 / 1.8 | hardness torque multiplier (section 6) |
| 0x4a8168 / 0x4a8170 | runtime | frame dt / game time |

FUN_0041ae80 internal constants (yd.c:20247-20311, VERIFIED): lateral offset < 1.1*(halfW_A + halfW_B); a hit closer than 10 m always counts;
a hit farther away needs a closing speed > 0.1 m/s and time to impact < 5 s (0x4844a4 = 5.0, 0x48331c = 0.1).

Math helpers (VERIFIED in the asm): `FUN_00472b90` = **asin** (fpatan of x / sqrt((1+x)(1-x)), asm 0x472bc8-0x472bd4);
`FUN_004724f0` = **acos** (the same with fxch, asm 0x472528-0x472536); `0x439c06` = D3DXVec3Normalize(out, in) (stdcall, out pushed last).

---------------------------------------------------------------------------------------------------------------------------------------

## 3. FUN_0041c300, step by step (asm-checked pseudocode)

Called once per frame per rival through vtable slot 1. INFERRED: the call is from the per-frame car loop before the physics step, the same as traffic
(spec-collision-camera A.5). `v = |C.vel|` (3D). `dt` = frame time.

```
update(R):
  C = R.car; if (!C) return
  if (R.hold) { brake(C); return }                                   // countdown and after the finish   (41c314)
  R.frame++
  // ---- 3.1 reverse mode (entered from 3.6) ----------------------------------------------------- 41c333-41c484
  if (R.mode & 0x8000000) {
    C.gearCur = C.gearTgt = 0                                        // reverse slot, no shift delay
    R.t += dt
    if (R.t > 1.5) { C.gearCur = C.gearTgt = 2; R.mode = 0; R.t = 0; return }   // back to 1st gear
    gas(C)
    d = normalize(C.pos - R.far)                                     // pointing AWAY from the far point
    steerTo(asin(dot(d, C.right)))                                   // 3.4 rule
    R.target = R.far
    return
  }
  // ---- 3.2 own gearbox (every frame) ------------------------------------------------------------ 41c485-41c54b
  if (C.gearTgt == 1) C.gearTgt = 2;  if (C.gearCur == 1) C.gearCur = 2       // never neutral
  vref = type.maxW / (type.ratio[C.gearTgt] * type.final) * type.wheelR       // top speed of the target gear
  if (C.gearCur > 1) {
    if (v > 0.95*vref) shiftUp(C)
    else if (C.gearTgt > 2 && v < 0.35*vref) shiftDown(C)
  }
  // ---- 3.3 re-plan every 3rd frame -------------------------------------------------------------- 41c54d-41c868
  if (R.frame % 3 == 0) {
    p = FUN_00421710(R.path, C.pos)            // nearest projection over the current path, its prev[] and its next[] paths
                                               //  -> R.proj, R.projTan, R.projDist, segment index; returns that path
    if (p != R.path) {
      if (R.nextPick) { p = R.nextPick; FUN_00421410(p, C.pos) -> R.proj, R.projTan, R.projDist }   // changed path: take the pre-chosen link
      if (p.nNext >= 2) { R.link = rand() % p.nNext; R.nextPick = p.next[R.link] }               // never in a race (nNext = 1)
      else { R.link = 0; R.nextPick = null }
    }
    R.path = p
    D = C.pos - R.proj                                               // current lateral offset from the centre line (3D)
    R.near, R.nearTan = FUN_00421870(p, from = R.proj, dist = 0.25*v + 8,  R.link)   // along the polyline, into next[link]
    R.far,  R.farTan  = FUN_00421870(p, from = R.proj, dist = 3*v + 15,    R.link)
    myW = 1.1 * type.bound.maxX
    FUN_0041ae80(R, range = 0.75*v + 10)                             // -> R.ahead (+0x14), R.aheadCar (+0x8)
    if (R.ahead) {
      o = R.aheadCar; rel = o.pos - C.pos
      if (|rel| < 0.7*v + 10) {                                      // overtake: move one combined width sideways, away from it
        W  = 1.2*o.type.bound.maxX + myW
        Rh = normalize(C.right.x, 0, C.right.z)
        D  = dot(Rh, rel) >= 0 ? D - W*Rh : D + W*Rh
      }
    }
    lim = 0.7 * p.width - myW                                        // lane limit (can be small on narrow roads)
    if (|D| > lim) D *= lim / |D|
    R.target = R.near + D                                            // +0x90: keeps the current lateral offset, clamped to the lane
  }
  // ---- 3.4 steering (every frame) -------------------------------------------------------------- 41c86b-41c98a
  d = normalize(R.target - C.pos)                                    // 3D
  a = asin(dot(d, C.right))                                          // C.right = raw car axis +0x94
  if (a < -0.01 && C.steer > a) left(C)                              // bang-bang against the current wheel angle +0x180
  if (a >  0.01 && C.steer < a) right(C)
  // ---- 3.5 horn / voice and the corner brake --------------------------------------------------- 41c98a-41cb1c
  R.brakeNow = 0
  if (R.ahead) {
    dv = |C.vel - R.aheadCar.vel|
    if (dv > 15) horn(C)
    if (rand() % 50 == 0 && dv > 15) voice(C, R.opp.speech)          // FUN_00410840 (only if the voice slot is silent)
  }
  df = normalize(R.far - C.pos)                                      // 3D
  if (|acos(dot(df, R.nearTan))| > 0.6283185 && v > 16) R.brakeNow = 1   // the far point is > 36 deg off the road direction at the near point
  if (R.brakeNow) brake(C)
  if (v < 65) gas(C)                                                 // ignored when brake is set (FUN_00410780)
  // ---- 3.6 stuck / off-route ------------------------------------------------------------------- 41cb35-41cc47
  if (v < 1 || C.up.y < 0.3 || dot(R.projTan, C.fwd) < 0) {
    R.t += dt
    if (R.t > 1.4) {
      R.t = 0
      if (R.ahead) { R.mode = 0x8000000; R.brakeNow = 0 }            // something in front: back up for 1.5 s (3.1)
      else respawn(R, R.proj + (0,1,0), R.projTan)                   // FUN_0041b0b0
    }
  } else R.t = 0
  if (R.projDist > 20) respawn(R, R.proj + (0,1,0), R.projTan)       // far off the route: at once (projDist updates every 3rd frame)
```

Notes on 3.3/3.4 (VERIFIED in the asm unless marked):
- The decompile's `fVar7 = path+0x18*0.7 - speed` (yd.c:20867) is wrong. The subtracted value is `[esp+0x18]`, which was overwritten at 0x41c689
  with `1.1*bound.maxX` (it held 0.35*vref before). So the lane limit does **not** depend on speed.
- With no car ahead, the target is `near + clamp(D)`: the rival **does not pull back to the centre line**. It keeps whatever offset it has
  (the grid slot, a push) as long as that offset is within the lane limit. The clamp is what keeps it on the road.
- `FUN_00421870` (yd.c:23648-23748) finds the first segment i where `(from-p[i]).(from-p[i+1]) <= 0` (the last segment if there is none). It walks `dist`
  along the polyline from `from`. If the walk runs past the end, it continues with `FUN_00421510` on `next[link]` (on `next[0]` if `nNext == 1` or
  `link >= nNext`, and so on through further next[0] links). With no next link it returns the last point. Its 6th stack argument (`push 1`) is not used. All distances are 3D.
- `FUN_00421710` (yd.c:23583-23641) = `FUN_00421410` (nearest point over all segments, clamped segment projection `FUN_00405540`, tangent =
  normalize(segment)) on the current path, then on each prev[] and next[] path. It keeps the smallest distance.
- The decompile hides the steering input vector. It is `normalize(target - pos)`, dotted with the raw 3D right axis `+0x94`. In 3.5 the corner test
  dots `normalize(far - pos)` with **R.nearTan (+0xa8)**, not with the car's heading. The asm also builds normalised horizontal forward/right vectors
  (0x41c86b, 0x41c8da, 0x41ca20, 0x41ca89) that are overwritten or never used. These are dead code.

### 3.7 Respawn `FUN_0041b0b0(R, pos, dir)` (yd.c:20318-20359, asm 0x41b0b0-0x41b1e0; VERIFIED)
```
if (R.nextRespawn > time) return                   // 1.5 s cooldown
d = normalize(dir.x, 0, dir.z); yaw = d.x > 0 ? pi/2 - atan(d.z/d.x) : -atan(d.z/d.x) - pi/2
M = RotationY(yaw); M.translation = pos            // upright, on the projection point + 1 m
C.vel = d * (0.2 * |C.vel|)                        // keeps 20 % of the speed, along the road
FUN_0041d300(C, M)                                 // sets the transform; angular velocity +0x48..0x50 is NOT touched
C.blink = 1.2                                      // FUN_00410650: drawn blinking for 1.2 s (spec-render.md)
R.nextRespawn = time + 1.5
```
INFERRED: there is no collision immunity while the car blinks (`car+0x1d8` is only read by the drawing code at 0x410c6d, the physics countdown at 0x413487
and the net packet at 0x4295bb).

---------------------------------------------------------------------------------------------------------------------------------------

## 4. Answers to the task questions

- **Target point:** the projection on the current route path, then 0.25 v + 8 m further along the route (near point). Add the car's current lateral offset,
  clamped to 0.7*width - 1.1*halfWidth, and shifted by (1.2 rO + 1.1 rA) away from a car ahead that is closer than 0.7 v + 10 m.
  This is re-planned every 3rd frame. A far point 3 v + 15 m ahead is used only for braking and for reversing. VERIFIED.
- **Steering:** digital left/right flags. They are set when asin(dir . right) is more than 0.01 rad beyond the current wheel angle (the same rule as traffic
  FUN_0041b880). The physics ramps the wheel at 2 rad/s (FUN_00413480). VERIFIED.
- **Throttle:** digital full gas whenever v < 65 m/s and the car is not braking. There is no partial throttle. VERIFIED.
- **Brake:** digital full brake when the far point is more than 36 deg off the road direction at the near point and v > 16 m/s. There is no other per-corner
  speed limit, no speed table and no curvature formula. The same brake holds the car during the countdown and after it finishes (+0x44). VERIFIED.
- **Handbrake:** never used. VERIFIED.
- **Gears:** its own gearbox. Up above 0.95 * the top speed of the gear, down below 0.35 of it (only above 1st gear). It never selects neutral. Reverse is used only
  in the 1.5 s reverse mode. VERIFIED.
- **Difficulty:** it does **not** change the AI logic. It only scales the engine torque: car+0x1dc = 1.0 / 1.4 / 1.8 for Hardness 0 / 1 / 2.
  The menu labels are "Child / Young / Usta" (menuam.ini [ALL]), and a value of 3 is accepted by the loader but gives 1.0. VERIFIED (yd.c:29533-29547; asm 0x413841 `fmul [esi+0x1dc]`
  is applied only while the gas flag is set). The labels map to 0..2 in menu order (INFERRED).
- **Stuck / off route:** stuck = (v < 1 m/s, or up.y < 0.3, or facing against the route) for more than 1.4 s. If a car is ahead (+0x14), it reverses for 1.5 s.
  If not, it respawns upright on the route projection +1 m, facing along the route, with 20 % of its speed and blinking for 1.2 s. If it is more than 20 m from the route, it respawns at once.
  Respawns have a 1.5 s cooldown. VERIFIED.
- **Same physics as the player:** yes (FUN_004131d0, FUN_00413480). The only difference is the torque multiplier. VERIFIED.
- **Rubber-banding:** none. FUN_0041c300 never reads the player, the positions or the lap counts. `car+0x1dc` is written only at
  0x413264 (init 1.0), 0x429d52 (Gogh & Milica special car 1.8, yd.c:29437) and 0x429faa (rival hardness). VERIFIED (grep of `+0x1dc]` in the asm).
- **Traffic in races:** the route paths are shared with the city network, and their links are rewired into the ring (section 1). So traffic that enters a
  route path also follows the loop. INFERRED consequence.

---------------------------------------------------------------------------------------------------------------------------------------

## 5. Port (web/sim.js:114-144, web/game.js:543, 770, 786) vs the original

| # | Topic | Port | Original | Severity |
|---|---|---|---|---|
| 1 | Difficulty | `skill` = random value in [0.45,0.6] / [0.65,0.8] / [0.85,1.0], so vmax = 26 + 22*skill (game.js:543, sim.js:115) | torque * 1.0 / 1.4 / 1.8; same AI for every rival | high |
| 2 | Top speed | vmax about 36-48 m/s | gas until 65 m/s; in practice limited by the car's power and gearing | high |
| 3 | Corner speed | curvature over 6/35/85 m, `vmax/(1+c*90)`, proportional throttle and brake | single rule: far point (3v+15) > 36 deg off the near tangent and v > 16 -> full brake; otherwise full gas | high |
| 4 | Throttle / brake | analog (`_thr` scales the torque) | digital flags (direct mode) | medium |
| 5 | Steering | pure pursuit on a 2D polyline, look-ahead 6+0.5v, proportional gain 2.6, analog | target = near (0.25v+8) + kept and clamped lateral offset; bang-bang flags with a ±0.01 rad dead band | medium |
| 6 | Lane / offset | always aims at the centre line | keeps its offset, clamped to 0.7*width - 1.1*halfW | medium |
| 7 | Overtaking | none (only collisions) | FUN_0041ae80 range 0.75v+10, sidestep W = 1.2 rO + 1.1 rA if closer than 0.7v+10 | medium |
| 8 | Re-plan rate | every call | target every 3rd frame (start counter rand%200); steering every frame | low |
| 9 | Route model | one concatenated polyline (points < 0.5 m apart are dropped), nearest point search ±70 points in 2D | path objects with width and links; 3D projection over the current, prev and next path | low/medium |
| 10 | Gears | OrigCarPhysics autoShift (the player's rule: down at 0.95 of the lower gear) | own: up > 0.95 vref, down < 0.35 vref, slot set directly in reverse mode | medium |
| 11 | Stuck rule | sp < 1.3 with throttle > 0.5 for 1.4 s -> 1.2 s brake with inverted steer; 3 failures -> respawn | (v<1 or up.y<0.3 or facing backwards) for 1.4 s -> reverse 1.5 s (only if a car is ahead) or else respawn | medium |
| 12 | Off route | > 22 m for 5 s -> respawn | > 20 m -> respawn at once (1.5 s cooldown) | medium |
| 13 | Respawn | 14 m further along the route, speed 0, no blink | at the projection point +1 m, facing along the route, 20 % of the speed kept, blink 1.2 s | medium |
| 14 | Countdown | IDLE input | brake flag held | low |
| 15 | After the finish | keeps racing | +0x44 set: brakes to a stop | medium |
| 16 | Horn / voice | game.js otherHorns / voices (already ported from FUN_0041c300) | same, but the car-ahead result comes from the controller's own FUN_0041ae80 | ok |

---------------------------------------------------------------------------------------------------------------------------------------

## 6. Porting plan (function by function)

All positions are in the port's mirrored space (x' = -x). The rule is symmetric, so reuse the traffic helpers that already have the correct signs
(`Traffic.drive`: `ang`, `steerTo`, `carAhead`, and the `direct` input of OrigCarPhysics).

### 6.1 physics-orig.js: hardness torque multiplier (car+0x1dc)
```
// constructor:  this.torqueMul = 1;                        // car+0x1dc (init 1.0, 0x413264)
// _engine():    if (this._gas) T = this._torque(this._eOmega) * this._thr * this.torqueMul;   // asm 0x413841
```
game.js race setup: `e.phys.torqueMul = [1.0, 1.4, 1.8][opts.hardness] ?? 1.0` (hardness 3 -> 1.0). Remove the `skill` value.
Network: send torqueMul (or the hardness) if rivals are ever simulated remotely. Gogh & Milica: that special car also gets 1.8 (yd.c:29437), which is outside this task.

### 6.2 sim.js: route as path objects (replaces buildRoute for the AI; Race can keep its own polyline)
```
buildRing(world, segs):  for k in segs: P[k] = { pts: mirrored xyz of world.cit.blocks[b].paths[p].pts, width, next: P[(k+1)%n], prev: P[(k-1+n)%n] }
project1(P, x)  -> {pt, tan, dist, seg}   // FUN_00421410: min over segments of |x - clampSeg(p[i],p[i+1],x)| (FUN_00405540), tan = normalize(p[i+1]-p[i])
project(P, x)   -> best of project1 over P, P.prev, P.next, plus the path it came from        // FUN_00421710
walk(P, from, dist) -> {pt, tan}           // FUN_00421870 + FUN_00421510
   i = first seg with dot(from-p[i], from-p[i+1]) <= 0, else last seg
   r = |p[i+1] - from|; if dist <= r: return from + tan_i*dist
   dist -= r; for j>i: if dist <= len_j: return p[j] + tan_j*dist; dist -= len_j
   Q = P.next; while (dist > Q.length && Q.next) { dist -= Q.length; Q = Q.next }   // FUN_00421510 loop
   if dist > Q.length (no next): return Q.last point, tan = last segment direction
   walk inside Q from Q.p[0] as above
```

### 6.3 sim.js: `class RivalDriver` (replaces AIDriver; one `drive()` per stepWorld call = one original frame)
```
constructor(ring, startPath): path = startPath; frame = rand()%200 | 0; t = 0; mode = 0; hold = true; nextRespawn = 0;
                              target = near = far = pos + 3*fwd (ctor 0x41c190); projTan = nearTan = fwd; projDist = 0; ahead = null
drive(e, dt, all, time):
  ph = e.phys; inp = { direct: true, throttle: 0, brake: 0, steer: 0, handbrake: false, shift: 0 }
  if (hold) { inp.brake = 1; return inp }
  frame++; v = ph.vel.length()
  if (mode) {                                         // 3.1
    ph._idxCur = ph._idxTgt = 0; t += dt
    if (t > 1.5) { ph._idxCur = ph._idxTgt = 2; mode = 0; t = 0; return inp }
    inp.throttle = 1; steerTo(inp, ph, ang(ph.pos - far)); target = far; return inp
  }
  if (ph._idxTgt === 1) ph._idxTgt = 2; if (ph._idxCur === 1) ph._idxCur = 2           // 3.2
  vref = par.maxRpm*0.10471976 / (par.ratios[ph._idxTgt]*par.finalDrive) * par.rear.radius
  if (ph._idxCur > 1) { if (v > 0.95*vref) inp.shift = 1; else if (ph._idxTgt > 2 && v < 0.35*vref) inp.shift = -1 }
  if (frame % 3 === 0) {                                                               // 3.3
    pr = project(path, ph.pos); if (pr.path !== path && nextPick) pr = project1(nextPick, ph.pos) (path = nextPick)
    path = pr.path; proj = pr.pt; projTan = pr.tan; projDist = pr.dist
    D = ph.pos - proj
    [near, nearTan] = walk(path, proj, 0.25*v + 8); [far] = walk(path, proj, 3*v + 15)
    myW = 1.1*halfW(ph); ahead = carAhead(ph, all, 0.75*v + 10)          // Traffic.carAhead with the range as a parameter (traffic passes 20)
    if (ahead && |ahead.pos - ph.pos| < 0.7*v + 10) { W = 1.2*halfW(ahead) + myW; Rh = horizontal right; D += (dot(Rh, ahead.pos-ph.pos) >= 0 ? -W : W) * Rh }
    lim = 0.7*path.width - myW; if (|D| > lim) D *= lim/|D|
    target = near + D
  }
  steerTo(inp, ph, ang3(target - ph.pos))                                              // 3.4: asin(normalize3(d) . right), dead band 0.01
  brake = false                                                                        // 3.5 (+0xc4 cleared every frame)
  if (Math.abs(Math.acos(clamp(dot(normalize3(far - ph.pos), nearTan), -1, 1))) > 0.6283185 && v > 16) brake = true
  if (brake) inp.brake = 1; if (v < 65) inp.throttle = 1                               // gasFlag already ignores gas while braking
  e.hornWant = ahead && |ph.vel - ahead.vel| > 15                                      // feed game.js horns and voices instead of its own search
  if (v < 1 || ph.basis.u[1] < 0.3 || dot(projTan, fwd3) < 0) {                        // 3.6
    t += dt; if (t > 1.4) { t = 0; if (ahead) mode = 0x8000000; else respawnAt(e, proj + up1, projTan, time) }
  } else t = 0
  if (projDist > 20) respawnAt(e, proj + up1, projTan, time)
  return inp
respawnAt(e, pos, dir, time):                                                          // 3.7
  if (nextRespawn > time) return
  d = normalize(dir.x, 0, dir.z); ph.pos = pos; ph.yaw = atan2(d.x, d.z); keep = 0.2*ph.vel.length(); ph.vel = d*keep
  ph.basis reset upright; angular velocity unchanged (the original does not touch +0x48); e.blink = 1.2; nextRespawn = time + 1.5
```
In game.js:
- Set `hold = false` for all rivals at GO, and `hold = true` when a rival's `lap >= laps` (0x427dc7).
- Give `drive()` the list `[player, rivals, traffic, remotes]` (FUN_0041ae80 sees every car in the block, the player included).
- Apply `inp.shift` only on the first physics sub-step, the same way as `Traffic.step`.
- Draw the 1.2 s blink with the player's blink code, if it is ported (spec-render.md).
- Keep the NaN safety respawn (`bad()`) as a port-only guard.

### 6.4 Things the original does not have: remove
`vmax`, `skill`, the curvature speed formula, analog throttle and brake, the `fails` counter and its 3-failure respawn, the 22 m / 5 s off-route timer, the 14 m-ahead respawn with zero speed,
the inverted-steer brake reverse, and autoShift for rivals.

---------------------------------------------------------------------------------------------------------------------------------------

## 7. Open points and confidence
- High: the control flow, every constant, the flag helpers, hardness = torque multiplier, the stuck/respawn rules, no rubber-banding (all read in the asm).
- Medium: the exact geometry of `FUN_00421870` on the first segment (it starts from `from`, not from `p[i]`) and the path-switch corner cases. These are read from the decompile only.
- INFERRED: the call rate (once per rendered frame before the physics), the order of the hardness menu labels, no collision immunity while blinking.
- Not checked by running the original exe (the task forbids it). A run would be useful for: corner braking behaviour, how often rivals respawn, and
  whether hardness 1.8 rivals visibly out-accelerate the player.
