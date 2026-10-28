# Yerevan Drive v1.1: race progress, laps, standings and race end (GAPS.md #51)

Sources: Ghidra `yd.c` (line numbers below), `net2.c`, disassembly `re/yd.asm` (x87 constants and code that Ghidra did not decompile), constants read from the exe with `re/pe.py`.
Tags: **VERIFIED** = read in the code (or measured on the game data); **INFERRED** = deduced, not proven.

## 0. Objects and fields

| Object | Address / field | Meaning | Tag |
|---|---|---|---|
| game | `DAT_004dbaf8` (`this` of FUN_00427xxx; `net2.c:127` calls `FUN_00427bb0(&DAT_004dbaf8, ..)`) | game state | VERIFIED |
| game+0xadc | game type: 0 walker, 1 single-player race, 2 network walker, 3 network race, 4 Gogh & Milica (switch in the frame function, yd.c:30110-30135) | VERIFIED |
| game+0xae8 | number of laps | VERIFIED (HUD yd.c:27888; set yd.c:27153/27241) |
| game+0xafc / +0xb00 | countdown timer (5.0) / last whole second (4) | VERIFIED (FUN_004274e0 yd.c:27715) |
| game+0x84d | race running (set by FUN_004283b0) | VERIFIED |
| game+0x84e | results already shown / sent | VERIFIED |
| game+0xb04 | number of racers; +0xb08[] racers in join order; +0xb28[] racers in standings order | VERIFIED (FUN_00427500 yd.c:27790; FUN_004283b0 copies b08 -> b28) |
| game+0xb48 | the local player's racer | VERIFIED (yd.c:27781) |
| game+0xb50 | player position (1-based) | VERIFIED |
| game+0xb54 | number of finished racers (they stay frozen at the top of b28) | VERIFIED |
| world | `DAT_004af780`; world+0x1988 = `DAT_004b1108` = number of route segments nSeg | VERIFIED (0x4af780+0x1988 = 0x4b1108) |
| route segment | a CIT road path object (FUN_00421150): +8 lap index, +0x10 point count (u16), +0x14 length, +0x18 speed value, +0x1c/+0x1d prev/next link counts, +0x20 points (xyz), +0x24 prev links, +0x28 next links | VERIFIED (fields), meaning of +0x14/+0x18 INFERRED |
| racer (controller attached to a car, car+0x154) | +4 car body, +0x18 current segment, +0x1c segment at the last lap check, +0x20 lap, +0x24 distance along the current segment, +0x28 closest route point, +0x34 route direction there, +0x40 distance from the route, +0x44 "stopped/finished" flag, +0x48 respawn cooldown time, +0x4c name | VERIFIED |

## 1. The route: no checkpoints, the segment chain is the checkpoint list

The `.trc` loader (in FUN_00414800, yd.c:16074-16205) reads the nSeg `(block, path)` pairs, **overwrites every segment's prev/next links with exactly one entry** (the previous and next segment of the loop) and writes the lap index to `seg+8` (VERIFIED, yd.c:16186-16201):

```
seg[0].idx = nSeg-1        // the start segment (startBlock/startPath) gets the HIGHEST index
seg[k].idx = k-1           // k = 1..nSeg-1
```

There is no separate checkpoint list, no distance array and no trigger object (VERIFIED: the only progress code is section 2).

Measured on all 28 tracks (VERIFIED, `scratchpad/laps/seg0.py`). Grid slot 0 is **4 m past the end of seg[0]**, i.e. already in seg[1]. Slots 1..7 sit 2, 8, 14, 20, 26, 32 and 38 m before the end of seg[0], and seg[0] is 67..295 m long. So the start/finish line is the **seg[0] -> seg[1] boundary, right in front of the grid**.

## 2. Tracking a racer along the route

**Which segment a racer is on.** `FUN_00421710(seg, &closest, &dir, &dist, &sub, carPos)` (yd.c:23584) projects the car position onto every sub-segment of the current segment, its one prev link and its one next link. It uses `FUN_00421410` and `FUN_00405540` (closest point on a line segment, clamped). It returns the segment with the closest point. So a racer can move only **one segment per update** (VERIFIED). The distance is the 3D distance from the car to the closest point (VERIFIED).
- Race player controller (vtable 0x484a68, update `FUN_0041b6d0` @0x41b6d0, not decompiled, read in the asm): it runs the keyboard driving `FUN_0041b330` and then calls `FUN_00421710` **every tick** (VERIFIED).
- AI racer (vtable 0x484a94, `FUN_0041c300` yd.c:20714): it calls `FUN_00421710` every 3rd tick (`racer+0xc0 % 3`, yd.c:20806) (VERIFIED).
- Network race: `FUN_00427e00` calls `FUN_0041b250` (the same search) for every racer except the local one, so remote cars are tracked locally (VERIFIED, yd.c:28139).

