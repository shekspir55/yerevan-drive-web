# Yerevan Drive v1.1: car-car collisions, network contacts and cameras (original behaviour + port diff)

Scope: what the original exe does for car-vs-car contacts (player, AI rivals, traffic, network players), how the
network game keeps contacts consistent, and every camera mode. Each part ends with a precise diff against the
port as it was on 2026-10-27. Implementation happens later from this file. No game code was changed.

**Sources (keep for later agents)**
- Full Ghidra C export of the ORIGINAL exe (`Yerevan Drive.exe.orig`, all 2442 functions):
  `/tmp/claude-1000/-home-ruben-Downloads-YerevanDrive-v1-1/39abd004-3122-41ca-97d8-6770759667bf/scratchpad/ghidra/yd.c`
  The Ghidra project is in `.../scratchpad/ghidra/proj` (project `yd`, program `yd_orig.exe`). Scripts are in `.../scratchpad/ghidra/scripts`:
  `ExportC.java` exports everything. `DecompAt.java <out> <addr...>` creates functions at addresses that are reached only through vtables, then decompiles them.
  Extra decompiles made with it: `ghidra/extra.c` (traffic controller `FUN_0041b880`, `FUN_004108f0`), `ghidra/net.c`, `ghidra/net2.c` (DirectPlay handlers).
- Disassembly (objdump, Intel syntax): `.../scratchpad/re/yd.asm`. Constants: `python3 -I .../scratchpad/re/pe.py <exe> f <hexaddr...>`. Import table: `.../scratchpad/re/imports.json`.
  Function extractor: `.../scratchpad/fn.sh <yd.c> FUN_xxxxxxxx`.
  Ghidra loses x87 registers (`unaff_ESI`, `unaff_EBX`), so everything marked EXACT below was checked against the assembly.
- Ground-truth frames from the original (Xvfb :99, 1024x768, G500, race mode): `.../scratchpad/orig-cam/`. The contact sheets are `sheet1..6.png`, see section D.6.

Conventions: D3D space (left-handed, +Y up). Car body members: pos `+0x14`, mass `+0x2c`, inertia `+0x30/34/38` (pitch/yaw/roll), vel `+0x3c`,
body-frame angular velocity `+0x48/4c/50`, axes right `+0x94`, up `+0xa0`, fwd `+0xac`. The port mirrors x (`x' = -x`). All vector formulas below
are mirror-safe except cross products, which `YDPhysOrig.impulseAt` already converts.

---------------------------------------------------------------------------------------------------------------------

## A. Car-vs-car collision in the original (EXACT unless marked)

### A.1 Bodies
- Every car is the same dynamic rigid-body class: the player, the AI rivals, city traffic and network players (vtable `0x4845f0`, per-step update `FUN_00413480`).
  Traffic cars come from a pool of car objects (`FUN_0041a630` → `FUN_004131d0` init). Each gets a controller object that writes the same digital input flags as the keyboard does.
  They are **not kinematic**. They have their own par mass and inertia, they get pushed and spun, and they keep driving with their controller afterwards.
- Body init `FUN_004201b0`: mass and inertia come from the car type (par `0x8c`, `0x90..0x98`).
  The collision box is the **local AABB of the raw vertices of the car's `bound` mesh** (`FUN_0041ff60`: welded vertex list plus `D3DXComputeBoundingBox`).
  It is stored as min `+0x11c/120/124` and max `+0x128/12c/130` (x = right, y = up, z = fwd). The box is not centred and is 3D.
- Per step `FUN_0041d300` writes the 8 world-space box corners to `+0xbc..+0x118` (full 3D orientation, so pitch and roll are included), and their world AABB to `+0x13c/+0x148`.
  Corner index bits: bit0 = +z extent (fwd), bit1 = +y (up), bit2 = +x (right). Corner 0 = min corner.
- `FUN_0041d680(body, d)` translates the body: pos, the 8 corners, the AABB and the hull vertices.

### A.2 When the test runs (`FUN_00413480`, every physics step, after integration and the controller, before the wheels)
1. Query (`FUN_004231c0` → `FUN_00423150/FUN_004230a0`): the car's world AABB grown by `0.3, 1.0, 0.3` (x, y, z; constants `0x48461c`, `0x48330c`).
   This collects every other body in the car's block and in neighbouring blocks whose world AABB overlaps. It reads two lists: `block+0x98` (all cars) and `block+0x8c` (the second rigid-body class `FUN_00420460`, probably movable objects).
