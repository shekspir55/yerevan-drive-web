# City traffic in the original (GAPS.md items 48 and 50)

Source: Ghidra decompile `yd.c` (line numbers below), `extra.c` (FUN_0041b880), disassembly `yd.asm` (float constants and x87 compares),
data in `web/game/yerevan.cit` and `Cars/*/avto.par`. Each claim is tagged **VERIFIED** (read in code or data) or **INFERRED**.
Nothing here was checked against the running game.

Note: GAPS.md item 48 is out of date. Since commit 301d989, the port's traffic cars are already full `OrigCarPhysics` bodies driven by a port of
FUN_0041b880 (sim.js:172-360). The open differences are now the car set, colours, spawn and despawn rules, the lateral lane offset, and network seeding.

## 1. Same class as the player (VERIFIED)

- FUN_0041ac60 (yd.c:20120) builds the world car pool at DAT_004b1240. The player (+0xa3e4 = +0x28f90), **70 traffic slots** (+0x290ac)
  and 7 rival slots (+0x291e0) are all `FUN_004130b0(new 0x2d0, 4)`, so they are the same class.
- Every car is set up by the same FUN_004131d0 (yd.c:15438): type, colour, horn, plate, block list. The callers are FUN_0041a540 (player),
  FUN_0041a630 (traffic, yd.c:19824) and FUN_0041a760 / FUN_0041a830 (rivals and network cars).
- The shared car update FUN_00413480 calls the controller through `car+0x154 -> vtable[1]` at 0x413637, every update, for every car kind.
- Controller vtables (data at 0x484a50..0x484aa8): 0x484a80 is the **traffic controller FUN_0041b880** (made by FUN_0041b720), 0x484a94 is the
  rival FUN_0041c300, and 0x484aa8 is the network copy FUN_0041cce0. 0x484a50 and 0x484a68 are the player's (FUN_0041b330 / FUN_0041b6d0).
- The traffic controller drives with the **same digital input word as the keyboard** (car+0x17c): FUN_00410780 gas 0x80000000
  (ignored if brake 0x40000000 is already set this frame), FUN_004107a0 brake, FUN_004107c0 right 0x10000000, FUN_004107d0 left 0x20000000,
  FUN_004107e0 horn 0x4000000, FUN_004106e0 / FUN_00410730 gear up / down (yd.c ~13470-13560). Wheel physics, mass and inertia come from the
  type, exactly as for the player.

## 2. Which models are traffic: par 0x1b4 (VERIFIED)

- FUN_0040ed20 (car .par loader) copies par 0x1b4 to **type+0x34c** (yd.c:12586; asm 0x40f0d4).
- The only reader of type+0x34c is FUN_00412b30 (car manager DAT_004ab4f0 init, yd.c:15196-15290, asm 0x412d62). It scans `Cars/*` folders
  that have avto.ref, avto.tex and avto.par. If type+0x34c != 0, the type goes into list **+0x94 (count +0x10 = DAT_004ab500)**. Otherwise it
  goes into list **+0x14 (count +0xc = DAT_004ab4fc)**. Both lists are sorted by type+0x28c (= par 0x84 CarID). The asm grep finds no other
  dword read of +0x34c on a car type (0x4367f5 / 0x436cb6 are byte accesses on another object).
- Users of the +0x94 list: FUN_004102b0 (yd.c:13348) `list94[rand() % count]` (random traffic spawn) and FUN_00410420 (index; network seeding).
- Users of the +0x14 list: menu next/prev car FUN_00427040 / FUN_00427090 (yd.c:27463-27500, wrap at DAT_004ab4fc), the config default car
  (yd.c:26921), and random rival cars FUN_00429df0 (yd.c:29510, `rand() % DAT_004ab4fc`). Unregistered builds set DAT_004ab4fc = 1 (yd.c:29785).
- Data: 0x1b4 == 1 on exactly UAZ (id 4531), A190 (15789), Honda (15820), gazel (21745) and Kamaz (50487). It is 0 on the other 12.
  So the **traffic list in order = UAZ, A190, Honda, gazel, Kamaz**. These 5 are never selectable in the menu and never used by rivals.
  (Only `CarID=` in config.ini can still name one, because FUN_004103d0 searches every type.)
- The flagged pars also have par 0x1b8..0x1c4 = 0. The other cars have bytes there that FUN_0040ed20 scales into type+0x3cc..0x3e0 (x0.1 and
  x0.01, yd.c:12600-12605). Meaning: INFERRED (tuning or menu stats). Not needed for traffic.
- **Colour** (VERIFIED): FUN_00410230 (yd.c:13294) returns `palette[rand() % count]`. The palette is carcol.ini at manager+0x8b4, count +0x8b0
  (10 entries). It is picked **per spawned car**.
