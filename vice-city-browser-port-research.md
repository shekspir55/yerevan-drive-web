# How GTA: Vice City Was Reverse Engineered and Ported to the Browser

Research notes, compiled 2026-10-24 from web searches and page fetches.
**Confidence note:** The public record is thin on the DOS Zone team's actual porting steps. Where I infer rather than cite, it is marked *(inference)*.

## TL;DR

The browser version is a two-layer story:

1. **Reverse engineering (2018–2020):** Community developers rebuilt the full source of GTA III and Vice City by decompiling the original executables, producing the **re3** (GTA III) and **reVC** (Vice City) projects. They replaced Rockstar's middleware (RenderWare) with an open reimplementation called **librw**.
2. **Browser port (2025):** The **DOS Zone** team compiled that reimplemented engine to **WebAssembly** (Emscripten), swapped low-level subsystems (rendering, input, audio, file access) for browser equivalents, and **streamed the game assets** from a CDN as the player moves around the map.

The game's code is rebuilt, but the *content* (maps, models, audio, missions) is Rockstar's original data, which is why legal trouble followed.

---

## 1. Layer one: the reverse engineering (re3 / reVC)

| Item | Detail |
|---|---|
| Started | Spring 2018, by a Reddit user ("kotzkroete"); moved to GitHub May 2019 with more contributors |
| GTA III done | Spring 2020 (**re3**) |
| Vice City done | September 2020 (**reVC**), in the `miami` branch of the re3 repo |
| Method | "Reverse engineered": the executables were decompiled and rewritten as source. Specific techniques are not described in the sources I found |
| Rendering | Either original RenderWare (D3D8) or **librw**, the project's homebrew RenderWare replacement (separate repo by `aap`, included as a submodule) |
| Requirement | You must supply your own PC game assets |
| Extras | Rotatable vehicle camera, no loading screens between islands, any aspect ratio, new cheats, more platforms (Switch, Vita, Wii U ports) |
| Limits | Code mods (dll/asi, CLEO, limit adjusters) don't work; asset mods generally do |

**Why librw matters:** Original GTA games depend on Criterion's closed-source RenderWare engine. A reimplementation of that API, with backends like OpenGL, is what made the game portable. A game that already runs on OpenGL/GLES can be compiled to WebGL via Emscripten *(inference)*.

**Legal history:** In February 2021 Take-Two sent a DMCA notice and GitHub took down the main re3 repository and known forks. Forks and mirrors persist (e.g. `mrxenginner/reVC`, `Cai1Hsu/re3`, a Gitee mirror, and an Arch AUR package `revc-git`). I did not verify the current status of any of these.

## 2. Layer two: the browser port

### Who
- **DOS Zone** team (credited names: specialist003, caiiiycuk, SerGen) built the WebAssembly engine port. caiiiycuk is also behind **js-dos**, the DOS-in-browser emulator.
- **Lolendor** deobfuscated the code and maintains the open repo **reVCDOS**.
- Other ports exist, e.g. one by Erasmo "ebellumat" Bellumat (Origami) under the wasm.ltd preservation initiative, and a number of mirror/aggregator sites.

