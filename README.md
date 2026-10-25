# Yerevan Drive (2005) – web port

A browser port of the abandoned 2005 Armenian driving game *Yerevan Drive v1.1* (Emergency Game Development Studio).
It is rebuilt from the original files and the decompiled code (Ghidra), not from screenshots: file formats (BFX, REF, CIT, TRC, car `.par`),
the original rigid-body car physics, lighting, reflections, menus (Armenian UI), HUD, minimap, races, traffic and the network modes.

## Run

    ./start.sh            # = node server.js 8099  (no dependencies, Node 18+)
    # open http://localhost:8099/   (phone on the same Wi-Fi: http://<your-LAN-IP>:8099/)

`server.js` serves `web/` and is also the multiplayer relay (WebSocket `/ws`, many games at once, session list on `/sessions`).
The game data is read from `web/game`, a link to the original game folder kept in this repo
(`wineprefix/drive_c/Program Files (x86)/Emergency/Yerevan Drive version 1.1`).

## Controls

| | |
|---|---|
| ↑ ↓ ← → | gas · brake/reverse · steer |
| Space | handbrake |
| A / Z | shift up / down (manual gearbox) |
| C · B | camera view · look behind |
| H | horn |
| M | siren (police, Gogh & Milica network game) |
| + / − | minimap zoom |
| N · P · [ ] · U | next song · previous song · music volume · mute; drop MP3s on the page to add them |
| R | back onto the nearest street |
| F3 | performance readout (fps, draw calls, GPU) |
| Enter | chat (network) |

Phones and tablets get an on-screen d-pad (right) and a STOP button (left).

## Game modes
Single player (race / free ride, 0–7 rivals, traffic, 3 hardness levels), network game (create or join a session, car choice over the live city,
Gogh & Milica cops-and-robbers, races), the metro (drive in, doors fly away, tubes can be driven on walls and ceiling).

## URL parameters (testing)
`?auto=1` skip the menus · `&mode=gonka|walker&track=N&laps=2&opps=7&hard=0..2&same=1&traffic=0` · `&car=G500&col=i&nopaint=1`
· `&net=create|join&sess=NAME&gt=0..2` · `&at=x,z,yaw` teleport · `&noshadow=1&noinst=1&fixedq=1` performance switches.

## Repository layout
- `web/` – the game: `game.js` (loop, input, audio), `sim.js` (traffic, AI, race, minimap, tyre effects), `world.js` (city, collisions, metro),
  `physics-orig.js` (original car physics), `render-orig.js` (original lighting/reflections/camera), `ui-orig.js` (original menus), `net.js`, `formats.js`, `car.js`
- `server.js`, `start.sh` – static server + multiplayer relay
- `tools/cdp.js`, `tools/ui-click.js` – headless Chromium test harness (software GL)
- `web/spec-*.md`, `PROGRESS.md` – decoded formats, physics/render specs, findings and the open list
- `run-original.sh` – run the original `.exe` under Wine (needs a Wine prefix with the game installed; the prefix itself is not in the repo)

## Running the original (reference)
Use a virtual screen so your monitors are not touched:

    Xvfb :99 -screen 0 1024x768x24 +extension RANDR +extension GLX &
    cd "wineprefix/drive_c/Program Files (x86)/Emergency/Yerevan Drive version 1.1"
    DISPLAY=:99 WINEPREFIX=$PWD/../../../.. wine "Yerevan Drive.exe"
    wineserver -k; pkill -x Xvfb

## Status
See `PROGRESS.md`. Open items: exact minimap background (`map.dds`), traffic as full physics bodies, traffic engine sounds, opponent voice lines.

The game, its data and name belong to their original authors; this repository is a preservation / research project.
