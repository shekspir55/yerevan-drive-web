# Yerevan Drive web port: gap list (web vs. original v1.1)

This list merges five read-only audits: game modes, UI, audio, cars and physics, assets and rendering, network and deploy. Duplicate findings are listed once. Items are ranked by how visible they are to players and how cheap they are to fix. Effort: S = hours, M = about a day, L = several days.

I re-read the code for these claims myself and confirmed them:
- the menu sound file name case mismatch
- the server crash on a bad URL
- the double X drag
- engine.wav on 8 of 17 cars is IMA ADPCM and is never converted
- the silent ambient emitters
- MP3 probing downloads every song
- max players is off by 2
- RESTART drops the network session

I dropped no claims.

## P0: fix before the public deploy (yerevandrive.rbn.am)

| # | Gap | Effort | Evidence |
|---|-----|--------|----------|
| 1 | **Menu sounds do not load on a Linux server.** The code requests `Menu/Menu.snd`, but the file on disk is `Menu/menu.snd`. The fetch keeps the case it was given, gets a 404, and the error is swallowed. All menu sounds are silent. (verified) | S | web/ui-orig.js:559; web/formats.js:25; `ls web/game/Menu` |
| 2 | **One bad URL crashes the whole server.** `decodeURIComponent('/%')` throws URIError. A NUL byte in the path makes `fs.stat` throw. There is no try/catch, no error handler on the read stream and no supervisor. All rooms die. (verified) | S | server.js:12-19 |
| 3 | **The deploy would publish the exe, key.dat and dev files.** `web/game` links to the whole install folder (Yerevan Drive.exe, .exe.orig, Uninstal.exe, key.dat, Cars/2110/*.X), and web/ also holds tools/ and spec-*.md. Deploy a copied allowlist instead: the 11 runtime JS files, index.html, and the data files the code actually loads. Hosting the copyrighted data and music is the owner's legal decision. | S | server.js:12-18; ls web/game |
| 4 | **Every game start downloads all MP3s (about 57 MB) before you can drive.** `vfs.exists()` calls `bytes()`, which fetches each `track_NN.mp3` in full, caches it forever, and is awaited during 'Loading sound'. Fix: a static playlist or HEAD requests, then stream through `<audio src>`. (verified) | S | web/game.js:204; web/formats.js:16-32 |
| 5 | **No compression and no cache headers.** Runtime data is 52.5 MB raw and about 28 MB gzipped (yerevan.cit 6.2 MB gzips to 1.4 MB), and it is fetched again on every reload. Have nginx or caddy serve the static files with gzip/brotli and long caching, and proxy only `/ws` and `/sessions` to node bound to 127.0.0.1, with Upgrade headers and a long read timeout. The paths are absolute, so serve the game at the domain root. | S | server.js:16-18; web/net.js:9; web/ui-orig.js:241 |
| 6 | **WebSocket memory DoS.** The server accepts a 64-bit frame length and keeps calling `Buffer.concat` with no limit. Relayed payloads are not size-checked, and there is no limit per IP or per room. Fix: cap frames at 16-64 KB, validate message shapes, and limit sockets per IP. | S | server.js:91-106, 58-75 |

## P1: cheap bugs players notice (S)

| # | Gap | Evidence |
|---|-----|----------|
| 7 | **No engine sound on 8 of 17 cars** (2110, A190, gazel, mits, Nissan, Peugeot, TT, UAZ). Their engine.wav is IMA ADPCM (format 0x11), and the code passes it straight to `decodeAudioData`. `imaToWav` already exists in the code. (verified) | web/game.js:194-200; Cars/*/avto.snd |
| 8 | **All city ambient sounds are silent.** The city asks for `Ptica.wav`, but the archive only holds Ptica0-9.wav. The other 6 sounds are MS or IMA ADPCM and are skipped as undecodable. Fix: pick a random PticaN and run msToWav/imaToWav. (verified) | web/sim.js:366,372; Sound/ambient.snd |
| 9 | **Drag and downforce are applied twice on X**, so top speed depends on which way the car faces in the world. Delete the first `v[0] +=` line. (verified) | web/physics-orig.js:202 and :205 |
| 10 | **Max players is off by 2.** The selector value is already 2..8, and the code adds 2, so choosing 2 makes a room for 4. (verified) | web/ui-orig.js:851; web/game.js:321 |
| 11 | **RESTART in a network game drops you into a single-player game.** `restartUrl()` builds a solo `?auto=1` URL. (verified; the full fix is #31) | web/game.js:506-512 |
| 12 | **Settings are never saved, and RESTART drops most of them.** There is no localStorage and `Settings.toJSON` is never called. restartUrl drops hardness, opponent car, manual gearbox, plate and the Few/Many traffic level. | web/game.js:506-509; web/ui-orig.js:512 |
| 13 | **Sound and Music sliders do not change in-game audio.** `ui.onSettings` is never set. Engine, horn, siren and ambient use hard-coded gains, and music uses `AU.musicVol` = 0.35. | web/ui-orig.js:747,934; web/game.js:198,226 |
| 14 | **Spawn slots come from the server-wide client id.** Two players in one room can share a grid slot. In Gogh & Milica the robber spawns 4 m from a cop and is being caught from the first second. Fix: the server assigns per-room slots in 'start'. | web/game.js:361,376; server.js:28,90 |
| 15 | **Cars drive through bus stops, phone booths and kiosks.** The 63 shape-2 (box) colliders are ignored; only round ones are built. | web/world.js:300-303 |
| 16 | **Rivals pass through poles and trees** (`ignoreObjects = true`). | web/game.js:370; web/world.js:430 |
| 17 | **Traffic and network cars always show brake and reverse lights.** updateLamps runs only for the player and the AI. | web/game.js:615-616; web/sim.js:71-75 |
| 18 | **Lens flare never draws.** The code searches for `/lens0/`, but the material is `LensFlare` with texture `lens.tga`. | web/render-orig.js:270-278; Graph/citstdmat.ref |
| 19 | **Pausing in a network game freezes your car and the host's traffic for everyone.** The loop returns before sendState and sendTraffic. | web/game.js:578-589,554,608 |
| 20 | **Rival names from Cars/opponents.ini are not used.** Rivals show as 'Racer N (car)', the player shows as 'You' instead of MyName, and report rows strip non-ASCII, so Armenian names vanish. | web/game.js:351,368; web/ui-orig.js:941-950 |
| 21 | **No confirmation dialogs** for RESTART, MAIN MENU or in-game EXIT, although [STRINGS] has RestartGame and MainMenu and dialog 0x3d exists. | web/ui-orig.js:916-920,946-949; PROGRESS.md:83 |
| 22 | **Network strings are not used.** LeaveGame, SessionFull, WrongPassword, Server, Protected/Notprotected and NotChoiced never appear. The port shows English toasts and a '* ' password marker, and shows no message when a player leaves. | web/game.js:97,103,399; web/ui-orig.js:252; server.js:40-48 |
| 23 | **Every car has the same collision box** (1.9 x 4.4 m, XZ only), not the car's own `bound` OBB. Kamaz overlaps other cars, and cars on different levels collide. | web/sim.js:286,291 |
| 24 | **Crash sound rule differs.** The port uses the player's speed drop per frame instead of the impulse (\|J\|>200), never plays bum5, and other cars' crashes are silent. | web/game.js:201,281-286; spec-physics.md:175 |
| 25 | **Loading bar is full after about 3 steps** (progress*10 against 0.09 per step), and loading is sequential with no byte progress. | web/ui-orig.js:970-974; web/game.js:317; web/world.js:111-118 |
| 26 | **Network screen ignores config.ini [MULTI].** It always forces type G&M and disables Laps, and it does not restore PlayerName, Laps or Password. | web/ui-orig.js:863 |
| 27 | **English HTML overlays** (help line, Menu button, volume lines, old #dash when Takhometr is off, 'me:' in chat) are not in the original. | web/index.html:63-67; web/game.js:75,140,217 |
| 28 | **The MP3 folder only finds `track_NN.mp3` over HTTP.** Folded into #4: ship a server-side playlist. | web/game.js:202-204 |
| 29 | **Horn sample is picked arbitrarily** (folder name length % 3), and other cars never honk. | web/game.js:201,287-291 |
| 30 | **No shadow or tyre smoke on traffic cars.** | web/game.js:612,614 |

## P2: medium work (M)

| # | Gap | Evidence |
|---|-----|----------|
| 31 | **Network in-game menu GMMain 0x37 is not ported.** In the original only the host can RESTART and the others see PleaseRestart. | web/ui-orig.js:910-921; PROGRESS.md:83 |
| 32 | **Gogh & Milica busts and the winner are decided on each client.** There is no busted or game-over message, so screens can disagree. Race standings also come from each client's own interpolated positions. | web/game.js:715-734; server.js relay types |
| 33 | **No disconnect handling, heartbeat, reconnect or connect timeout.** Dead sockets stay in rooms as ghosts. A hidden host tab freezes traffic for everyone when the proxy times out. | web/net.js:10-13,27; web/game.js:444,554 |
| 34 | **Street wall collisions bounce 30% with no friction or torque.** The original corner-ray rule is already written (`resolveWorldContact`) but nothing calls it. | web/world.js:421-454; web/physics-orig.js:471 |
| 35 | **City sprite objects (types 3 and 6) are not drawn.** That is 106 bush and alpha sprites and 16 sign sprites. othtex.tex is loaded but unused. | web/world.js:279-283,115,119 |
| 36 | **Material flags are ignored.** City, object and car materials lose double-sided (28), alpha-test ALPHAREF (42), specular (35, including car bodies), unlit and blend modes. The decoded mapping exists but is unused. | web/world.js:123-129; web/formats.js:246-264; web/render-orig.js:40-52 |
| 37 | **No object LOD and no ViewDistance culling** (300/550/850 m). The `_lo`/`_lo_lo` frames are unused. TextureLOD, BPP and Resolution are cosmetic. | web/world.js:458-466; web/render-orig.js:23,312 |
| 38 | **Police light bar (migalka.ref, migred/migblue) is not drawn.** The siren is audio only. | web/game.js:105 (comment only) |
| 39 | **Traffic engine loops (traf0_0..traf2_2) are unused.** Rivals and remote players are silent, and nothing is positional or has doppler (the original uses 3D sources, 10-60 m). | Cars/carstd.snd; web/game.js:190-200; spec-render.md:64,74 |
| 40 | **Opponent voice lines (Cars/op.snd, 24 clips) are never played.** What triggers them in the original is unknown. | web/game.js:250; PROGRESS.md:111 |
| 41 | **Report screen text and the Gogh & Milica end screen are approximations.** The line layout is not decoded, FUN_00430820 is not ported, there is no win sound, and the game reloads the page after 8 s. | web/game.js:562-586,716,741; PROGRESS.md:16,48 |
| 42 | **Minimap does not draw map.dds or point.dds**, because the world-to-map transform is not decoded. | web/sim.js:329-337 |
| 43 | **DDS textures are decoded to RGBA on the CPU** (CITMAT about 136 MB against 21 MB as DXT), and the VFS cache is never freed. This is the likely cause of mobile grey screens and WebGL context loss. | web/formats.js:59,168-175,8,30 |
| 44 | **The server trusts clients.** It does no position or NaN checks, does not check Origin, and accepts the debug `?at=`/`?warp` hooks in production. | server.js:35-89; web/game.js:432 |
| 45 | **No headlight beam or flare quads** (far_alpha and farflare textures). | Cars/*/avto.tex; spec-render.md:81 |
| 46 | **Tyre smoke and skid thresholds are guesses**, and the surface flag (hit+0x1c) is ignored. | web/sim.js:388-444 |
| 47 | **Engine pitch and gain curve is made up.** The par field 0xb4 is unused. | web/game.js:669-672 |

## P3: large or uncertain

| # | Gap | Evidence |
|---|-----|----------|
| 48 | **Traffic follows paths kinematically** (fixed 1300 kg, yaw only, invented spawn and speed rules). In the original, traffic cars are the same physics class as the player. | web/sim.js:172-318 (L) |
| 49 | **The race AI is invented** (pure pursuit, vmax formula, respawn rules), not FUN_0041c300. | web/sim.js:114-144 (L) |
| 50 | **Traffic car set is hard-coded.** The par flag 0x1b4 is set on exactly A190, Honda, Kamaz, UAZ and gazel, so it likely marks traffic cars. That is an inference. | web/game.js:405; Cars/*/avto.par |
| 51 | **Lap counting is a route-index wrap heuristic.** There are no checkpoints and no time limit. | web/sim.js:153-166 |
| 52 | **Smaller items:** collision sparks (boundparticle); water UV transform (jur1, material 109); ophamar plate on rivals; ObjDef kinds 1 and 7; unused menu materials; Armenian key layout approximated; fixed 0.008 s physics step against the original variable ≤0.02 s; unused par fields; ~~no team picker (only `?team=`)~~ DONE 2026-10-28: the original has none; teams are drawn at GO TO CITY like FUN_0042b4f0 (see PROGRESS.md); browser compatibility (OffscreenCanvas, three r128, no fullscreen); ~~GO TO CITY enabled from the start~~ DONE 2026-10-28: host only, once 2 players chose a car (FUN_00426f00). | various, see the audit sources |