**Laps.** `FUN_0041b1f0` (yd.c:20364) runs for every racer that has not finished:
```
if (cur != last) {
  if (cur.idx == 0      && last.idx == nSeg-1) lap++;   // seg[0] -> seg[1]: crossed the line forwards
  if (cur.idx == nSeg-1 && last.idx == 0)      lap--;   // seg[1] -> seg[0]: crossed it backwards
  last = cur;
}
racer+0x24 = FUN_00421310(cur, closestPoint)  // arc length from the segment start to the closest point
```
VERIFIED. Every racer starts with `lap = -1` and `cur = last = start segment`. This is set by `FUN_0041b660` (player, yd.c:20565) and `FUN_0041c190` (AI, yd.c:20640+). The first crossing gives lap 0. A racer **finishes when lap reaches the lap count**, i.e. after laps+1 crossings. That is the short run from the grid to the line (−4..38 m) plus `laps` full loops.

**Wrong way and reversing.** There is no wrong-way message: no such string exists in menuam.ini or in the exe strings near the HUD (VERIFIED, [STRINGS] list). Driving back over the line takes a lap off again (VERIFIED, the `lap--` above).

**Cutting corners: the 30 m leash.** In `FUN_0041b6d0`, `if (racer.dist > 30.0)` (`DAT_00484b2c` = 30.0, `fcomp` + `test ah,0x41` at 0x41b701-0x41b712) it calls vtable slot 5 = `FUN_0041b690`, the respawn. That calls `FUN_0041b0b0` (yd.c:20314) with point = closest route point + (0, 0.8, 0) (`DAT_00484624` = 0.8). VERIFIED. The respawn only runs `if (racer+0x48 <= now)`. It then:
- builds the heading from the route direction with y set to 0 (normalized, atan, ±π/2 `DAT_004833c4`);
- puts the car there (`FUN_0041d300`, `FUN_00410650`);
- sets the **velocity to 0.2 × the current speed along the route direction** (`DAT_00483300` = 0.2);
- sets `racer+0x48 = now + 1.5 s` (`DAT_004848d4` = 1.5).

All of this is VERIFIED. Because tracking moves only one segment at a time, a shortcut that leaves the tracked segments by more than 30 m snaps the car back onto the route **behind** the cut. This is the only anti-cut rule. The leash applies to the local player in race types 1 and 3 only: `FUN_00427500` picks vtable 0x484a68 when game type is not 0/2/4 (yd.c:27530-27535 and `FUN_0041a540` yd.c:19790-19820). AI racers have no slot-5 respawn (their vtable 0x484a94 has 5 entries; INFERRED from the vtable layout).
- The same slot-5 respawn also runs from `FUN_0041b330` when `DAT_004ab0bc` is non-zero (asm 0x41b5e8-0x41b5f5). That is a "back on the road" key, and in a race it goes to the **closest point on the tracked segments**, not anywhere on the route (VERIFIED code path; which key `DAT_004ab0bc` is remains INFERRED/unknown).

**No time limit.** `FUN_00427cd0` and `FUN_00427e00` contain no timer, and "Elapsed time" (`FUN_00427790`) is drawn only when game type == 4 (VERIFIED, yd.c:27846).

## 3. Standings during the race

- **Single player (type 1):** `FUN_00427cd0` (yd.c:28041) is called every frame, and while the player has **not** finished it works on every 2nd frame (`DAT_004dcab8` even):
  1. `FUN_0041b1f0` for racers b28[b54..count-1];
  2. `qsort(b28 + b54, count - b54, 4, cmp@0x426090)`;
  3. it walks the sorted list. A racer with `lap == laps` gets `lap = laps-1` (so the HUD shows laps/laps), `+0x44 = 1` (finished) and `b54++`. If the racer is the player, `b50 = i+1`. (VERIFIED)

  Finished racers are never sorted again, so the top of the table is the finish order.
- **Network race (type 3):** `FUN_00427e00` (yd.c:28103) does the same every frame, plus the remote tracking from section 2 (VERIFIED).
- **Comparator** `0x426090` (asm only). A racer is ahead if it has the higher `lap`. On equal laps, the higher `seg.idx` (unsigned) is ahead. On equal segments, the higher `+0x24` (distance along the segment) is ahead (VERIFIED: `jl/jg` on +0x20, `jb/ja` on `[+0x1c]+8`, `fcomp` on +0x24 with `test ah,5; jp`). The comparison uses the segment at the last lap check (+0x1c), which equals +0x18 right after `FUN_0041b1f0`. Seg[0] has the highest idx, which is correct, because it is the last segment of every lap.