2. `FUN_00420330`: for each collected body B, call `FUN_0041f900(A = this car, B)`.
3. So each overlapping pair is handled **from both cars' updates**: A tests B's points in A's box, then later in the same frame B tests A's points in B's box.
   The physics step is the frame split into steps of ≤ 0.02 s (spec-physics §2). At 60 fps that is 1 step per frame, so 1 to 2 resolutions per pair per frame.

### A.3 `FUN_0041f900(A, B)`: detection, separation, impulse (EXACT, from the asm)
```
// 14 test points of B (world space): 8 corners + 6 face centres.
pts = B.corner[0..7]  +  0.5*(B.corner[i]+B.corner[j]) for (i,j) in (0,3),(4,7),(0,5),(2,7),(0,6),(1,7)   // table 0x49ce90
best = 1000; found = false
for p in pts:
    if insideOBB(A, p):                                    // FUN_0041db70: q=p-A.pos; A.min.x<=q.right<=A.max.x, min.z<=q.fwd<=max.z, min.y<=q.up<=max.y
        d = |p - A.pos|                                    // 3D distance to A's centre
        if d < best: best = d; P = p; found = true         // pick the inside point CLOSEST TO A's CENTRE
if !found: return
fracA = mA/(mA+mB)
n = normalize( (B.pos - A.pos) with y = 0 )                // push direction = horizontal centre-to-centre, NOT a contact normal
t = 0.5; while insideOBB(A, P + n*t): t += 0.5             // coarse march out of A's box
s = -0.25; repeat 4: { t += s; s = |s| * (insideOBB(A, P+n*t) ? +0.5 : -0.5) }   // bisection, precision ~3 cm, may end slightly inside
D = n*t                                                    // separation along n
translate(B, +D*fracA)          // B moves mA/(mA+mB)*t  (the lighter car moves more)
translate(A, -D*(1-fracA))      // A moves mB/(mA+mB)*t
P += D*fracA                    // contact point follows B
k  = 0.1 * mA*mB/(mA+mB)        // 0x48331c = 0.1
J  = (A.vel - B.vel) * k        // FULL 3D relative CG velocity (normal + tangential + vertical), applied even when separating
A.vt[7](P, -J, 0.2, B)          // FUN_004108f0
B.vt[7](P, +J, 0.2, A)
```
`FUN_004108f0(P, J, s, other)` → `FUN_0041de20(P, J, s)`:
- **linear: `vel += J / m`, with no scale.** `s` is not applied to the linear part.
- **angular: `omega_body += I⁻¹ · ((P - pos) × (J*s))`** in body axes (pitch about right / `I_pitch`, yaw about up / `I_yaw`, roll about fwd / `I_roll`), with `s = 0.2`.
- then, if the car's crash cooldown `+0x158 == 0`: `FUN_00410880` stores the impact `|J|` (unscaled) in `+0x15c` with the point in `+0x160`, but only when `|J| > 200` (`0x484618`) and it is larger than the value already stored.

Effect per call: `ΔvA = -0.1*(vA-vB)*mB/(mA+mB)` and `ΔvB = +0.1*(vA-vB)*mA/(mA+mB)`. **The relative velocity drops by 10 % per call.**
Momentum is conserved and there is no restitution. With two calls per frame while the cars overlap, it is up to 19 % per frame.
The relative speed falls to about 8 % within 0.4 s. Cars are separated hard by position and feel like a soft, sticky, inelastic contact. Nobody is thrown, and there is no damage or stun.
Spin comes from the contact offset, at a fifth of the linear impulse.

> **Correction to `spec-physics.md` §9.** That section says "about 1 % per frame, impulse scale 0.1". This is wrong: the 0.1 is in `k`, and the 0.2 scale only applies to the angular part.
> It also says "deepest corner defines the push direction (from this car to the other)". In fact the direction is the horizontal centre-to-centre line, and the contact point is the inside point closest to A's centre.
> It says "corners". In fact the test uses 8 corners plus 6 face centres in full 3D.
> Guard needed in a port: if `B.pos` and `A.pos` are on the same vertical, `n = 0` and the march never ends (the original would hang). Skip the contact or use A's right axis.

