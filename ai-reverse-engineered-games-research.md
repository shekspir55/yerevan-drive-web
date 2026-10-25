# AI-Reverse-Engineered Games and Browser Ports

Research notes, compiled 2026-10-24. Companion to `vice-city-browser-port-research.md`.

**Reliability warning:** Most sources are news summaries, community lists, and blogs. Model names, percentages and counts below are *as reported* and mostly unverified by me. The Weltendämmerung guide is the one detailed first-hand account I could read in full. GameSpot and the GunZ Medium post returned 403 and were seen only through search snippets.

## TL;DR

- Since roughly Sept–Oct 2026, **hundreds** of old games have been decompiled/recompiled and made playable in browsers, with coding agents (mostly **Claude Code** and **Codex**, often driving **Ghidra/IDA through an MCP server**) doing most of the grunt work. Kotaku credits Claude Opus 5.5 specifically; this is the media's claim, not something I could verify.
- Three different techniques get lumped together as "reverse engineered with AI":
  1. **Matching decompilation**: rebuild C source that compiles to byte-identical code (N64/PS1 scene).
  2. **Static recompilation / functional reconstruction**: translate or rewrite code so it behaves the same, then build for PC/WASM.
  3. **Porting an existing decompilation or leaked source** to the web (this is what Vice City, Halo, and GTA V browser ports mostly are; AI handles the porting glue).
- Typical safeguard: the site ships **no game data**; the user supplies their own disc/ROM image. Publishers still send DMCA notices.

## 1. The scale

