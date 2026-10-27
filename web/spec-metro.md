# Yerevan Drive v1.1: the metro (Yeritasardakan) — original rules, port diff, fix plan, test

Scope: why a car cannot get into the Yeritasardakan metro in the port, what happens on the stairs, in the tube and at the
doors, what the original does instead, and how to fix it. Diagnosis only: no game file was changed while writing this.
State of the port: working tree of 2026-10-27 (other agents were editing `web/*.js` at the same time, so line numbers can drift; function names are stable).

All coordinates are in **port (three.js) space**: `x' = -x(D3D)`, y up, z as in the CIT file.

**Tools (scratchpad, session only):** `/tmp/claude-1000/-home-ruben-Downloads-YerevanDrive-v1-1/39abd004-3122-41ca-97d8-6770759667bf/scratchpad/metro/`
- `lib.js` loads `web/world.js` `parseCit` in node. Map tools: `top.js` (height map), `side.js`, `slice.js` (true plane cut), `probe.js x,z ...` (every triangle height on a vertical line: F = floor, C = ceiling, s = steep), `walls.js x z r [ylo yhi]` (replays the port's wall-segment rule and lists the segments near a point).
- `run.js <url> <script>` (headless chromium, CDP; profile kept next to the script and deleted on exit; `--mute-audio`) and `drv.js` (in-page helpers: freezes the RAF loop with `G.paused`, then steps the player exactly as `game.js stepWorld` does: `phys.step` + `world.collide` per 8 ms sub-step, `updateMovers`, `YDSim.placeCar`; `place()`, `drive(waypoints)`, `st()`).
- **Automated test: `metro_test.js` + `page_tests.js`** (section 6).
- Extra decompiles made for this file: `metro/gh/mobj.c` (FUN_0041feb0, FUN_00420460, FUN_0041fdf0, FUN_0041e7a0, FUN_0041d8c0, FUN_0041d9b0, FUN_0041d680, FUN_0041e430), made with `ghidra/scripts/DecompAt.java` in `-readOnly` mode.

---------------------------------------------------------------------------------------------------------------------

## 1. Where the metro is (yerevan.cit)

The data holds one metro line with **two stations** joined by **two tubes**.

**Yeritasardakan** is certain: block 107 uses the textures `m_erit1..m_erit4.dds`, and the pavilion block 114 uses `m_erit4`.
The far station's name is not in the data. Its hall (block 106) carries the `m_mutq.dds` signs ('ՄՈՒՏՔ' = entrance).

| Part | Blocks | Where (x', z) | Heights (floor) |
|---|---|---|---|
| Sunken forecourt (square pit) | 114 (+ street 82/86/87/183) | x -77..-13, z 875..926 | -1.0. Sloped on the west, north and east sides (about 6 m long ramps up to street level 0). On the road side (z 926) a vertical kerb 1.0 m (x > -47) or 1.25 m (x -57..-47, top 0.25). |
| Glass pavilion, steps | 114, 107 | x -63..-39, z 885..917; canopy front edge (fascia) at z 916.7, underside y 1.15, top 4.15 | Steps from -1.0 (z 917) down to -3.4 (z 913) in the lanes x ≈ -58 and x ≈ -44 |
| **Doors** (`metdur`, CIT type 2) | 107 | Two rows of 7 at z 911.1..913.3, y -1.87: x -61.5..-54.5 and x -47.8..-40.8 (1.16 m apart). Between the rows (x -53.9..-48.4, z 913.4) is a solid wall. | — |
| Entrance hall | 107 | x -62..-40, z 898..912 | -3.4, ceiling 1.15 |
| Escalator incline (the "stairs") | 107 | x ≈ -55..-47, z 897 → 860 | -3.75 → -28.5 (34.6°) |
| Corridor (bends east at z 790) | 109 | x -55..-45, z 860..790, then to (-30, 770) | -28.9 |
| Steps into the platform hall | 109/110 | z 762..748 at x ≈ -12 | -28.9 → -35.4 |
| Platform hall (vault) and platform | 110 | x -40..+16, z 657..775 | platform -35.4 |
| Tube A (west, along the platform) | 145 | centre x -43.4, z 657..756.8 | floor -40.0, ceiling -25.4; radius about 7.5 m |
| Tube B (east, along the platform) | 112 | centre x 20.5, z 657..756.8 | -40.0 |
| Tube ends at Yeritasardakan | 145/112 | z 756.8 | **closed by an end cap** (a 22-triangle disc in each block) |
| Tube A to the far station | 146,147,...,158 → 111 | (-43.5,656.8) → (-420,-186.5) → (-456.2,-279.8) | -40 → -24.9 |
| Tube B to the far station | 144,143,...,132 → 131 | (20.4,656.8) → (-358.7,-209.8) → (-394.7,-303.1) | -40 → -24.9 |
| Far station platform hall | 113 (+111, 131 tube sections) | x -470..-380, z -330..-180 | platform about -20, tubes -24.9 |
| Far station tube ends | 111 / 131 | z -279.8 (A), z -303.1 (B) | **closed by end caps** (disc, normal along the tube, b111/b131); the flared horn at z -327..-310 (block 113, y -27..-5) is the decorated end of the hall vault, not a tube opening |
| Far station escalator | 129 | z -199 → -150 | -20 → -0.1 |
| Far station entrance hall + doors | 106 | hall y -5.4; 14 doors at (-372.0..-357.1, -126.2..-131.8), y -3.79 | entrances from the street (PROGRESS): ramp (-328, -92..-100), flower-shaped plaza (-355,-106), ramp trench (-348..-340, -132) |

**The port's tunnel/surface split** (`world.js load`, `isTun = bmin < -3.4`): every block whose lowest vertex is below -3.4 m goes into `tunGrid`.
That includes the surface blocks 7, 40, 75-81, 87, 90, 99, 114 (the Yeritasardakan pavilion, bmin = -3.4000001 as float32), 159-162, 171, 179 and 190-192, besides the real metro blocks 106-113 and 129-158.
`inTunnel` is true when y < -2.5 over a `tunGrid` cell. So `phys.tunnel` switches **on in the entrance hall** (CG at -2.97) and **off on the steps**, right at the door line (z ≈ 912.5 in every log).

## 2. What the original does (one rule everywhere)

Car update `FUN_00413480` (asm 0x41394c..0x413ae9):
1. `FUN_004231c0(car.block, aabbMin - (0.3, 1.0, 0.3), aabbMax + (0.3, 0.5, 0.3), self, bodies = 1, 0)` collects:
   - every triangle of the car's current block and of each neighbour block (`dw` list, block+0xec) whose AABB overlaps the box. That covers all render meshes (stride 0x20, `FUN_00422760`) and all collision meshes (`FUN_004229f0`). There is **no slope filter, no up/down filter and no underground flag**.
   - the bodies (cars in block+0x98, movable objects in block+0x8c).
2. `FUN_00420330`: `FUN_0041f900` box-vs-box against every collected body (cars **and doors**).
3. Wheels `FUN_004111c0`: one ray per wheel from the mount point along the car's own **-up** against the collected triangles (`FUN_00423270` → `FUN_0043e235` = D3DXIntersectTri, two-sided). A hit counts if `t < restLen + radius`.
4. `FUN_0041e930(self, 1)`:
   (a) static objects (block+0xb0 list: poles, trees, boxes) through their segment test `FUN_0041d8c0`;
   (b) **8 body-box corners**: a ray from the CG to each corner; if it hits closer than the corner, the body moves by `(len - t)*|d·n|*1.01` along n, then the contact impulse (vtable+0x20 = `FUN_0041e7a0`) is applied at the corner;
   (c) **steep triangle edges** (|edge dir.y| ≥ 0.7, `_DAT_00484c10`) are tested against the car box (`FUN_0041d8c0`). The car is marched out along the separation direction in 0.5 m steps, then 6 bisection steps (±0.25), and gets the contact impulse.
5. The car moves to the block of the first collected triangle (`DAT_004da5e8`).
Gravity is always (0, -9.8, 0). There is no "tunnel mode", no gravity blend and no spin cap.

**Doors and other movable objects** (MObjDef `metdur` params: `0, 100, 100, 100, 100, 0...`):
- Constructor `FUN_00420360`: a rigid body of the same base class as the cars (`FUN_0041d0d0`). Mass +0x2c = **100 kg**, inertia +0x30/34/38 = **100/100/100**. The box and hull come from the sibling frame **`metdur_bound`** (`FUN_00420d60` appends "_bound"; `FUN_0041ff60` welds the vertices and computes the AABB). There is **no hinge**: it is a free body.
- Update `FUN_00420460` (vtable +0x10): `v += (0,-9.8,0)*dt`, integrate (`FUN_0041d1b0`), corners (`FUN_0041d300`), collect (`FUN_004231c0(..., bodies = 1)`), then `FUN_0041f900` against every collected car or object, and `FUN_0041e930(self, 0)`: world contact through the **hull vertices** (rays from the centre to each vertex, same push and impulse as the car corners).
  Sleep: if |v|² < 0.1 and |ω|² < 0.1 for more than 0.5 s, it leaves the active list (`FUN_00407490`).
- Impulse `FUN_0041fdf0` (vtable +0x1c): wakes the body (`FUN_00407440`), applies the impulse (`FUN_0041de20`), and plays a hit sound when |J| > 0.25·mass.
- The car's own update collects the objects too, so car-vs-door is the same `FUN_0041f900` as car-vs-car, from both sides. A 100 kg door against a 2000+ kg car takes about 95 % of the separation, plus `J = 0.1·μ·Δv` per call.

## 3. Repro (headless, port 8171)

Start: `node /home/ruben/Downloads/YerevanDrive_v1.1/server.js 8171`. Page: `http://127.0.0.1:8171/?auto=1&car=G500&traffic=0&opps=0&fixedq=1&at=-44,933,3.14` (the `at=` hook only teleports; the scenarios place the car themselves).
Results (G500, 2026-10-27):

| Case | Result | What stops it |
|---|---|---|
| Road → forecourt, lanes x -58 / -44 (drive south from z 933, about 20 km/h) | **stuck at z 925.4**, front wheels down (`upY` 0.96, gy -0.5), `hitTimer` 0.15 every step | port wall segment from the kerb face: b114, x -57.36..-47.42, z 926.1, y -1.00..0.25 (and the 1.0 m face at x > -47) |
| Forecourt (y -1) → steps → doors, lanes x -58 / -44 | **stuck at z 919.4**, all wheels on the floor | port wall segment from the canopy fascia: b107, z 914.1..916.7, **y 1.15..4.15** |
| Centre lane x -51 | stopped by the wall between the door rows (correct: real geometry) | — |
| Started under the canopy (z 915.5) → doors → hall → escalator → corridor → platform | **passes** (x -58). Doors are thrown aside. One door then fell through the world (y -5487). | — |
| Corridor → escalator up → hall → doors → steps → **out over the west slope** of the forecourt | **passes** (ends at -77.2, +0.3, 917.4) | going up the road-side kerb (1-1.25 m) fails, which is real geometry |
| Tubes A and B from the Yeritasardakan platform at 110 km/h | **pass** (about 1.1 km, upright) | the far tube end caps stop the car (110 → 2 km/h, correct: caps exist in the data) |
| Northbound at 120-230 km/h, autopilot through the bend at z 657 | the car never leaves the floor (`upY` 1). Steered towards the platform it scrapes along the vertical platform face (x -40.7) | — |
| **Exit ("fly out of the tube")**: tube B northbound, steering released before the bend, 150/170/200 km/h | climbs the outer curved wall, rides the tube top upside down (`upY` -1), and at 170/200 km/h lands **on the platform, but on its roof or side** (upY -1 / 0.6). At 150 km/h it drops back into the tube. | see 4.4 |
| Exit: tube A, 0.5 s steer into the outer (-x) wall at 160/230 km/h | climbs, rides the top, **falls back into tube A** at the end cap z 755 | see 4.4 |

## 4. Root causes (with evidence)

**4.1 ENTER, road side: down-steps are walls.** `world.collide` (non-tunnel branch) uses 2D wall segments made from every steep render triangle (`|n.y| < 0.35`, height > 0.6 m) and keeps a segment when it overlaps the band `[gy + 0.3, gy + 2.2]`. Here gy is the **average wheel ground height**.
While all four wheels are on the street (gy 0) the kerb face (y -1.0..0.25) is ignored. Once the front wheels drop (gy -0.5), the band becomes [-0.2, 1.7] and the face counts. The rear circle (z 927.1, R 1.05, distance 1.0) is then pushed back and the velocity into it is cancelled.
The car hangs over the kerb forever. The original has no such segments: its CG-to-corner rays never cross a face that is below and behind the car, so the car simply drops 1 m.

**4.2 ENTER, door lanes: overhangs are walls.** The band reaches 2.2 m above gy whatever the car's height. The canopy fascia starts at 1.15, which is 2.15-2.2 m above the step floor at z 917 (gy -1.0 → band top 1.2 > 1.15). So a roof edge the G500 fits under becomes a wall.
Going up, the band is lower at that point (gy -1.4) and the car passes. That is why "you can come out but not get in".
The original only tests the 8 body-box corners (the real `bound` box) and steep edges against the box, so an overhang above the roof never touches it.

**4.3 The tunnel/surface split puts the mode switch at the door threshold.** `isTun` takes the surface pavilion block 114 and 14 other surface blocks. The y < -2.5 test turns on tube mode in the entrance hall and off on the steps, i.e. at the doors.
The two modes use different contact models:
- wall segments plus a vertical ground sample on the surface;
- ray casts plus corner rays (fixed box: 0.95 x 2.1, bottom only 0.22 m below the CG) in tube mode.
Two smaller problems come with this:
- `ground()` keeps **ceilings** (`groundTris` takes `|n.y| > 0.6` from both sides): the hall ceiling (1.15) and the canopy underside are "ground" to anything within 1.2 m below them. A car placed on the steps under the canopy was snapped onto the roof (y 2.8..7.5, `gy 1.15/4.15`).
- In tube mode the wheel contact is "the nearer of the ray and the vertical ground" (`_wheelPre`), which is a mixture of two rules.

**4.4 EXIT from the tube: where it opens, and why the port lands badly.** Both tube ends at each station are **capped in the data**. The disc caps in b112/b145 at z 756.8 and in b111/b131 at the far station were checked triangle by triangle. The original's corner rays stop the car there too (60 fps, steps ≤ 0.02 s: at 230 km/h the car moves 1.3 m per step, less than its 2.2 m half-length, so it cannot tunnel through).
The **only opening of a tube is its side towards the platform**. At z 657..757 the tube is cut open above y ≈ -36 (cross-section at z 705: tube floor -40, vertical platform face at x -40 / +16 up to -35.4, open up to the tube top at -27, see `sl705.png`). The far station has the same layout (`sl_st2.png`).
So "flying out of the tube" means: at speed the car climbs the outer curved wall, goes over the top and comes down on the platform.
The port allows the climb. On the way it differs from the original in these non-original pieces, which decide whether the car comes out and lands on its wheels:
- `physics-orig.js _simStep`: in tunnel mode pitch and roll are damped (`exp(-1.2 dt)`) and |ω| is **capped at 4 rad/s**. The original has neither. A capped roll rate cannot finish the half-roll that lands it upright.
- `world.js tunnelCollide`: fixed box (hw 0.95, hl 2.1, hh 0.7, bottom -0.22) instead of the car's `bound` box, and no steep-edge test (`FUN_0041e930` part c).
- `_wheelPre`: the "nearer of ray and vertical ground" mixture (the vertical ground sample under a car on the tube top finds the tube floor 14 m below and is clamped by `max(u.y, 0.3)`). Ceilings also count as ground (4.3).
- `YD_ASSIST` (gravity blend, off by default) and `inTunnel(keep)` (y < 6 while tilted): these only exist because of the split.
Whether the original lands upright at a given speed cannot be checked without running it. Test T7 therefore asserts only "ends on the platform" and reports `upright` separately for the user to compare.

**4.5 Doors.** The doors do not block entry (once 4.1 and 4.2 are bypassed, the car drives through either row). The model is not the original's:
- `world.updateMovers` uses two circles per car, a fixed mass 40 (original 100), and a made-up throw (`v = 1.1·v_car + up kick`, random spin).
- It ignores the `metdur_bound` box.
- It has no door-door or door-world contact except a vertical ground lookup with refY = p.y + 0.6. The door origin is at -1.87 and the hall floor at -3.4, so a thrown door sinks 1.5 m into the floor.
- When `ground()` returns null the door falls forever (`gy = p.y - 5`). Observed: door at (-61.5, **-5487**, 898.9).

**4.6 Stairs (the escalator incline, 34.6°).** Up and down both work, with the car upright at 25-30 km/h, and the corridor bend and the steps into the platform hall work too. The only real "can't exit" spot is the road-side kerb (1.0-1.25 m), and the original cannot climb it either.
The way out is the sloped west, north or east side of the forecourt (T5).

## 5. Fix plan (implementation-ready)

**Status 2026-10-27 (metro-world): implemented** (steps 1-8; traffic is no longer kinematic, so it uses the same rule as every car). Notes: the mover box comes from the mesh AABB because mobjects.ref has no `<name>_bound` frames (FUN_00420d60 then falls back to FUN_00420280); movers sleep on their measured frame motion, not on |v|^2 (DEVIATION, see world.js). `metro_test.js` lives in `web/tools/metro/` and calibrates the steering sign on the open road heading north.

Use the original's single rule everywhere and delete the split.

**Performance** (measured on the CIT data; the car AABB grown by 0.3/1.0/0.5 as in the original):
- triangles in the box: street 9, forecourt 17, hall 26, escalator 19, corridor 2, platform 2, tube 8, diagonal tube 43 (worst case seen ≈ 50);
- per car per step: 4 wheel rays + 8 corner rays ≈ 12 × 50 = 600 ray/triangle tests, plus about 150 edge tests;
- player + 7 AI at 125 steps/s → about 0.8 M tests/s, i.e. **≈ 15-30 ms of CPU per second (1.5-3 %)**;
- traffic can keep its current kinematic model.
So the original rule is fast enough for every dynamic car. The triangle query must use a grid and must not allocate per triangle.

1. **`world.js`: collision triangle store** (replaces `groundTris`, `walls` and `tunGrid` for physics).
   - At load, for every block: put all render-mesh triangles (`blk.meshes`, stride 8) and collision-mesh triangles (`blk.colls`, stride 3) in one `Float32Array`, 12 floats per triangle (3 vertices, unit normal, D3D space).
   - Add a 4 m XZ cell index (the existing `camGrid` already does this per block: reuse it and store the normal next to it).
   - New `world.collect(box, out)`: fills a reusable list with the indices of the triangles whose AABB overlaps the box (blocks pre-filtered by bounding sphere, as `camTris` does), no per-triangle allocation.
   - Then `world.rayTris(list, o, d, maxT)` returns the nearest t, the triangle index and its normal (Möller-Trumbore, two-sided, as `rayCast` already does).
   - Remove `isTun`, `tunGrid`, `inTunnel` and `rayCast`. `camTris` can share the store.
2. **`physics-orig.js _wheelPre` (FUN_004111c0):** once per step, collect with the car AABB ± (0.3, 1.0/0.5, 0.3), then cast each wheel ray from the mount `w.M` along `-u` with reach `restLen + radius`.
   - Hit: `L = t - radius`, `w.n = triangle normal`, `groundY` = hit point y (for `_syncOut`/shadow).
   - Delete the vertical `_groundAt` sample and its finite-difference normal, the `max(u[1], 0.3)` division, `this.tunnel`/`tunnelFn`/`rayFn` and the snap-back in `_syncIn`. Keep `_groundAt` only for the reset/teleport placement, and make it take up-facing triangles only.
3. **`world.collide` (FUN_0041e930) for every car:**
   - (a) Keep the round/box object colliders (they stand in for the block+0xb0 segment list).
   - (b) Corner rays: the 8 corners of the car's `bound` box (`car.bnd` min/max, D3D frame) from the CG, `pen = (len - t)*|d·n|*1.01`, then `YDPhysOrig.resolveContact3D` at the corner (already written).
   - (c) Steep-edge test: for each collected triangle edge with |dir.y| ≥ 0.7, cast the edge (vertex A along the unit edge direction, length |AB|) against the 12 box triangles (`FUN_0041d8c0`, table 0x49ce00). On a hit, march the car out along the horizontal line from the edge to the CG (0.5 m steps, then 6 bisections of ±0.25), move it, and apply the contact impulse at the hit point.
   - Delete the 3-circle wall-segment code, the `walls` grid, `tunnelCollide` and the `gy + 0.3 .. gy + 2.2` band.
4. **`physics-orig.js _simStep`:** delete the tunnel pitch/roll damping and the 4 rad/s cap, and the `YD_ASSIST` gravity blend. Gravity is always (0, -9.8, 0).
5. **`physics-orig.js _syncOut` and `sim.js placeCar`:** always publish `basis` and place the mesh from the full 3D attitude. Delete the slope-tilt approximation branch for physics cars. Traffic (kinematic) keeps the ground-height placement.
6. **Movers (`world.updateMovers`), from FUN_00420360/00420460/0041fdf0:**
   - Make each door a small rigid body: `{pos, vel, w, axes}`, mass 100, inertia 100 for all three axes, box from the `<name>_bound` frame of `mobjects.ref` (raw vertex AABB, like `car.bnd`), starting asleep.
   - Each awake step: gravity, integrate, `YDPhysOrig.collideCars(door, car)` and `(car, door)` for nearby cars (the same box/box rule as car-car).
   - World contact: corner rays of the door box through the step 3(b) code.
   - Sleep after 0.5 s with |v|² < 0.1 and |ω|² < 0.1; wake on any impulse. Optional: the hit sound when |J| > 25.
   - Delete the mass-40 circle and throw code and the `p.y - 5` fall.
7. **`game.js` underground look** (sky hidden, dark background): replace `phys.tunnel && y < -2.5` with "a collected triangle is above the CG within 30 m (one upward ray against the store) and y < -2.5".
   **`sim.js` traffic:** keep the "no traffic underground" checks (y < -2). They are a port rule for the traffic spawner, not for contacts.
8. **Camera (`render-orig.js ChaseCamera`)**: route its collision through the same store (spec-collision-camera.md D.7 #5) and delete the tunnel special case in `game.js`.

Order: 1 → 2 → 3 → 4/5 (one change, run `metro_test.js` plus the existing street/race tests) → 6 → 7/8.
If one step at a time is wanted, steps 2 and 3 can first go behind a flag, `?orig3d=1`, with the old path kept until the race tests pass.

## 6. Automated test

`node /tmp/claude-1000/-home-ruben-Downloads-YerevanDrive-v1-1/39abd004-3122-41ca-97d8-6770759667bf/scratchpad/metro/metro_test.js 8171`
(Copy the folder's `metro_test.js`, `page_tests.js` and `drv.js` into `web/tools/` if it should live in the repo; the only absolute path is `ROOT` in `metro_test.js`.)
It starts `server.js` on the port if nothing answers there and stops it by PID afterwards. It runs one headless chromium (profile next to the script, deleted on exit; audio muted), prints `PASS`/`FAIL`/`SKIP` per case, and exits with the number of failures.

| Id | Case | Today |
|---|---|---|
| T1_enter_from_road_x-58 / x-44 | road z 933 → over the kerb → steps → door row → hall (z < 902, y < -2.4) | FAIL (z 925.4, kerb, 4.1) |
| T2_enter_from_forecourt_x-58 / x-44 | forecourt floor z 922 → steps under the canopy → doors → hall | FAIL (z 919.4, canopy, 4.2) |
| T3_doors_pushed_not_lost | after T2: ≥ 1 door moved > 0.5 m, no door more than 3 m below its start | SKIP until T2 passes (the fall-through was seen in the manual run, 4.5) |
| T4_down_to_platform | hall → escalator → corridor → steps → platform (y < -34.5) | PASS |
| T5_up_and_out_west | corridor → escalator up → doors → steps → west slope (y > -0.3, x < -77) | PASS |
| T6_tube_A / B_to_far_station | 110 km/h through each tube, upright, every waypoint | PASS |
| T7_fly_out_tube_B_bend_150/170/200, T7_fly_out_tube_A_outer_wall_160/230 | at speed into the outer tube wall; pass = ends on the platform; `upright` reported | B 170/200 PASS (upside down / on its side); B150 and A FAIL |

After the fix, T1-T6 must pass. For T7 the user decides with the original. Tube B at 170-200 km/h should come out (it already does), and the original probably lands upright more often once the spin cap is gone.
Waypoint helpers: `drive([[x, z, km/h], ...], maxSeconds, { stuckT, reach })` in `drv.js`; a case counts as stuck after `stuckT` s below 1.5 km/h.

## 7. Not determined
- The far station's name (the data has no sign texture with its name; the `ussr*` textures belong to the next street block 99).
- How the original lands after the tube-top loop (needs a capture from the real game, which was not run).
- The class of the block+0xb0 static-object list (virtual +4 returns a segment for `FUN_0041d8c0`). The port keeps its round/box colliders for it.
- Whether doors start asleep (no active-list insert was found in the constructor; they wake on the first impulse in any case).