### A.4 Crash sound and sparks (per car, every car including traffic and remote players; `FUN_00413480` @0x413d67)
```
if cooldown(+0x158) == 0:
    if strength(+0x15c) > 0 and crashBank(DAT_004abb44):
        snd = bank.play(random sample, 3D at point +0x160)       // FUN_00408180(param -1 = random); not chosen by strength
        if snd: s = min(strength, 5000); f = (s-200)/4800;  SetVolume((1-f) * -1000)   // -10 dB .. 0 dB (DirectSound hundredths of dB)
               sparks: FUN_0041a4f0(block, point, -vec) -> 50-entry particle ring
        strength = 0; cooldown = 0.2
else cooldown = max(0, cooldown - dt)
```
The bank's max distance limits it. A sound only plays if the listener is within that distance.

### A.5 What a traffic car does after a hit (controller `FUN_0041b880`, vtable `0x484a80`; constants EXACT, steering helpers APPROX)
It does nothing special about collisions. It is a physics car, so the hit pushes and spins it, and the controller keeps steering it back:
- Cruise speed `+0x74 = rand01*12 + 10` m/s. Every 15 frames it picks a new target point on its path (look-ahead 8 m / 40 m via `FUN_00421870`).
- Steering: the signed angle between the horizontal forward axis and the target direction. Below -0.01 it presses left, above +0.01 it presses right (digital, so the normal steering ramp applies).
- Gas while speed < cruise. Brake (`0x40000000`) when the car ahead (found by `FUN_0041ae80` in the block car list, **including the player**) is closer than `(rA+rB)*1.3`,
  or closer than `*1.7` while its own speed is below a value the decompiler lost (r = bound max.x * 1.1; APPROX for this second condition). It also brakes when the turn angle is > 22.5° (0.3927) and speed > 7 m/s.
- Horn flag `0x4000000` when the relative speed to the car ahead is > 12 m/s. When it is > 15 m/s, there is a 1-in-50 chance per frame of a voice sound (`+0xd0`).
- **Stuck rule:** speed < 1 m/s for > 2.5 s puts it in reverse mode: gear slot 0, gas, steering towards the target, for 2.0 s. Then it goes back to slot 2 (1st gear) and resumes.
- Removed when its block becomes inactive (if flag `+0xcc` is set) or when `pos.y < -50`.

