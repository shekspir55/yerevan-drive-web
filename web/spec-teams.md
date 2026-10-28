# Gogh & Milica teams (Goxer = robbers, Milicaner = police): implementation spec

Status tags: **VERIFIED** means read in the decompiled code (`yd.c` = scratchpad `ghidra/yd.c`, `net2.c`, or `re/yd.asm`). **INFERRED** means deduced from how the code uses it, not read directly. Nothing here was seen in the running original game: this task did not run the exe.

## 0. Short answer

- **The original has no team picker.** The player never chooses a team, and neither does the host. When the host presses GO TO CITY, the host's start message (DirectPlay message 4) gives every player a team byte. All players start as police. Then `floor(n/2)` players, picked by `rand()`, become robbers. **VERIFIED** `FUN_0042b4f0` (yd.c 30595-30615).
- So teams are random and balanced: 2 players = 1 robber + 1 cop, 3 = 1 + 2, 4 = 2 + 2, 5 = 2 + 3, ..., 8 = 4 + 4. The host is treated like everyone else. There is no default "first player = robber".
- The teams are drawn again at every start. RESTART (message 5) clears every player's "car chosen" flag. The next GO TO CITY sends a new message 4 with new random teams. **VERIFIED** net2.c case 5 (`*puVar6 = 0`), `FUN_00426e80` on GO TO CITY.
- No screen and no string shows the team before the start. GMCar (0x38, `FUN_004338d0`) and the network screen (0x27, `FUN_004329e0`) have no team control. `Menu/menuam.ini` has no team label: `[GMCHOICECAR]` holds only `ChoiceCar` and `GoToCity`; `[MULTIPLAYER]` holds `GM` = the game-type name. **VERIFIED**
- The team does not restrict the car choice. Any car is allowed, and there are no police-only cars. **VERIFIED**: message 2 (`FUN_0042b2d0`) and `FUN_00429b00` never test the team when they pick the car model.
- Effects of being police (`FUN_00429b00`, yd.c 29433-29439, **VERIFIED**):
  - controller `+0x6c` = 1 (police flag)
  - `+0x6d` = 1 (the siren and light bar are **ON from the spawn**)
  - car `+0x1dc` = 1.8 (`0x3fe66666`), the engine-torque multiplier, so the police car has 1.8x engine torque
  - robbers get `+0x6c` = `+0x6d` = 0, and `+0x1dc` keeps its default of 1.0
- Spawn in Gogh & Milica: not the start grid. Each player goes to a different random city block, placed on a random path of class `0x40000000` in that block, at the point of the path nearest to the block's bounding-sphere centre, 0.5 m up, facing along the path. **VERIFIED** `FUN_00414690`.

The port does it differently:
- `?team=` sets the team, and `server.js:116` makes the first player the robber.
- The server puts robbers first on the grid (`server.js:135`).
- Police get no torque bonus, and the siren starts off.

Section 6 lists the changes.

## 1. Where things happen in the original