## 4. Race start (countdown) — shared by all modes

Countdown (frame function yd.c:30080-30105): `t = game+0xafc` starts at 5.0 and decreases by dt. When `(int)t < game+0xb00` (starting at 4), it stores the new value and plays `DAT_004abb50[(int)t == 0]`. These are the sound object 0x4ab4f0 (+0x660 = `start0.wav`, +0x664 = `start1.wav`, `FUN_004127d0` yd.c:15116-15119). So it plays **start0 at t = 4, 3, 2 and start1 at t = 1** (VERIFIED).

When `t <= 1.0` (and the race is not running yet), `FUN_004283b0` (yd.c:28343) runs. It sets the race running (0x84d = 1), copies b08 -> b28 and **clears +0x44 on every racer** (VERIFIED).

Before that, every racer has +0x44 = 1 (set by `FUN_0041b290`, `FUN_0041c190`). The effect of +0x44 = 1:
- The player controller sets the brake flag (`FUN_004107a0`: car+0x17c |= 0x40000000). If the up key `DAT_004aaf38` is held it also sets throttle (`FUN_00410780`: |= 0x80000000), so the engine revs on the grid. Steering is ignored (yd.c:20461-20466).
- The AI only brakes (yd.c:20742).

So **cars are released at t = 1.0, when "GO!" appears** (VERIFIED). INFERRED: 0x80000000 = throttle and 0x40000000 = brake, from how they are used.

Countdown text `FUN_004285c0` (yd.c:28440): shown while 0 < t < 4.0 (`DAT_00484834`), centred at (0,0). It shows `"3"`, `"2"`, `"1"` or `GO` (menuam.ini [STRINGS] `Go`) for `(int)t` = 3, 2, 1, 0, at size `0.05 + frac(t)·0.12` (`DAT_00484620`, `DAT_004845d8`), colour 0xffffffff, flags 0xb (VERIFIED).

## 5. HUD during a race

`FUN_004278a0` (yd.c:27867, positions read from asm 0x4278f0-0x4279dc) draws only for types 1 and 3, when the player car exists and the HUD toggle game+0x852 is on (VERIFIED):
- a panel at (0.35, −1.0, w 0.65, h 0.1), colour 0x9632325a;
- `"%s %d/%d"`: YourPosition, b50, b04, at (0.38, −0.98), size 0.07×0.07, colour 0xffff7d7d, flags 8;
- `"%s %d/%d"`: Laps, `max(1, lap+1)`, laps, at (0.62, −0.98), same style.

There is no race timer, no lap time, no best lap and no wrong-way text (VERIFIED). The strings come from menuam.ini [STRINGS] `YourPosition` and `Laps`, loaded by `FUN_00434970` (yd.c:36312-36322).

## 6. Race end

- **After the finish line,** the finished flag +0x44 means:
  - the player loses control and the car brakes itself (holding up only revs the engine);
  - finished AI cars brake and stop.

  This is the same code as on the grid (VERIFIED, section 4).
- **Single player (type 1, `FUN_00427cd0`):** once the player has +0x44, sorting stops: rivals' laps and the standings freeze. When the player car's speed |v| < 0.2 m/s (`DAT_00483300`), it calls `FUN_00427bb0(game, 1)`. That is the report screen (menu 0x35) with one row per racer in b28 order: place, name +0x4c, car name, paint colour (yd.c:28010-28022). There are no times and no DNF marks, and rivals still racing are listed by their current position (VERIFIED). **It does not wait for the rivals.**
- **Network race (type 3, `FUN_00427e00`):** when the local player has finished and |v| < 0.2:
  - the camera follows (`FUN_00417240(&DAT_004b1188, car)`) the first racer in standings order that has not finished (VERIFIED);
  - if every racer has finished and 0x84e == 0, it sets 0x84e = 1 and calls `FUN_0042b190(&DAT_004dcac8, 1, 0, 0)`. That sends DirectPlay message 0x12 (guaranteed, flag 8) to everyone, and only on the host, because it is guarded by net+0x5c8, which the create-session path sets (yd.c:25970). Every peer that receives 0x12 runs `FUN_00427bb0` (net2.c:122-128). (VERIFIED code path; "net+0x5c8 = host" is INFERRED)

  There is no timeout: if a racer never finishes, the race never ends (VERIFIED: no timer in the function).