- Community catalogue [reversedwithai.com](https://reversedwithai.com/ai-game-decompilation): about **195–211 projects**, roughly 80–86 marked *working*, ~105 *partial*, ~10 *research*.
- Kotaku (via [Techmeme](https://www.techmeme.com/261010/p17) and [heise](https://www.heise.de/en/news/Halo-Vice-City-Black-Ops-AI-ports-of-games-run-in-the-browser-11485764.html)): hundreds of decompiled games and browser ports appeared "in recent weeks"; some run nearly flawlessly, some have working online servers.
- heise notes it's often unclear how much AI was involved in each project.

## 2. Notable projects

### Browser ports
| Game | Notes | Source |
|---|---|---|
| GTA: Vice City | reVC engine to WASM (see companion doc); taken down by Take-Two in Dec 2025, mirrors persist | [80.lv](https://80.lv/articles/take-two-takes-down-browser-version-of-gta-vice-city-with-dmca-request) |
| Halo: Combat Evolved | Mitchell Hynes, late Sept 2026; builds on others' decompilation projects; site ships no data, user picks their Xbox disc image | [heise](https://www.heise.de/en/news/Halo-Vice-City-Black-Ops-AI-ports-of-games-run-in-the-browser-11485764.html) |
| Call of Duty: Black Ops | Listed among browser ports; Activision reportedly sent takedowns/C&Ds | heise |
| The Simpsons: Hit & Run | Rebuilt with Three.js, runs locally rather than streaming | heise |
| Banjo-Tooie | AI-generated port on top of the Banjo: Recompiled team's tools; Banjo-Kazooie PC port dev publicly distanced himself, calling it disrespectful to build on human groundwork with AI | heise |
| GTA V (playgta5.com) | Launched Oct 6, 2026; reportedly killed by Take-Two within hours; reports say it leaned on previously leaked Rockstar source | [Startup Fortune](https://startupfortune.com/ai-reverse-engineering-turns-gta-5-and-halo-into-browser-games-overnight/) |
| GunZ: The Duel (2003) | One dev ran it in-browser via WASM + WebGL with AI assistance | [Medium](https://medium.com/@sutead/claude-code-let-me-bring-a-20-year-old-game-to-the-browser-with-minimal-code-changes-51a954ce882e) (not readable) |
| Desktop Games (2000, Gemtree) | Ported to macOS and browser with Claude Code, REA and Ghidra | [awesome-reverse-engineer-anything](https://github.com/AIshihzong/awesome-reverse-engineer-anything) |
| GTA 2 (freeware) | Browser version on top of a matching decompilation, built with Claude Code | reversedwithai.com |

### Native/desktop recompilations and decompilations (from the reversedwithai list)
SkyRoads (DOS, C port), Super Mario 64 DS, GoldenEye 007 (N64 to PC), Sonic CD, Star Fox 2, Harvest Moon: Back to Nature (PS1), Zelda: Wind Waker HD, Street Fighter Alpha 3 (Dreamcast), plus *partial* efforts on Devil May Cry 3, Super Smash Bros. Ultimate, Crash Twinsanity, Chibi-Robo!, Dark Sun: Shattered Lands. Model attributions on that page range across Claude Opus/Sonnet/Fable versions; treat as self-reported.

### Matching-decompilation milestones
- **Snowboard Kids 2 (N64)**, Chris Lewis: reported 100% match (May 2026). The first game's 2,145 functions reportedly took **84 days vs 596** for the sequel's workflow. He said the project "would have stalled around 89–90%" without human IDO-compiler expertise. ([TechSpot](https://www.techspot.com/article/3184-decompilation-on-steroids/), [AI Signal](https://aisignal.day/en/ai-game-decompilation-2026/))
- **Brave Fencer Musashi (PS1)**, BFM-decomp: 218 byte-identical binaries using Claude Code + Ghidra over MCP + PCSX-Redux and a pinned GCC 2.7.2 toolchain; readability work remains. ([Retro Reversing](https://www.retroreversing.com/ai-assisted-decompilation))
- **Super Mario 64 DS**: reportedly 99.9% of functions matched with AI help.
- **Animal Forest benchmark** (Macabeus): 60 functions, ~74% average match across two platforms; decomp-permuter plus Claude output matched 7 functions across 3 runs. Small sample. ([Medium](https://macabeus.medium.com/can-llms-really-do-matching-decompilation-i-tested-60-functions-to-find-out-4e39b0ae4288))
- Retrobench figure cited by Retro Reversing: Opus 5.5 at 98.4% mean byte match over five N64-era MIPS targets (partial similarity, narrow test). ProgramBench: 18.5% fully resolved without disassembly. Unverified.

## 3. A worked example: Weltendämmerung (C64, 1980s)

The best-documented workflow: [s-macke/weltendaemmerung](https://github.com/s-macke/weltendaemmerung).

- **Stack:** Claude Code with Opus 4.5; a Python 6502 disassembler the model wrote itself; `strings`/`xxd`; Playwright for UI tests; Vite + TypeScript + Tailwind for the web port.
- **Steps:**
  1. Summarize the 7,129-byte binary into a short `CLAUDE.md`.
  2. Build a flow-analysis disassembler separating code from data.
  3. Split the ~2,700-line disassembly into ~12 files by address range (it overflowed the context window).
  4. Document memory layout, variables, tiles, map, units, game phases, and C64 tricks (BCD arithmetic, self-modifying code).
  5. Write a detailed requirements prompt, have the agent read all docs, then produce `PORTING.md`.
  6. Implement step by step over parallel sessions, then a UI redesign pass.
- **Result:** playable web port with original terrain/units preserved; ~3 days, ~$100 API cost, 50+ sessions.
- **Pitfalls:** wrong file descriptions, tiles in wrong colors (ignored C64 context-dependent coloring), forest tiles misidentified, a variable used as both number and flag not noticed until the human said so, verbose output, "not pretty" code.
- **Lessons:** spec-driven development with small markdown files; keep `CLAUDE.md` short and linking out; short sessions to avoid compaction; ask the model to "check your assignment"; the human's role becomes directing, verifying and correcting. "Two steps forward, one step back, and one step sideways."

## 4. Common methodology patterns

From [reversedwithai.com](https://reversedwithai.com/ai-game-decompilation) and [Retro Reversing](https://www.retroreversing.com/ai-assisted-decompilation):

1. **Disassembly-first:** agent reads machine code via Ghidra/IDA (often over an MCP server), renames functions, labels data, recovers types.
2. **Core loop for matching decomp:** disassemble function, AI proposes C, compile with the *original* compiler, diff, revise until bytes match.
3. **Ground truth is the key enabler:** a byte-diff, emulator frame comparison, or reference implementation (MAME, Supermodel) lets the agent verify itself. Matching decomp is ideal because a machine judges right/wrong.
4. **Tools:** Ghidra, GhidrAssist, splat (split ROMs), m2c (MIPS to C), asm-differ, decomp-permuter, ido-static-recomp, decomp.me; agent-oriented: REA ([morluto/rea](https://github.com/morluto/rea)); decomp.wtf reportedly discontinued Oct 15, 2026.
5. **Notes-driven, multi-agent:** shared work queues and per-game knowledge notes; keep docs small.
6. **User-supplied assets:** most projects require your own disc/ROM.
7. **Outputs beyond ports:** widescreen, high frame rate, mods.

## 5. Limitations and criticism

- Matching bytes does not mean readable or original source; wrong types/signedness can look plausible.
- Compiler version and flags matter enormously (IDO for N64 was a human-expertise bottleneck).
- Single functions miss overlays, hardware registers, game context.
- Benchmarks are small-sample; claims come from the operators.
- Uploading game binaries to hosted AI raises confidentiality questions.
- Community friction: original decomp authors object to AI projects riding on their work.
- Eric S. Raymond (via heise): AI decompilation could make closed-source software generally much easier to reverse.

## 6. Legal landscape

- Publishers (Take-Two, Activision) issue DMCA takedowns and C&Ds; ports have gone offline, social posts and videos removed.
- "Bring your own game data" is the standard mitigation but doesn't prevent takedowns (see DOS Zone).
- Ports built on leaked source (reported for GTA V) are on the weakest ground.
- Studio-side perspective: [Edgegap, "AI Can Now Reverse-Engineer Games. What Can Studios Do About It?"](https://edgegap.com/blog/ai-can-now-reverse-engineer-games.-what-can-studios-do-about-it)

## 7. Takeaways for a browser game project

- Agents work best where there is an automatic check (byte match, emulator diff, tests). Build that harness first.
- Structure the work as small markdown specs plus a short `CLAUDE.md`; keep sessions short.
- For web delivery, the proven recipe is native engine to WASM/WebGL, user-supplied or streamed assets, IndexedDB saves.
- Budget for human review: the author of the C64 port had to catch visual and semantic errors the model couldn't see.

## Sources

- [Techmeme / Kotaku summary](https://www.techmeme.com/261010/p17)
- [heise: Halo, Vice City, Black Ops AI ports](https://www.heise.de/en/news/Halo-Vice-City-Black-Ops-AI-ports-of-games-run-in-the-browser-11485764.html)
- [GameSpot: guide to vibe-coded ports](https://www.gamespot.com/articles/why-do-big-games-keep-being-made-playable-in-browsers-a-guide-to-vibe-coded-ports/) (403, snippet only)
- [Startup Fortune: GTA 5 and Halo as browser games](https://startupfortune.com/ai-reverse-engineering-turns-gta-5-and-halo-into-browser-games-overnight/)
- [reversedwithai.com list](https://reversedwithai.com/ai-game-decompilation) and [Claude projects](https://reversedwithai.com/claude-reverse-engineering)
- [Recompiled Games](https://recompiledgames.com/)
- [awesome-reverse-engineered-games](https://github.com/heaven-hm/awesome-reverse-engineered-games)
- [awesome-reverse-engineer-anything](https://github.com/AIshihzong/awesome-reverse-engineer-anything)
- [awesome-ai-browser-games](https://github.com/seraseraqqq/awesome-ai-browser-games)
- [s-macke/weltendaemmerung](https://github.com/s-macke/weltendaemmerung)
- [Medium: GunZ to the browser with Claude Code](https://medium.com/@sutead/claude-code-let-me-bring-a-20-year-old-game-to-the-browser-with-minimal-code-changes-51a954ce882e)
- [Retro Reversing: AI-assisted decompilation](https://www.retroreversing.com/ai-assisted-decompilation)
- [TechSpot: Decompilation on Steroids](https://www.techspot.com/article/3184-decompilation-on-steroids/)
- [AI Signal: N64 game in 84 days](https://aisignal.day/en/ai-game-decompilation-2026/)
- [Capital & Compute: verified list](https://capitalandcompute.net/blog/which-games-has-ai-decompiled/)
- [MindStudio explainer](https://www.mindstudio.ai/blog/ai-decompiling-video-games-explained)
- [HF blog: Teaching an LLM to Decompile the N64](https://huggingface.co/blog/MatthewReingold/n64-decomp-dev-blog)
- [Macabeus: 60-function matching test](https://macabeus.medium.com/can-llms-really-do-matching-decompilation-i-tested-60-functions-to-find-out-4e39b0ae4288)
- [DataCamp: REA tutorial](https://www.datacamp.com/tutorial/reverse-engineer-anything-rea-tutorial)
- [Edgegap: what studios can do](https://edgegap.com/blog/ai-can-now-reverse-engineer-games.-what-can-studios-do-about-it)
- [arXiv GameLogicBench](https://arxiv.org/pdf/2609.21562), [arXiv WebGameBench](https://arxiv.org/pdf/2605.17637)