| Step | Function | Notes |
|---|---|---|
| Create session (0x27, button 0x2d) | `FUN_00433120` -> `FUN_00426c90` | The game-type list index 0/1/2 becomes `game+0xadc` = 2/3/4 (Walker / Gonka / GM). **VERIFIED** asm 0x4331f4-0x43320d. Max players list "2".."8", **VERIFIED** yd.c 35482-35500 (`FUN_004329e0`). |
| World loads, GMCar 0x38 opens | `FUN_0042a6c0` | GO TO CITY 0x11 is built disabled. **VERIFIED** (PROGRESS.md 83). |
| CHOICE CAR 0x39 | handler `0x433eb0` -> `FUN_00429420` -> `FUN_0042b2d0` = message 2 | **VERIFIED** asm 0x433f1d. Fields: car id, RGBA colour (4 floats = byte/255), plate type byte, plate text. **No team field.** |
| Message 2 received (every peer, sender included) | net2.c case 2 -> info `+0` = 1 (chosen), `+8` car, `+0x10..0x1c` colour, `+0x20` plate type, `+0x21` plate text; then `FUN_00426f00` | `FUN_00426f00` runs on the host (`DAT_004dd090 != 0`). It enables GO TO CITY when **some other player** (not the one who just chose) has also chosen, which means at least 2 players have a car. **VERIFIED** yd.c 27381-27393. Loopback: SendTo flag 8 = DPNSEND_GUARANTEED, and NOLOOPBACK is not set (**INFERRED** from the DirectPlay 8 constants), so the sender also gets its own message 2. |
| GO TO CITY 0x11 (host) | handler `0x433eb0` -> `FUN_00426e80` | **VERIFIED** asm 0x433f37. Sets `game+0 = rand()%28` (sent along; INFERRED: a sky or time-of-day index). When `game+0xadc == 4`, it calls `FUN_00414690` to get 8 random spawns, then `FUN_0042b4f0` (message 4). |
| Message 4 built and sent | `FUN_0042b4f0` (yd.c 30520-30631) | See section 2. |
| Message 4 received (every included player) | net2.c case 4 -> per record: info `+0x3c` order, `+0x40` spawn index, `+0x44..0x83` spawn matrix, **`+0x84` team byte**; then `FUN_00429b00` | **VERIFIED** net2.c 54-96. |
| Cars created | `FUN_00429b00` (yd.c 29354-29458) | Type 4: spawn = `DAT_004b0284[info+0x40]` (the block) + matrix `info+0x44`. Other types: city grid slot `DAT_004b0a80[order*0x11]`. Team flags are set only when type == 4. **VERIFIED** |
| In play | `FUN_0041b330` (the M key toggles `+0x6d` only if `+0x6c`, yd.c 20448-20451); `FUN_00429540` state packet type 1 sends flag bits `0x800000` = `+0x6c`, `0x400000` = `+0x6d`, `0x200000` = `+0x44` (busted) and the meter `+0x70` (yd.c 29114-29127); the receiver `FUN_0041cce0` copies them back (yd.c 21076-21080) | **VERIFIED**. So the team is also carried in every state packet. |
| Rules / end | `FUN_00427fc0` (busts, host-only end via message 0x12), `FUN_00427690` (robber meter bar), `FUN_00427790` (HUD clock) | Robbers = `+0x6c == 0`. No cops or all cops `+0x44` or clock at 0 -> GWin (0). No robbers or all robbers busted -> MWin (1). **VERIFIED** yd.c 28170-28343. |

## 2. Message 4 (start), sent by the host

`FUN_0042b4f0(net, p1 = rand()%28, p2 = game+0xae8 (laps), spawns*, spawnIdx*)`. The total size is 0x3ee = 1006 bytes. It is sent **once to each included player's dpnid** (a loop over the records, `SendTo(record.dpnid, ..., flags 8)`), and the host is one of them. **VERIFIED** yd.c 30617-30628.

| Offset | Size | Field |
|---|---|---|
| 0x000 | u16 | id = 4 |
| 0x002 | u32 | n = number of included players (those with info `+0` != 0, i.e. CHOICE CAR done) |
| 0x006 | 8 x 0x7c | records, in the order of the host's player list (`net+0x54`) |
| 0x3e6 | u32 | p1 = `rand()%28` (the receiver writes it to `game+0`) |
| 0x3ea | u32 | p2 = laps (the receiver writes it to `game+0xae8`) |

Record (0x7c bytes):

| Off | Size | Field |
|---|---|---|
| +0x00 | u32 | dpnid |
| +0x04 | u32 | car id (info +8) |
| +0x08 | 4 x f32 | colour RGBA (info +0x10..+0x1c) |
| +0x18 | u8 | plate type |
| +0x19 | char[] | plate text |
| +0x31 | u8 | order index i (0..n-1) |
| +0x34 | u32 | spawn index = block number (GM only) |
| +0x38 | f32[16] | spawn matrix (GM only) |
| **+0x78** | **u8** | **team: 1 = police (Milicaner), 0 = robber (Goxer)** |