- Lap count options: 2..5 (menu list yd.c:35200-35203; config.ini `Laps` clamped to 2..5, default 2, yd.c:26960-26963 and 26981-26984) (VERIFIED).

## 7. Compared with the port (web/sim.js `Race`, web/game.js)

| # | Original | Port | Effect |
|---|---|---|---|
| 1 | Tracks segments (cur/prev/next only). Lap++ on seg[0]->seg[1], so the line is **at the grid**. Start lap −1, finish when lap == laps | Nearest polyline point in a ±60-point window (sim.js:156). Lap = wrap of the point index at 0.8n/0.2n. The line is at the **start of seg[0]**, 67..295 m behind the grid. Start lap −9→0. Finish when lap ≥ laps | The race is about one seg[0] length shorter. The finish is triggered 67..295 m before the real line. The HUD lap changes at the wrong place |
| 2 | 30 m leash: auto-respawn onto the tracked route, speed × 0.2, 1.5 s cooldown | none: a player can cut corners freely | shortcuts are allowed |
| 3 | Manual respawn = slot 5 onto the closest point of the tracked segments, keeps 20 % of the speed | `G.reset` (KeyR, game.js:614-623) searches the **whole** route for the nearest point and sets the speed to 0 | in a race, R can jump ahead, and the lap logic can then miss or add a wrap |
| 4 | Sort key: (lap, seg idx, arc in seg). Finished racers frozen in finish order. Every 2nd frame in single player | `lap*len + d[idx]`, done-first by time | about the same. OK |
| 5 | Cars released at t ≤ 1.0 (when GO appears) | released at race.t ≥ 0 (sim.js:154), i.e. when GO disappears | the port holds cars 1 s too long |
| 6 | start0.wav beeps at 3,2,1 and start1.wav at GO | start0/1 used as a random "engine start" sound at load (game.js:636) | countdown sounds missing |
| 7 | After finishing: player input cut and car auto-braked; finished AI brakes | player keeps driving; AI keeps racing | the single-player report waits for the player to stop by hand |
| 8 | Single player: standings frozen once the player finishes; report at |v| < 0.2 | race.update keeps running; report at |v| < 0.2 | final order can differ |
| 9 | No timer on the race HUD, no times on the report | DOM fallback HUD has `rtime` and times/DNF (the original-UI path already matches) | only the fallback path differs |
| 10 | Laps 2..5 | DOM lobby 1..10 (game.js:47) | fallback only |
| 11 | Network: the host sends 0x12 when all have finished; spectator camera | same (game.js:868-870, 917) | OK |

## 8. Porting plan (read-only analysis; nothing was changed)

1. **Route per segment** (sim.js `buildRoute`): keep, for each trc segment k, its polyline, its length and `idx = (k == 0 ? nSeg-1 : k-1)`. Also keep the concatenated arrays for the AI.
2. **Tracker per entry**: `seg`, `last`, `lap = -1`, `closest`, `dir`, `dist` and `arc`. Each tick, search the closest point on segments {seg, seg-1, seg+1} with clamped point-to-segment projection (3D) and switch `seg` to the winner. In `Race.update`, apply the `FUN_0041b1f0` rule: lap++ when going from idx nSeg-1 to idx 0, lap-- for the reverse, then compute `arc` (`FUN_00421310`).
3. **Finish:** `if (lap === laps) { lap = laps-1; done = true; time = t; }`, iterating in standings order. Keep finished entries frozen in finish order. Sort with (lap, segIdx, arc).
4. **Leash** (player only, race types): `if (dist > 30 && t >= cooldown)`, place the car at `closest + 0.8 up`, yaw from the flattened `dir`, velocity = `0.2·|v|·dir`, and set `cooldown = t + 1.5`. Route `G.reset` in races through the same function.
5. **Countdown:** release the inputs at race.t ≥ −1 (original t ≤ 1.0). Play start0 when floor(T) drops to 3, 2, 1 and start1 when it drops to 0. Stop using start0/1 as the engine-start sound.
6. **After finish:** feed the player IDLE + brake (with throttle while up is held) once `done`, and the same for finished AIs (brake). In single player, stop `Race.update` sorting once the player is done.
7. Keep: HUD layout and strings (already match `FUN_004278a0`), the network end (host 0x12 = 'over'), and the spectator camera.

Confidence: high for sections 1-6 (all read in code or asm, with constants from the exe). Medium for which key `DAT_004ab0bc` is and for the host-only send (net+0x5c8). Nothing was checked by running the original game.