### How it works (from the reVCDOS README)
- **Runtime:** The game runs as WebAssembly in the browser. Sources say the engine is compiled with **Emscripten**; rendering goes through **WebGL 2**.
- **Subsystems replaced with browser versions:** rendering, input, audio, file access.
- **Client modules** (`dist/modules/`): WASM runtime, asset loader, virtual filesystem, audio, graphics, input, network fetch ("real-time asset streaming"), syscalls, a cheat engine, and per-language data packages (EN, RU).
- **Persistence:** IndexedDB-backed virtual filesystem (`idbfs.js`) for saves; js-dos cloud SDK variants for cloud saves, or local saves via a 5-character key.
- **Asset streaming:** Assets are split into a `vcsky/` side (data, audio, animations, models) and a `vcbr/` side (brotli-compressed `.wasm.br` and `.data.br`). The client fetches only what it needs as the player drives around. *(The meaning of the names vcsky/vcbr is my inference; it isn't defined in the sources.)*
- **Server:** A thin proxy, not a game server. `server.py` (FastAPI) or `index.php` (PHP 8+ shared hosting). Options: proxy from the DOS Zone CDN (default), serve local folders, cache CDN downloads, or serve a single packed `.bin` archive (brotli packer/unpacker utilities included).
- **Deployment:** Docker Compose, local Python 3.8+, PHP hosting, or Google Colab.
- **Extras:** Gamepad emulation, touch controls for mobile, F3 cheat menu with memory scanner and AirBreak noclip, FPS cap, English/Russian.
- **License:** MIT, with a request to credit the authors; not affiliated with Rockstar.

### What I could not find
No detailed technical write-up from the DOS Zone team about the Emscripten build, memory management, threading, or how streaming was tuned. Reading the reVCDOS source (especially `dist/modules/`) is the best next step.

## 3. Rough pipeline, summarized

```
Original GTA VC .exe
   │  decompile + rewrite (community, 2018–2020)
   ▼
reVC source (C++), RenderWare replaced by librw (OpenGL backend)
   │  Emscripten → WebAssembly; GL → WebGL 2; SDL/audio/input/file shims
   ▼
vcbr: game.wasm.br + .data.br        vcsky: models/audio/anims on CDN
   │                                    │  streamed on demand
   └────────────── browser ◄────────────┘
              IndexedDB for saves
```

## 4. Legal timeline

- **Feb 2021:** Take-Two DMCA against re3/reVC repos; GitHub takes down the main repo and forks.
- **~Dec 2025:** Take-Two, via brand-protection firm Ebrand, sends DOS Zone a DMCA demand. Stated grounds: unauthorized modifications/derivative works/emulation, use of Vice City name, artwork and branding, and possible circumvention of technological protection measures. DOS Zone complied (80.lv article dated Dec 25, 2025). Requiring users to own the game did not prevent the action.
- **After:** Reports say the game became playable again via other hosts (e.g. Quenq, mirrors of reVCDOS). I found no confirmed takedowns of those.

## 5. Takeaways if you want to build something similar

- The hard part was done by the decompilation community; the browser port is "just" an Emscripten build plus asset streaming plus platform shims.
- Shipping **code only** (no Rockstar assets) and requiring user-supplied files is the common mitigation, but the DOS Zone case shows it doesn't guarantee safety, especially if branding and a CDN hosting original assets are involved.
- An original game of your own (e.g. a Yerevan driving game) avoids all of this; the useful reusable ideas are the streaming-by-region asset loader, IndexedDB saves, brotli-packed archives, and touch/gamepad input layers.

## Sources

- [Lolendor/reVCDOS (GitHub)](https://github.com/Lolendor/reVCDOS)
- [thecmdrunner/gta-vc-re-dos (GitHub fork)](https://github.com/thecmdrunner/gta-vc-re-dos)
- [GTA Vice City Recompiled: reVC in Your Browser](https://recompiledgames.com/gta-vice-city-recompiled/)
- [GTA Vice City in Your Browser: WASM Port Explained](https://portedgames.com/gta-vice-city/)
- [Play GTA Vice City in Your Browser with a WebAssembly Demo (WindowsForum)](https://windowsforum.com/windows-news.4/play-gta-vice-city-in-your-browser-with-a-webassembly-demo.394476/)
- [mrxenginner/reVC (GitHub)](https://github.com/mrxenginner/reVC)
- [Cai1Hsu/re3 (GitHub)](https://github.com/Cai1Hsu/re3)
- [revc-git (AUR)](https://aur.archlinux.org/pkgbase/revc-git)
- [GTA III and Vice City Reverse Engineered (HotHardware)](https://hothardware.com/news/gta-3-and-vice-city-reverse-engineered)
- [Take-Two DMCA on re3/reVC (GamingOnLinux)](https://www.gamingonlinux.com/2021/02/take-two-interactive-hit-the-dmca-nuke-on-gta-iii-and-vice-city-reverse-engineered-effor/comment_id=199080)
- [Take-Two takes down browser Vice City (80.lv)](https://80.lv/articles/take-two-takes-down-browser-version-of-gta-vice-city-with-dmca-request)
- [Take-Two killed the Vice City browser port (GTABoom)](https://www.gtaboom.com/take-two-just-killed-the-vice-city-browser-port-3955)
- [Playable in browsers again (Dexerto)](https://www.dexerto.com/gta/gta-vice-city-is-playable-in-your-browser-again-after-take-two-takedown-3406096/)
- [PC Games Hardware (DE)](https://www.pcgameshardware.de/Grand-Theft-Auto-Vice-City-Spiel-4522/News/Take-Two-nimmt-Projekt-offline-1489736/)