Team draw (**VERIFIED** yd.c 30595-30615):

```
for i in 0..n-1: rec[i].team = 1
k = 0
while k != floor(n/2):
    j = rand() % n
    if rec[j].team == 1: rec[j].team = 0; k++
```

The team byte is written for every game type, but only type 4 uses it (`FUN_00429b00`). With n = 1 no robber exists, and `FUN_00427fc0` ends the game at once with MWin. GO TO CITY normally needs at least 2 chosen players (`FUN_00426f00`), so this case should not come up.

Players who have not pressed CHOICE CAR are left out of the records and get no message 4 (**VERIFIED**: the `*piVar9 != 0` test, yd.c 30560). INFERRED: they stay on GMCar with no car for that round.

## 3. What the team changes

| Effect | Police (team 1) | Robber (team 0) | Source |
|---|---|---|---|
| ctrl `+0x6c` | 1 | 0 | `FUN_00429b00` 29434 VERIFIED |
| siren / light bar `+0x6d` at spawn | **1 (on)** | 0 | 29435 VERIFIED |
| car `+0x1dc` engine torque multiplier | **1.8** | 1.0 (default, ctor yd.c 15464) | 29437 VERIFIED. Use: asm 0x413832-0x413849 (`FUN_00413480`). While the gas bit (bit 31 of `+0x17c`) is set, `+0x1c4 = FUN_0040f880(rpm) * [+0x1dc]`. Engine braking is not scaled. VERIFIED. Single player uses the same field for rival hardness, 1.0 / 1.4 / 1.8 (`FUN_00429df0`, yd.c 29533-29547). |
| M key | toggles the siren | nothing | `FUN_0041b330` 20448 VERIFIED |
| Meter `+0x70` | not used | starts 1.0; -0.1/s per live cop within 7 m and with a relative speed below 10 m/s, otherwise +0.01/s, clamped to 0..1; 0 = busted ("%s %s" name + Busted, red ring message) | `FUN_00427fc0` VERIFIED (constants 7.0 @0x48489c, 10.0 @0x483314, 0.1 @0x48331c, 0.01 @0x4845a0) |
| HUD meter bar (own car, robber only) | not drawn | background (-0.2, -0.97), size 0.4 x 0.05, colour 0x50000000; fill (-0.2, -0.97), size `meter*0.4` x 0.05, colour ARGB `0xB4, R=(1-m)*255, G=m*255, B=0` (green when full, red when empty) | `FUN_00427690`, asm 0x4276ca-0x42777f VERIFIED (0.4 @0x484654, 255 @0x4833c0) |
| Minimap dots | blue (red while the siren blinks) | green (0,0.9,0), busted grey; a robber sees only cars within 150 m | already ported, sim.js minimap notes |
| Car model | any | any | no team test in message 2 or `FUN_00429b00` VERIFIED |

## 4. Spawn in Gogh & Milica (`FUN_00414690`, yd.c 15947-16029, VERIFIED)

`this` = city object `DAT_004af780`. `+0xb00` = block count (209) and `+0xb04[]` = blocks (filled by the city loader, yd.c 17085-17101).

```
used = []
while used.length < 8:
    b = rand() % nBlocks; if b in used: continue
    path = random path of block b with class flags == 0x40000000      (FUN_00423310: picks among them with rand(); none -> retry)
    if !path: continue
    (pt, segDir) = nearest point on the path polyline to block.sphere centre (block+0x14 = header f[7..9], yd.c loader)   (FUN_00421410)
    pt.y += 0.5                                              (0.5 @0x483310)
    yaw = atan2(segDir.x, segDir.z)   (D3D; code: |dx|<0.01 -> dx = 0.01; dx>0: pi/2 - atan(dz/dx), else -atan(dz/dx) - pi/2)
    spawn[used.length] = RotationY(yaw) with translation pt;  idx[used.length] = b;  used.push(b)
```