- **Horn**: FUN_00410270 `horn rand()%3`. **Voice**: FUN_00410290 `traf group rand()%3`. Both are per car (VERIFIED).
- **Plate** (VERIFIED): texture `*(DAT_004ab730+0x60)` (stdhamar material) and index FUN_00410250 = `rand() % *(byte*)(tex+0x1c)`, stored at car
  +0x278/+0x27c by FUN_004131d0. No text string is passed for traffic. INFERRED: traffic shows a stock plate variant, not custom text.

## 3. Pool size and density option (VERIFIED)

FUN_0042a0f0 (yd.c:29669-29683) passes `[Few, Normal, Many] = 10 / 25 / 40` (game param[0x2b8] = SINGLE Traffic). It passes **30** when the game
type param[0x2b7] (+0xadc) > 1. FUN_0041a2e0 (yd.c:19641) stores min(n, 70) at DAT_004b1244 (pool size). FUN_0041a630 walks the pool for a free
slot (car+0xb8 == 0) and does nothing when none is free. There is no "off" setting.
INFERRED game types: 0 = city, 1 = race, 2/3/4 = network city / race / Gogh&Milica (4 is confirmed by the team code in FUN_00429b00).

## 4. Spawning

### Block sets, rebuilt every frame: FUN_00414e40 (yd.c:16327; asm 0x414f00-0x414f5b) (VERIFIED)
For every city block: `d = |blockSphereCentre - cameraEye| - blockRadius` (cameraEye = DAT_004a8164+0x2a48).
- `d <= viewDist` and `d < 400`: block **active** (block+0xe4 = 1, list DAT_004ac0d0).
- Also `d > 250`: block is a **spawn candidate** (list DAT_004ad070, count city+0x1984).
- viewDist (city+0xa58) = **300 / 550 / 850 m** for config ViewDistance 0/1/2 (FUN_00414000, yd.c:15601). With the default ViewDistance=0,
  the candidate ring is 250 < d <= 300 and the active range is d <= 300.
- spec-render.md:51 says "within 250 in a second list". The asm (`fcomp 250; test ah,0x41; jne skip`) shows the second list is d > 250.

### When: FUN_0042a920 (yd.c:30110-30125) (VERIFIED)
Game types 0 (city) and 1 (race) make one attempt **every 5th frame** (`frame % 5 == 0`, param[0x3ed]; type 0 also needs DAT_0049d040, a
constant 1 in .data). Network types 2/3/4 have **no** random spawning.

### One attempt: FUN_00414290 (yd.c:15750; asm 0x4142a6-0x41447a) (VERIFIED)
1. Return if there are no candidate blocks or no traffic types.
2. Pick a block: `B = cand[rand() % n]`. Return if B's car list (block+0x94; holds **every** car whose current block is B, player and rivals
   included, see FUN_004131d0) has **more than 5** cars. So the limit is 6 per block.
3. Pick a path: FUN_00423310(B, 0x80000000) (yd.c:23310) = random path with `flags == 0x80000000` exactly. Return if B has none.
4. Pick a type: FUN_004102b0 (random from the traffic list).
5. Pick a point: FUN_00421510(path, t = rand01 * len * **0.95**) gives the point and the segment direction (it walks into next[0] past the end).
   Then `x += (0.5 - rand01) * 5`, `z += (0.5 - rand01) * 5` (**+-2.5 m jitter**), `y += 1.2`. rand01 = rand() * 3.0518509e-5 (FUN_00405690).
6. Return if any car in B's list is **< 7 m** (3D) from the point.
7. Heading from the direction: `|dx| < 0.01 -> dx = 0.01`; `yaw = dx > 0 ? pi/2 - atan(dz/dx) : -atan(dz/dx) - pi/2` (rotation-Y matrix
   thunk_FUN_0043b1cc).
8. Build the car: FUN_0041a630(pool, B, matrix, path, type, colour, horn, voice, plateTex, plateIdx, despawnable = 1, network = 0), then
   FUN_0041b720.

### Data facts (VERIFIED, yerevan.cit via web/tools/cit.py)
- 0x80000000 = 260 paths in 94 of 209 blocks (up to 11 per block). Width 2-7 m (median 4), length 5-324 m.
- **No dead ends**, and next links go only to 0x80000000 paths, so the traffic network is closed.
- 0x40000000 (120 paths, width 4-14) is used only for Gogh&Milica start spots (FUN_00414690 via FUN_00426e80).
- 0x20000000 (30 paths, width 2, 4 dead ends) is never driven by traffic.

## 5. Controller FUN_0041b720 (init) / FUN_0041b880 (per update) (VERIFIED unless tagged)