### A.6 Car vs world (for completeness; `spec-physics.md` §9 is right except one detail)
`FUN_0041e7a0` uses the **point velocity at the contact** (`FUN_0041dc70`: v + ω×r), not the CG velocity. It applies `-vn*m*0.1` along n plus 0.5 Coulomb friction, with scale 1.0 (full angular).
`resolveWorldContact` in the port uses the CG velocity and is still unused for street walls (GAPS #34).
Update 2026-10-27 (metro-world): every car now takes world contacts through `world.js bodyContacts` (8 corner rays + steep edges) -> `resolveContact3D`, which uses the point velocity; the 2D wall segments are gone (spec-metro.md §5). `resolveWorldContact` (CG velocity) is only used for the pole/tree/kiosk colliders.

---------------------------------------------------------------------------------------------------------------------

## B. Network model of the original (DirectPlay 8 Peer, TCP/IP; EXACT structure)

- COM `CLSID_DirectPlay8Peer` (`0x493238`). The handler stub is `0x424830` → `DAT_004dbae8->vt[1]` (`FUN_00424890`). `DPN_MSGID_RECEIVE` goes to the game class vtable `0x484f44`, `[9]` = `FUN_0042ae10`.
  Messages start with a u16 type:

| type | size | flags | sender | content |
|---|---|---|---|---|
| 1 | 0x53 | `0x20` NOLOOPBACK, **not guaranteed** | every peer, **every rendered frame** (`FUN_00429540`, called once per frame from the main loop `0x436dcc`) | own car: pos(3), up(3), fwd(3), vel(3), body angular vel(3), input-flag word `+0x17c` (gas/brake/left/right/handbrake/horn + bits 23/22/21 = GM siren state / sound / finished), gear slot (u8), steer `+0x180`, driveline omega `+0x1b8`, blink timer `+0x1d8`, GM float |
| 0xf | 0x142 | `0x20` | **host only** (`DAT_004dd090`), every frame | 4 traffic cars (round robin over the 30 traffic slots, so each car about every 7.5 frames): slot index, pos, up, fwd, vel, angvel, flags, gear, steer, w_drive |
| 2 / 4 / 5 / 0x0a / 0x12 | small | `8` guaranteed | lobby | car choice, start (with a random half of the players flagged as one team), quit, chat, end of game |

- **Receiver** (`FUN_0041cf90` stores the packet; the per-step network controller `FUN_0041cce0`, vtable `0x484aa8`, applies it once). This is used for remote players and, on clients, for traffic:
  ```
  orientation := received (right = up × fwd)                 // snapped
  if |recvPos - pos| < 5.0:  pos += (recvPos - pos) * 0.1    // 10 % blend per packet
  else                       pos  = recvPos                  // snap
  vel := recvVel ; omega := recvOmega ; gear := recvGear ; w_drive, steer, blink := received
  input flags := received flags    // between packets the remote car is SIMULATED by the full local physics with these flags
  ```
- **Contacts:** there are no contact or impulse messages. A remote car (and traffic on clients) is a normal dynamic body in the local block lists.
  So every client runs `FUN_0041f900` between its own car and the remote copy, with the same rule as offline. The push on the remote copy only lasts until the next packet corrects it (velocity snap and 10 % position blend).
  The owner's machine computes the same contact against *its* copy of us. **Each peer is authoritative for its own car, and both sides see the push because both simulate it.**
  On a LAN (original target, 60 packets/s) the two simulations agree closely.
- Traffic in a network game: only the host runs the traffic AI. Clients replace the traffic controllers with network controllers fed by type 0xf.
  On a client, traffic still collides with everyone as a dynamic body, and the host collides the client's remote copy with its traffic. The host's correction wins.

---------------------------------------------------------------------------------------------------------------------

## C. Collision diff: port vs original

Port code: `web/sim.js` `collideBodies` (l.287-336) and `Traffic` (l.172-285); `web/physics-orig.js` `resolveCarCollision` / `impulseAt` (l.438-467);
`web/game.js` `stepWorld` (l.574-600), `addRemote` (l.398-405), traffic setup (l.426-436), `crashSound` (l.295-300, 723); `web/net.js`; `web/car.js` box (l.89-91, 193).

1. **Impulse 10x too soft.** The port uses `k = frameFrac(0.1*0.1)` (1 %/frame). The original removes **10 % per call** (`k = 0.1*mA*mB/(mA+mB)`, linear unscaled).
2. **Angular part 5x too strong relative to linear.** `impulseAt` applies the full J at the point for both. The original applies `J` linear and `0.2*J` angular.
3. **Detection is 2D SAT on yaw only**, with `hw/hl/oz/y0/y1` (`car.js` drops the x offset and the asymmetric min/max).
   The original tests 8 corners + 6 face centres of B in A's 3D OBB (full pitch and roll), from the raw `bound` vertex AABB (min/max kept as is).
   The port's `Box3.setFromObject(parts.bound)` also includes the bound frame's transform; the original uses the raw vertex data.
4. **Push direction.** The port uses the SAT minimum axis. The original uses the horizontal centre-to-centre direction. Penetration in the original is the march-and-bisect exit distance of the chosen point along that direction.
5. **Contact point.** The port uses the deepest rectangle corner at mid height `(a.y+b.y)/2`. The original uses B's inside point (corner or face centre, real 3D height) closest to A's centre, shifted by B's displacement.
6. **One pass per pair.** The port does i<j once. The original resolves A←B and B←A, both each step. The second pass only fires if overlap remains (≤ 3 cm after the bisection).
7. **Traffic is kinematic** (`kin:true`): it follows the path, has `stun = 0.25 s`, and uses a `pushX/pushZ` drift hack (×0.02, clamped ±9, decay 1.6/s).
   Its velocity is restored after the impulse, it never spins, and its mass is a default 1300 kg (no par). In the original, traffic is a full `OrigCarPhysics`-type body with par mass, pushed and spun, and the A.5 controller steers it back and reverses it when stuck.
8. **Kinematic-vs-kinematic pairs are skipped** (`if (a.kin && b.kin) continue`). On the host, network players (kin) and traffic (kin) never collide, so traffic drives through remote players on every screen.
   In the original they collide like any two cars.
9. **Remote players** (`game.js` addRemote) are fake `phys` objects (`kin`, `mass:1300`, no inertia, no angular velocity). `net.updateRemote` overwrites their position every frame, so pushes on them are lost at once, and the local car only receives its mass share of the separation.
   In the original the remote is a dynamic body simulated with the sender's input flags and corrected per packet (B).
10. **Network state** (`net.js sendState`): 20 Hz, `[x,y,z,yaw,steer,speed,pitch,roll,gear,brake]`. Velocity is assumed to lie along the heading, with no up/fwd vectors, no angular velocity and no input flags.
    The original sends at frame rate: pos, up, fwd, vel, ω, flags, gear, steer, w_drive. The receive rule differs too (port: dead reckoning with `k = dt*12` smoothing, snap > 25 m; original: B).
11. **Network traffic** (`sim.js applyRemote/updateRemote`, `game.js` l.596): the host sends all cars at 10 Hz as `[id,ti,x,y,z,yaw,speed,steer,brk]`, and clients show them kinematically.
    The original sends 4 cars per frame with full state, and clients simulate them.
12. **Crash sound** (GAPS #24): the port uses the player's own speed drop per frame (> 2.5 m/s) and picks the sample by strength (`drop/4`), with gain `0.35+drop*0.05`, a 0.25 s cooldown, and only for the player.
    The original uses `|J| > 200`, a random sample, volume `(min(s,5000)-200)/4800` → -10..0 dB, a 3D position at the contact, a 0.2 s cooldown per car, and every car (traffic and remotes included). It also spawns sparks (port: none, GAPS #52).
13. **Rate.** The port resolves per 0.008 s substep with `frameFrac` rescaling to 60 fps. The original applies once per physics step (frame-rate dependent). Keeping the 60 fps normalisation is an acceptable, documented DEVIATION.
14. Height overlap gate (`ya+A.y1 < yb+B.y0`): the original has none beyond the 3D point test and the AABB query (+1 m in y). Replace the gate with the 3D test.

### C.1 Port implementation recipe (original-exact)
1. `car.js`: export `boundMin/boundMax` = AABB of the **raw** `bound` vertices in the car frame (mirror x: swap and negate min.x and max.x). Keep `box` for shadows if needed.
2. `physics-orig.js`: add `collideCarsOrig(A, B, h)` implementing A.3 literally in D3D space (`A._p`, the axes from `A._R` or whatever `OrigCarPhysics` keeps, with world corners recomputed after each integration step).
   Impulse: `k = frameFrac(0.1, h) * mA*mB/(mA+mB)` (normalised to 60 Hz). Linear `vel += J/m`. Angular `ω += I⁻¹(r × 0.2J)`. Change `impulseAt` (or add a variant) to take separate linear and angular scales.
   The guard for `n = 0` is in A.3. Return `|J_unnormalised|` (computed with 0.1, not the frameFrac value) for the sound rule.
3. `sim.js collideBodies`: broad phase = the world AABB of the 8 corners grown by (0.3, 1.0, 0.3). For each overlapping pair call `collideCarsOrig(a,b)` and then `collideCarsOrig(b,a)`. Remove the kin branches, `stun` and `pushX/Z`.
4. Traffic: give each traffic car a real `OrigCarPhysics` (par of its template, `world.collide` like the AI), driven by a port of A.5 that outputs `{throttle, brake, steer, handbrake}` as digital values.
   Keep the path sampling already in `Traffic` for the target point. Cost: about 15-28 more physics bodies. The AI already proves `OrigCarPhysics` is cheap enough; if needed, skip wheel rays for traffic beyond 120 m.
5. Sound: per body, `strength = max(strength, |J|)` if `|J| > 200` and `cooldown == 0`. Each frame, play a random `bum*.wav` at the contact point (PannerNode, bank max distance) with gain `10^(((1-f)*-1000)/2000)`, then cooldown 0.2. Sparks are optional.

### C.2 Network proposal (keeps the original model; works over the internet)
- Make every remote player a real `OrigCarPhysics` body (load its car par as for AI rivals), added to `bodies` with no `kin` flag, plus `world.collide`.
  Between packets, step it with the **received inputs** (throttle, brake, steer, handbrake, gear) exactly like the AI.
- `sendState` at 30 Hz (the original sends every frame; 20 Hz is acceptable if velocities are sent): `pos(3), quat or up+fwd, vel(3), yawRate/ω(3), steer, gear, input bits (gas,brake,left,right,handbrake,horn), w_drive`.
  Server unchanged (it relays `s`).
- On receipt, apply the original rule, extrapolated by the measured one-way lag (DEVIATION for the internet; the original used a LAN):
  `recvPos += recvVel*lag`. Snap orientation, vel and ω. `pos += 0.1*(recvPos-pos)` if the distance is < 5 m, else snap.
  A gentler orientation blend (for example 30 %) is allowed if snapping looks jittery at 20-30 Hz.
- **Contacts need no message:** each client resolves its own car against the remote body with C.1. The remote copy is pushed locally and then corrected by its owner's packets. The owner's client simulates the same contact against its copy of us, so both see a consistent, original-like push.
  Optional improvement for high lag (not in the original): when a client measures `|J| > 200` against a remote car, it sends `{t:'hit', id, J, P}`.
  The owner applies the J only if it has not resolved a contact with that peer within ±0.25 s, so the impulse is never applied twice. Use it for the crash sound in any case.
- Network traffic: the host keeps its AI. It sends full state for traffic (all cars at 10 Hz, or round robin like the original) and adds vel, ω and input bits.
  Clients run traffic as `OrigCarPhysics` bodies stepped with the received inputs and corrected with the same rule. They collide with everyone locally, and the host's next snapshot wins.
  This also fixes item 8 (remote vs traffic on the host), because nothing is kinematic any more.

---------------------------------------------------------------------------------------------------------------------

## D. Cameras in the original (camera object `DAT_004b1188`; EXACT)

Members: mode `+4`, eye `+8`, prevEye `+0x14`, target `+0x20`, up `+0x2c`, velocity `+0x38`, saved copy for free cam `+0x74..+0xa0`, free flag `+0xa4`, followed car `+0xa8`, block `+0xac`.
Projection is the same in every mode: fovY 56.25°, 4:3, near 0.9, far 1000 (spec-render §3).

### D.1 Follow / reset (`FUN_00417240(car)`)
`mode = 0`, `eye = pos - fwd*7 + up*2`, `target = pos + (0, 2, 0)`, `up = car.up`, `vel = car.vel`. It is called at race start, on a new game, and when spectating (D.5).

### D.2 Per-frame update (`FUN_00417ad0`, after physics; dt = frame time)
```
prevEye = eye
if following and not free:
    if C pressed (DAT_004ab128): mode = (mode+1) % 3                                  // FUN_00417610: 0 -> 1 -> 2 -> 0; no skipping
    (L, Lmax, H) = mode==1 ? (8, 12, 2.5) : (5, 8, 2.0)                               // mode 2 also uses the mode-0 values
    eye   += car.vel * (0.5*dt)                                                       // drift with half the car velocity
    target = car.pos + (0, H, 0)                                                      // world Y
    off    = eye - target
    want   = -normalize(car.fwd.x, 0, car.fwd.z) * L
    off   += (want - off) * (0.8*dt)
    len = |off|;  if len > Lmax: off *= Lmax/len;  if len < 3.2: off *= 3.2/len        // both tests use the original len
    eye    = target + off
    up    += ((car.up.x, |car.up.y|, car.up.z) - up) * dt
    // -> the chase eye is updated in EVERY mode, also in mode 2 and while B is held
else (paused / free):                                                                 // orbit
    off = eye - target
    off.x += (9*sin(0.2*T) - off.x) * 0.2*dt;  off.y += (-off.y) * 0.2*dt;  off.z += (9*cos(0.2*T) - off.z) * 0.2*dt   // T = game clock DAT_004a8170
    eye = target + off
// collision (any mode, when the camera is in a block)
for each collision triangle overlapping the box eye ± 1.2:                            // FUN_00422fb0 / FUN_00423020
    d = dist(eye, closestPoint(tri));  if d < 0.96: eye += normalize(eye - closest) * (0.96 - d)
if following and |eye - target| > 3.0:
    dir = normalize(car.pos - eye); ray (FUN_00423270) from eye along dir
    if hit and hit.object != followed car and hit.t < |car.pos - eye|: eye += dir * (hit.t + 1.0)   // jump 1 m past the obstacle
vel = (eye - prevEye) / dt
if following and not free and |vel| > |car.vel|: vel *= 0.05*|car.vel| / |vel|       // only for shake and doppler
```
Steady state at speed v: `|off| = L + 0.5v/0.8`. That reaches Lmax (8 / 12) from about 5 m/s (mode 0) or 6.4 m/s (mode 1), so **at normal speeds the camera sits at Lmax, not at L**.
Frames `orig-cam/r3.png`, `d07.png` and `d08.png` show the car small and far behind at speed. `s_a.png` (mode 0) and `s_c1.png` (mode 1) show it at rest.

### D.3 View (`FUN_00417630`; it does not modify the stored eye or target)
```
if following and not free:
    if B held (DAT_004aaea0 = DIK_B state, any mode):            // look-back = front camera looking at the car
        target = pos + up ;  eye = target + up*C + fwd*D          // C = par[0x1ba]*0.1 (=1.0), D = par[0x1bb]*0.1 (=6.0)  -> 6 m ahead, 2 m up
        viewUp = car.up
    elif mode < 2:                                               // chase
        s = |vel| (capped: if > 70 then 70)
        lookAt(eye, target + (0, s*(1/6000)*(rand-0.5), 0), up)   // vertical shake
    else:                                                        // mode 2 "interior" = hood/roof camera
        eye = pos + up*A + fwd*B ;  target = eye + fwd ; viewUp = car.up    // A = par[0x1b8]*0.1, B = par[0x1b9]*0.1
listener/doppler: FUN_00408670(eye, car.vel, ...)
```
Per-car bytes `par[0x1b8..0x1bb]` (A, B, C, D in m): bmw 1.4/0/1/6, 2110 1.2/0/1/6, CL600 1.2/0.3, G500 1.6/0.5, HUMMER 1.4/0, Nissan 1.2/0, Peugeot 1.2/0.5, TT 1.2/0.3, Toyota 1.4/0, Vaz 2108 1.2/0.2, mits 1.3/0.3, niva 1.2/0 (C/D = 1/6 for all of them).
**A190, Honda, Kamaz, UAZ, gazel are all zero.** For them, mode 2 is `eye = CG` looking forward, and look-back has `eye == target` (degenerate matrix in the original; the port must guard it, for example with C = 1, D = 6).
Bytes `0x1bc/0x1bd` are not camera data (menu preview rotation, ×0.01).
**The car is always drawn**, in mode 2 too. No code reads the camera mode outside the camera functions, and frame `s_c2.png` shows the G500 bonnet, bull bar and roof lamps at the bottom.

### D.4 Free cam (`FUN_004179e0(on)`)
On enable it saves eye, target, up and vel. On disable it restores them exactly.
It is enabled by **pause** (`FUN_00414ba0`: the in-game Esc menu) and by the menu/demo setups. While paused the camera slowly orbits the car at radius 9, at the height of the target: `p1.png`→`p2.png`→`p3.png`, about 4 s apart.
Unpausing snaps back to the saved chase camera (`p4.png`).

### D.5 Spectator (race)
When the player's controller has finished (`+0x44`) and the car speed is < 0.2 m/s, the camera follows (D.1, so mode resets to 0) the first racer that has not finished (see `ghidra/yd.c` l.28105-28128 and l.28320-28337).

### D.6 Ground-truth frames (`.../scratchpad/orig-cam/`)
`sheet3.png`: C cycling at rest: mode 0 → 1 → 2 (hood) → 0 (`s_a`, `s_c1`, `s_c2`, `s_c3`).
`sheet2.png` / `sheet1.png`: B look-back in modes 0, 1 and 2, all identical: a front view 6 m ahead (`c0_lookback`, `c1_lookback`, `c2_lookback`).
`sheet4.png` / `sheet6.png`: chase at speed (car far, Lmax). `d06.png`: the eye passes behind a lamp post with no jump, because poles are not collision triangles.
`sheet5.png`: pause orbit. (In `sheet1` the "c1/c2" frames show no change because a 1-frame `xdotool key` tap is missed by DirectInput; use a press ≥ 0.1 s.)
A traffic collision could not be captured. Steering blind under Xvfb kept hitting walls and no traffic car came into view.

### D.7 Camera diff: port vs original
Port: `web/render-orig.js` `C.CAM` (l.27-28) and `ChaseCamera` (l.217-262); `web/game.js` l.566, 633, 645, 667-696.

1. **Lmax missing.** `ChaseCamera` clamps `len > L` to L (5 / 8). The original clamps to **Lmax = 8 / 12** and pulls towards L. The port camera is far too close at speed. Add `C.CAM.maxLen: [8, 12]`.
2. **Mode 2 stops the chase update.** The port overwrites `this.eye` with the interior eye, so going back to mode 0 restarts the chase from the hood and jumps to minLen 3.2.
   The original keeps updating the chase eye in mode 2 (with mode-0 L/Lmax/H) and computes the interior and look-back eye only for the view. Use separate view variables.
3. **Look-back is wrong in modes 0 and 1.** `game.js` negates `fwd` (l.673), so the smoothed chase swings round to the front, and on release it swings back.
   The original uses one fixed, unsmoothed front camera in **all** modes (`eye = pos + up*(1+C) + fwd*D`, `target = pos + up`), and the chase eye keeps tracking behind, so release is instant. Remove the negation and let `ChaseCamera` apply the look-back in every mode.
4. **The car is hidden in mode 2** (`car.obj.visible = G.view < 2`, l.683). The original always draws it (the hood is visible). Always show it.
5. **Camera collision is missing.** The port only clamps `eye.y >= ground + 0.6`, plus a metro special case that sits 5.5 m behind along the car axes.
   The original pushes a 0.96 m sphere out of the collision triangles (eye ± 1.2 box) and, when the eye is more than 3 m from the target, casts a ray to the car and jumps to `hit + 1 m`.
   `world.rayCast` already exists; a closest-point query against the block collision meshes (or the wall segments for a first version) is still needed. The tunnel special case should then go away.
6. **Camera velocity clamp missing.** The original sets `|vel| = 0.05*|car.vel|` whenever it would exceed the car speed. This affects the shake and future doppler.
7. **No pause orbit.** The port freezes the frame when paused. The original orbits at radius 9 (D.2/D.4) and restores the camera on resume.
8. **No spectator camera** after the player finishes (D.5).
9. **Mode reset:** the original sets mode 0 on every follow (D.1). The port keeps `G.view` (fine within one game; reset it where the original calls follow).
10. **Ad-hoc fallback views** (`game.js` l.684-696: 8+ m back / 3 m up; 16 m back / 7 m up; 0.4 m bumper at 1.25 m) are not original. They only run without `render-orig.js`; remove them or route through `ChaseCamera`.
11. The C key and the pause-menu button already cycle 0..2 like the original. B is held like the original (`DIK_B` state), and the shake formula and up easing already match.
12. Edge: cars with zero camera bytes need the look-back guard from D.3. Without it the port gets `lookAt(eye == target)`, and three.js produces a NaN matrix.

---------------------------------------------------------------------------------------------------------------------

## E. Not determined / approximate
- Exact semantics of the second body list `block+0x8c` (probably movable objects of class `FUN_00420460`). It goes through the same `FUN_0041f900`.
- Traffic controller helpers `FUN_00421710/00421870` (path target selection) and the exact steering angle function `FUN_00472b90` (atan2 / asin of a cross product) are only reconstructed from their call shape.
  The constants in A.5 are EXACT. One braking condition (`< 1.7*` distance with own speed below the decompiler-lost value) is APPROX.
- The sound bank behind `DAT_004abb44` is assumed to be the `bum*.wav` set from `Cars/carstd.snd` (not verified by name). The spark particle type in `FUN_0041a4f0` was not decoded.
- Whether the `bound` frame has a non-identity matrix: the original ignores frame transforms (it uses raw vertex data). Check `car.js` against the raw vertex AABB.
- Bit meanings 23/22/21 of the network flag word (GM siren on/off and a sound, finished flag) and the GM float in type 1 are inferred.
- No ground-truth capture of a car-car collision (D.6); the collision numbers rest on the disassembly alone.