Player i (the order of the records) gets spawn i. Robbers and cops therefore start in 8 different random blocks across the city, not side by side on the grid. INFERRED: segDir is the normalised direction of the nearest segment `p[k+1]-p[k]` (thunk_FUN_00439bf9 = Vec3Normalize). In the port the paths live at `world.cit.blocks[b].paths[p]`, with `flags` and raw D3D `pts`. The sphere is `blk.sphere`, also raw D3D. Port position = `(-x, y, z)` and port yaw = `atan2(-dx, dz)` (physics-orig.js line 6: x' = -x, yaw' = -yaw).

## 5. Answers to the questions asked

| Question | Answer |
|---|---|
| Which screen, which controls | None. GMCar 0x38 (`FUN_004338d0`) has: car picker (0, -0.65), colour (0, -0.53), plate (0, -0.41), Transmission selector 0x12 (0, -0.29, w 0.6), plate text 0x17, preview, CHOICE CAR 0x39 (-0.15, 0.41, 0.3x0.064), GO TO CITY 0x11 (0.2, 0.41), OPTIONS 8 (0, 0.51), MAIN MENU 0x34 (0, 0.61), EXIT WINDOWS 1 (0, 0.71). There is no team control. VERIFIED |
| Default team | There is none. Every player is police until the host's draw at start. VERIFIED |
| Limited / balanced | Yes: exactly `floor(n/2)` robbers and `ceil(n/2)` cops, n = players who chose a car, at most 8. VERIFIED |
| Host or each player picks | Neither. The host's `rand()` decides. VERIFIED |
| Can change before start | It does not exist before start. It is drawn again at every GO TO CITY after RESTART. VERIFIED |
| Network | Message 4 record byte +0x78 (sent to each player), and after that the bit `0x800000` in every type-1 state packet. VERIFIED |
| Car choice | Not restricted. Police get the light bar (`Cars/migalka.ref`, already in carfx.js), the siren on at spawn, and 1.8x engine torque. VERIFIED |
| Spawn | Random block / `0x40000000` path per player (section 4). VERIFIED |

## 6. Port changes (mapped to the current code)

### 6.1 server.js