Init (yd.c:20578):
- cruise +0x74 = rand01 * **12 + 10** m/s.
- Frame counter +0xb4 = **rand() % 200**, which staggers the 15-frame phase.
- State +0xc0 / +0xc4 / +200 = 0. Pre-chosen next link +0xb8 / +0xbc = 0. +0xcc = despawnable. +0xd0 = voice.
- All targets (+0x78, +0x84, +0x90) = pos + fwd(+0xac) * **3**.

Per update (extra.c):
- **Removal** (extra.c:39): `(block(car+0xb8).active == 0 && despawnable) || pos.y < -50` -> FUN_00410660 (slot freed). Nothing else removes traffic.
- **Reverse mode** (state & 0x8000000): both gear slots = 0 (reverse). timer += dt. After **2.0 s**: slots = 2 and state = 0. Otherwise gas, and
  steer towards the mirrored 40 m point. +0x90 = +0x78.
- **Own gearbox**: `vref = type+0x390 / (ratio[slot] * type+0x3c4) * type+0x338`. Shift up if v > **0.95** vref. Shift down if slot > 2 and
  v < **0.35** vref. Neutral (slot 1) is forced to 2.
- **Every 15th update** (counter % 15 == 0):
  - FUN_00421710 projects the car onto the current path and onto its prev (+0x24) and next (+0x28) paths, and keeps the closest. On a path
    change it uses the pre-chosen next instead if one is set, then picks the next link: `rand() % nNext` if nNext >= 2, else none.
  - FUN_00421870 gives the **8 m** point (+0x84) and the **40 m** point (+0x78). At a path end it follows the chosen or first next link; with
    no next it clamps to the last point.
  - FUN_0041ae80 (yd.c:20247, search length 20 pushed on the stack) finds the car ahead in the own and neighbour blocks.
  - **Lateral offset** (asm 0x41bb97-0x41bdd0; the decompile garbles it):
    - `D = carPos - projPoint` (3D). This is the car's current offset from the centre line, and nothing pulls it back to 0.
    - If a car ahead is < **20 m** away: `W = 1.1 * (halfWidthA + halfWidthB)` (type+0x710 bound +0x28), `S` = the car's horizontal side axis
      (+0x94, 0, +0x9c) normalised. `D -= S * W` if `S . (posB - posA) >= 0`, else `D += S * W`. So the car moves sideways away from the car ahead.
    - Clamp `|D| <= path.width(+0x18) - 1.1 * halfWidthA`. INFERRED: the width is the half-width of the drivable band.
    - Target `+0x90 = point8 + D`.
- **Steering**, every update: `a = asin(side . dirToTarget)` (FUN_00472b90). Steer left if `a < -0.01 && a < steer(+0x180)`. Steer right if
  `a > 0.01 && steer < a`.
- **Reaction to a car ahead**, every update, using the result of the last scan:
  - Horn if `|vA - vB| > 12`.
  - Driver shout if `rand() % 50 == 0 && |vA - vB| > 15`.
  - Brake if `d < 1.3 * (A.box+0x30 + B.box+0x30)`, or if `d < 1.7 * that && |vB| < |vA|` (asm 0x41bfb1-0x41c00d; the slot [esp+0x14] = own speed).
- Brake also if the 40 m point is > **0.3927 rad (22.5 deg)** off the heading (FUN_004724f0 = acos) and v > **7**.
- Gas if v < cruise. Gas is ignored when braking (FUN_00410780).
- **Stuck rule**: v < **1** m/s for **> 2.5 s** -> reverse mode. Any update with v >= 1 resets the timer.
- **After a crash**, nothing special happens: no damage state and no stopping rule. The car keeps its new lateral offset (clamped to the road
  band), brakes or honks only through the car-ahead rule, and reverses only through the stuck rule.

## 6. Network games (VERIFIED, host flag INFERRED)

- FUN_00429b00 (yd.c:29454) calls FUN_004144a0(city, **30**, !host) once at start. It walks the city block list in **file order**: for each block
  with a 0x80000000 path, it projects the block centre onto a random traffic path (FUN_00421410), adds y + 1.0, and builds a car with
  type = trafficList[i % 5], colour = palette[i % count] and plate = i % n. It stops after 30 cars. With this data those are blocks 0-13,
  15-24, 28, 29, 34 and 50-52. Despawnable = 0.
- Non-hosts give these cars the network controller FUN_0041cc60 / FUN_0041cce0.
- The host sends **4 cars per frame**, round robin over the 30 (FUN_00429540, yd.c:29133-29160): pos, velocity, axes, flags, gear, steer.
- No respawn and no distance despawn. Only y < -50 frees a slot.

## 7. Port vs original: differences

| # | Port (file:line) | Original | Tag |
|---|---|---|---|
| 1 | Traffic models 'Vaz 2108','niva','Peugeot','2110','Honda','Nissan','gazel' (game.js:596) | flag 0x1b4 list: UAZ, A190, Honda, gazel, Kamaz | VERIFIED |
| 2 | One colour and one plate per template, picked once per session (game.js:598) | random colour / plate / horn / voice per spawned car | VERIFIED |
| 3 | The 5 traffic models can be picked in the menu (ui-orig.js:491-502) and by random rivals (game.js:537-540) | menu and rivals use only the 12 unflagged cars | VERIFIED |
| 4 | Pool 8 / 16 / 28 (game.js:90) | 10 / 25 / 40, 30 in network | VERIFIED |
| 5 | Spawn: `rand < 3*dt`, up to 40 tries, any path >= 12 m long, 60-200 m from a player, 9 m clear (sim.js:262-274, 351) | every 5th frame, one try, 0x80000000 paths only, blocks 250 < d <= min(view, 400) from the camera, <= 5 cars in the block, 7 m clear, +-2.5 m jitter, +1.2 m | VERIFIED |
| 6 | world.pathLines drops the path flags (world.js:367-372), so traffic also uses 0x40000000 / 0x20000000 paths | 0x80000000 only | VERIFIED |
| 7 | Despawn > 260 m from players, stuck > 30 s out of sight, dead end, metro rule (sim.js:292-293, 355-356) | block inactive (d > min(view, 400)) or y < -50 | VERIFIED |
| 8 | Aims at the path centre line (sim.js:335) | 8 m point + kept lateral offset, +-W away from the car ahead within 20 m, clamped to width - 1.1*wA | VERIFIED |
| 9 | Path switch at the end of the path, projection within +-40 m (sim.js:289-296) | nearest of current/prev/next every 15 updates | VERIFIED |
| 10 | Counter starts at 0 (sim.js:207) | rand() % 200 | VERIFIED |
| 11 | Network: the host spawns near every player and streams all cars at 10 Hz | 30 fixed cars seeded in the first blocks, never despawned, 4 cars per frame | VERIFIED (the port's choice is deliberate) |

These already match: cruise 10 + 12*rand, gear rule 0.95 / 0.35, 15-update scan, 8 / 40 m points, the car-ahead test (20 m, 1.1x), brake
1.3 / 1.7, the 22.5 deg / 7 m/s turn brake, the stuck rule (1 m/s, 2.5 s) with 2 s reverse, horn > 12, shout 1/50 > 15, and full
OrigCarPhysics bodies.

## 8. Porting plan (no code changed here)

1. **Car set** (game.js:596): build the traffic list from `parOrig.flag34c !== 0` and sort it by par id. Filter flagged cars out of the menu list
   (ui-orig.js:502) and out of the rival random pick (game.js:537).
2. **Per-car look**: keep one geometry template per model, but clone the paint material per spawned car with `palette[rand() % 10]`. Pick the
   plate index, horn and voice per car. Watch the extra draw calls: material clones break instancing.
3. **Path classes**: add `flags: pa.flags` to world.pathLines (world.js:372). The traffic spawner and nextPath should use only
   `flags === 0x80000000`.
4. **Block sets**: each frame, compute `d = dist(sphereCentre, cameraEye) - r` from `cit.blocks[b].f[7..10]` (cit.py `block_sphere`). Mark blocks
   active at `d <= min(viewDist, 400)` and candidates at `d > 250`; viewDist comes from settings ViewDistance (300 / 550 / 850). Track each
   car's current block, using the nearest containing block (AABB `f[1..6]`), for the "> 5 cars" and "7 m clear" tests.
5. **Spawner**: one attempt every 5th frame, or a 1/12 s accumulator so the rate does not depend on fps. Follow FUN_00414290 exactly
   (0.95*len, +-2.5 m, +1.2 m, heading formula). Pool 10 / 25 / 40. Despawn only when the car's block is inactive or y < -50. Drop the 260 m,
   30 s and dead-end rules. Keep the metro guard as a port-only rule if needed.
6. **Controller**: start the counter at `rand() % 200`. Replace the centre-line aim with the lateral offset (section 5). Project onto
   current/prev/next paths and keep the closest, with the pre-chosen next override.
7. **Network**: keep the port's host-spawns-near-everyone design (the original seeds only blocks 0-52, which would leave most of the city
   empty), or add an "original" mode: 30 cars from FUN_004144a0 order, never despawned.
8. **Performance**: 25 cars at 250-400 m are mostly tiny. Pair the 10 / 25 / 40 restore with distance culling of the car meshes (beyond
   viewDist) and the existing quality governor.

Confidence: high for sections 1-5 (code, asm compares and constants checked). Medium for path width = half band, the camera-eye source and
plate semantics. Low for the network game-type mapping (INFERRED).