1. **Team at join (`server.js:115-116`)**: remove the "first = robber" default. Set `team: null` in `c.info` (not known before the start). Keep `m.team` only as a test aid; see 6.4.
2. **Chosen flag**: in `m.t === 'car'` (`server.js:127`), set `c.info.chosen = true`. In the restart branch (`server.js:137-140`), clear `chosen` and `team` for every member (message 5, net2.c case 5).
3. **Start (`m.t === 'start'`, `server.js:131-136`)**:
   - `inc` = the members whose `info.chosen` is set, in join/slot order (the host's player list order). INFERRED fallback: the port's `mpgo` already auto-chooses the car on screen, so in practice every member has chosen.
   - Teams when `room.gameType === 2` (menu index 2 = original type 4): every member of `inc` gets `'m'`, then `floor(inc.length/2)` distinct random members get `'g'`. This is `FUN_0042b4f0` exactly. Store the result in `x.info.team`.
   - **Drop the "robbers first" sort** for Gogh & Milica. Slots are `inc` order (`x.slot = i`, the record `+0x31` order), and spawns come from the host (6.2).
   - Send `{ t: 'go', in: 6, slot, slots, teams: {id: 'g'|'m'}, sp }` to every member, where `sp` = the host's spawn list, validated: up to 8 entries `[x, y, z, yaw]`, finite numbers.
   - Optionally refuse the start (as `FUN_00426f00` does) when fewer than 2 members have chosen.
4. **Reconnect (`resumes`)** already keeps `info.team`; nothing to change.

### 6.2 game.js (host side, GO TO CITY)

- `mpGoNow()` (game.js:683): when `G.gm && n.isHost`, compute `sp = gmSpawns(G.world)` (section 4 on `world.cit.blocks`: random block, random path with `flags === 0x40000000`, nearest point to `blk.sphere` centre, y + 0.5, yaw from the segment, converted to port space) and send it with `sendStart({ sp })`. net.js `sendStart` must pass the extra field.
- `net.hooks.onGo` (game.js:568): when `m.teams` is present, set `player.team = m.teams[net.id]` and `G.state.gm.team` to the same, and set `r.team = m.teams[id]` for each remote. Then place the car:
  - Gogh & Milica: `putOn(player, sp[slot])`
  - otherwise: `spawnSlot(net.slot)`
- When the teams are applied (onGo), for every police car (own car and remotes):
  - `e.siren = true`; for the own car `setSiren('me', true)` (`+0x6d = 1` at spawn). No 'siren' message is needed at start because every client applies the same rule; later M toggles still use 'siren'.
  - `e.phys.torqueMul = 1.8` (robbers 1.0)
- `netRestart()` (game.js:670): set `player.team = null` and `r.team = null` (the team is unknown until the next go). stopSirens is already called. `torqueMul = 1`.
- `game.js:491`: stop forwarding `?team=` in the hello (or forward it only under the 6.4 test aid). `game.js:493`: `state.gm = { team: null }`.
- `stepGM` (game.js:947) already uses `e.team === 'm' / 'g'`. A `null` team (lobby) counts as neither, which is correct because nothing runs before go.
- Add the robber meter bar to `drawGM` (game.js ~966): only when `player.team === 'g'`. Draw `R.sprite(null, -0.2, -0.97, 0.4, 0.05, 0x50000000)`, then `R.sprite(null, -0.2, -0.97, m*0.4, 0.05, (0xB4<<24 | ((1-m)*255|0)<<16 | (m*255|0)<<8)>>>0)` with `m = gm.meters.get(player) ?? 1` (`FUN_00427690`).

### 6.3 physics-orig.js

- `_engine` (physics-orig.js:294): `if (this._gas) T = this._torque(this._eOmega) * this._thr * (this.torqueMul || 1);`. This is car `+0x1dc` (asm 0x413841). Engine braking is not scaled.
- Default `torqueMul = 1` in the constructor. Remote copies must get the same value (set it in onGo for remotes), because they are full bodies simulated with the sender's inputs (net.js).

### 6.4 Test aid (DEVIATION, keep out of normal play)

`?team=g|m` may stay as a forced team for headless tests. The server honours it at the draw only when set: forced players keep their team and the rest are drawn randomly. Document it as a test aid in PROGRESS.md. Without it, the draw is the original one.

### 6.5 UI (ui-orig.js)

No new control. GMCar stays as it is (ui-orig.js:916-944). Possible related fix: GO TO CITY should become enabled on the host only when at least 2 players have chosen (`FUN_00426f00`). The port enables it after the host's own choice (game.js:721) and lets the 'start' go ahead with 1 player. With a single player, the team draw gives no robber (instant MWin in the original).

## 7. Test plan

1. Two headless clients (`?auto=1&net=create&gt=2`, `&net=join`, `autogo`): over 10 restarts, each round has exactly 1 robber and 1 cop, and the host is a robber in about half of the rounds.
2. With 3 and 4 clients: robber/cop counts are 1/2 and 2/2.
3. Every police car shows the light bar and plays the siren from the go. M toggles it only on police.
4. Police acceleration: at full throttle 0-100 km/h is clearly shorter. Log `phys._engTorque` at the same rpm: it is 1.8x the robber value.
5. The spawns are 8 distinct blocks, on `0x40000000` paths, facing along the path. No two players start within a few metres of each other.
6. Only the robber sees the meter bar, green going to red while a cop is within 7 m.
7. RESTART: back on GMCar, the teams are cleared, and the next GO TO CITY draws them again.

## 8. Open points

- `p1 = rand()%28` in message 4 is stored in `game+0` (INFERRED: a sky or time-of-day index, also set in `FUN_00426c90`). It is not team related.
- What the original shows to players who are left out of message 4 (no CHOICE CAR) was not traced (INFERRED: they stay on GMCar).
- `NotChoiced` in [STRINGS] probably goes with this ("not chosen"), but its use was not found in yd.c by name.
