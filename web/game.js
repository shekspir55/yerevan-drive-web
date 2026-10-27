// Yerevan Drive (web port) – game shell: menu, loading, input, camera, HUD, audio.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const vfs = new YD.VFS();
  const CAR_FOLDERS = ['2110', 'A190', 'bmw', 'CL600', 'G500', 'gazel', 'Honda', 'HUMMER', 'Kamaz', 'mits', 'Nissan', 'niva', 'Peugeot', 'Toyota', 'TT', 'UAZ', 'Vaz 2108'];

  const state = { carcol: [], carNames: {}, selected: 'bmw', color: 1, mode: 'walker', G: null, opts: { track: 0, laps: 2, opponents: 7, traffic: true } };

  // ---------------- boot / file access ----------------
  async function boot() {
    $('status').textContent = 'Looking for game files…';
    if (!(await vfs.exists('config.ini'))) { showPicker(); return; }
    await menu();
  }
  function showPicker() {
    $('status').textContent = '';
    $('picker').style.display = 'block';
    $('folder').addEventListener('change', async e => {
      vfs.setFolder(e.target.files);
      if (!(await vfs.exists('config.ini'))) { $('pickmsg').textContent = 'That folder does not look like Yerevan Drive (config.ini not found).'; return; }
      $('picker').style.display = 'none'; await menu();
    });
  }

  async function classicMenu() {
    const ini = await vfs.ini('Cars/carcol.ini');
    state.carcol = Object.keys(ini).sort().map(k => [+ini[k].R, +ini[k].G, +ini[k].B]);   // the original palette is exactly carcol.ini (10 colours, no white)
    // read car names from par files for the menu
    const sel = $('car'); sel.innerHTML = '';
    for (const f of CAR_FOLDERS) {
      if (!(await vfs.exists('Cars/' + f + '/avto.par'))) continue;
      const p = YDCar.readPar(await vfs.bytes('Cars/' + f + '/avto.par'));
      state.carNames[f] = p.name; const o = document.createElement('option'); o.value = f; o.textContent = p.name; sel.appendChild(o);
    }
    sel.value = state.selected;
    const cs = $('colors'); cs.innerHTML = '';
    state.carcol.forEach((c, i) => {
      const b = document.createElement('button'); b.className = 'sw' + (i === state.color ? ' on' : '');
      b.style.background = `rgb(${c.map(x => Math.round(x * 255)).join(',')})`;
      b.onclick = () => { state.color = i; [...cs.children].forEach((x, j) => x.classList.toggle('on', j === i)); };
      cs.appendChild(b);
    });
    // race options (defaults from the original config.ini [SINGLE])
    let cfg = {}; try { cfg = (await vfs.ini('config.ini')).SINGLE || {}; } catch (e) { }
    const tr = $('track'); tr.innerHTML = ''; for (let i = 0; i < 28; i++) { if (!(await vfs.exists('Tracks/track' + i + '.trc'))) continue; const o = document.createElement('option'); o.value = i; o.textContent = 'Track ' + (i + 1); tr.appendChild(o); }
    const lp = $('laps'); lp.innerHTML = ''; for (let i = 1; i <= 10; i++) { const o = document.createElement('option'); o.value = i; o.textContent = i; lp.appendChild(o); }
    const op = $('opps'); op.innerHTML = ''; for (let i = 0; i <= 7; i++) { const o = document.createElement('option'); o.value = i; o.textContent = i; op.appendChild(o); }
    lp.value = cfg.Laps || 2; op.value = cfg.NumOpponents === undefined ? 7 : cfg.NumOpponents; $('traffic').checked = cfg.Traffic !== '0';
    $('mode').onchange = () => { $('raceopts').style.display = $('mode').value === 'gonka' ? 'block' : 'none'; };
    $('status').textContent = ''; $('menu').style.display = 'flex';
    const Q = new URLSearchParams(location.search);
    if (Q.get('car')) { state.selected = Q.get('car'); sel.value = Q.get('car'); }
    if (Q.get('col')) state.color = +Q.get('col');
    if (Q.get('mode')) { $('mode').value = Q.get('mode'); $('mode').onchange(); }
    if (Q.get('track')) tr.value = Q.get('track'); if (Q.get('laps')) lp.value = Q.get('laps'); if (Q.get('opps')) op.value = Q.get('opps'); if (Q.get('traffic')) $('traffic').checked = Q.get('traffic') !== '0';
    $('start').onclick = () => {
      state.selected = sel.value; state.mode = $('mode').value;
      state.opts = { track: +tr.value, laps: +lp.value, opponents: +op.value, traffic: $('traffic').checked };
      $('menu').style.display = 'none'; start().catch(fail);
    };
    setTimeout(() => autostart(), 0);
  }
  // ---- front end: the original UI ported from the decompiled code (ui-orig.js): splash -> menus -> game ----
  async function menu() {
    const Q = new URLSearchParams(location.search);
    if (Q.has('classic') || !window.YDUI) return classicMenu();
    await initCarList();
    const cv = $('uicanvas'); cv.style.display = 'block'; cv.tabIndex = 0;
    const layout = () => { const k = Math.min(innerWidth / 1024, innerHeight / 768), w = Math.floor(1024 * k), h = Math.floor(768 * k); cv.style.width = w + 'px'; cv.style.height = h + 'px'; cv.style.left = Math.floor((innerWidth - w) / 2) + 'px'; cv.style.top = Math.floor((innerHeight - h) / 2) + 'px'; };
    layout(); addEventListener('resize', layout);
    $('status').textContent = '';
    const ui = await YDUI.create({ canvas: cv, vfs, preview: true, skipSplash: Q.has('skipsplash') || Q.has('auto'), onStartGame: cfg => fromUI(ui, cfg), onQuit: () => { ui.stop(); cv.style.display = 'none'; document.body.style.background = '#000'; $('status').textContent = 'You can close this tab.'; } });
    state.ui = ui; window.UIOBJ = ui; ui.onGameCommand = gameCommand; ui.onSettings = st => applyVolume(st); ui.onNetwork = (a, d) => netStart(ui, a, d); ui.run(); cv.focus();
    if (Q.has('auto')) { // test aid: skip the menus
      if (Q.has('nopaint')) state.carcol = [];   // the original under Wine finds no carcol.ini palette (relative path) -> cars keep their material colour
      if (Q.has('colrgb')) state.carcol[+(Q.get('col') || 1)] = Q.get('colrgb').split(',').map(Number);
      if (Q.has('net')) return netStart(ui, Q.get('net'), { name: 'Tester' + ((Math.random() * 99) | 0), password: '', session: Q.get('sess') || 'test', maxPlayers: 2, gameType: +(Q.get('gt') || 0), laps: 2 });
      fromUI(ui, { car: { folder: Q.get('car') || 'bmw' }, colorIdx: +(Q.get('col') || 1), plateType: Q.has('pt') ? +Q.get('pt') : ui.settings.plateType, plateText: Q.has('ptx') ? Q.get('ptx') : ui.settings.plateText, auto: !Q.has('manual'), race: Q.get('mode') === 'gonka', laps: +(Q.get('laps') || 2), opponents: Q.has('opps') ? +Q.get('opps') : 7, traffic: Q.get('traffic') === '0' ? -1 : Q.has('tl') ? +Q.get('tl') : 1, hardness: +(Q.get('hard') || 1), opponentCars: Q.get('same') ? 1 : 0, track: Q.has('track') ? +Q.get('track') : undefined });
    }
  }
  async function initCarList() {
    const ini = await vfs.ini('Cars/carcol.ini');
    state.carcol = Object.keys(ini).sort((a, b) => +a.replace(/\D/g, '') - +b.replace(/\D/g, '')).map(k => [+ini[k].R, +ini[k].G, +ini[k].B]);
    for (const f of CAR_FOLDERS) { if (!(await vfs.exists('Cars/' + f + '/avto.par'))) continue; state.carNames[f] = YDCar.readPar(await vfs.bytes('Cars/' + f + '/avto.par')).name; }
  }
  function fromUI(ui, cfg) { // cfg comes from the original single-player screen (FUN_00430f80 flow)
    state.selected = cfg.car.folder; state.color = cfg.colorIdx; state.plate = { type: cfg.plateType, text: cfg.plateText }; state.auto = cfg.auto !== false;
    state.mode = cfg.race ? 'gonka' : 'walker';
    state.opts = { track: cfg.track !== undefined ? cfg.track : Math.floor(Math.random() * 28), laps: cfg.laps, opponents: Math.min(7, cfg.opponents), traffic: cfg.traffic !== -1, trafficCount: [8, 16, 28][cfg.traffic === undefined ? 1 : cfg.traffic] || 25, hardness: cfg.hardness || 0, sameCar: cfg.opponentCars === 1 };
    ui.setMode('loading', 0); start().catch(fail);
  }
  // network screen (original 0x27): 'create' opens a session on the relay (server.js), 'join' enters the open one
  function toast(msg) { const d = document.createElement('div'); d.textContent = msg; d.style.cssText = 'position:fixed;left:50%;top:24px;transform:translateX(-50%);background:rgba(120,20,20,.92);color:#fff;font:16px sans-serif;padding:10px 18px;border-radius:6px;z-index:50'; document.body.appendChild(d); setTimeout(() => d.remove(), 6000); }
  function netStart(ui, action, d) {
    state.net = { action, d }; state.mode = 'walker'; state.auto = d.auto !== false;
    if (d.car) { state.selected = d.car.folder; state.color = d.colorIdx; state.plate = { type: d.plateType, text: d.plateText }; }   // car chosen on the GMCar screen
    state.opts = { track: 0, laps: 2, opponents: 0, traffic: true, trafficCount: 10, hardness: 0 };
    ui.setMode('loading', 0);
    start().catch(e => {   // original message texts ([STRINGS] SessionFull / WrongPassword / Server) in the original dialog box
      state.net = null; console.error(e); ui.show(0x27, false); ui.setMode && ui.setMode('menu');
      const key = { full: 'SessionFull', password: 'WrongPassword', server: 'Server' }[e && e.code]; ui.message(key ? ui.S('STRINGS', key, e.message) : String(e && e.message || e));
    });
  }
  // police siren (two-tone, Web Audio); the original plays a siren sample and flashes the 'migalka' light bar
  // sirens are keyed by owner ('me' or 'n<id>'); remote ones get quieter with distance (see loop)
  const sirens = new Map();
  function setSiren(key, on) {
    const ctx = AU.ctx; if (!ctx) return;
    const cur = sirens.get(key);
    if (!on) { if (cur) { clearInterval(cur.t); cur.o.stop(); sirens.delete(key); } return; }
    if (cur) return;
    if (AU.police) { const o = ctx.createBufferSource(), g = ctx.createGain(); o.buffer = AU.police; o.loop = true; g.gain.value = key === 'me' ? 0.5 : 0.3; o.connect(g); g.connect(AU.sfx || ctx.destination); o.start(); sirens.set(key, { o, g, t: 0, base: g.gain.value }); return; }   // police.wav
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'square'; g.gain.value = 0.04; o.connect(g); g.connect(AU.sfx || ctx.destination); o.start();
    let hi = false; const t = setInterval(() => { hi = !hi; o.frequency.value = hi ? 960 : 720; }, 450); sirens.set(key, { o, g, t });
  }
  function toggleSiren() {
    const on = !sirens.has('me'); setSiren('me', on); G.player.siren = on;
    if (G.net) G.net.sendSiren(on);
  }
  function updateSirens() {
    for (const [k, s] of sirens) {
      if (k === 'me') continue; const r = G.net && G.net.remote.get(+k.slice(1)); if (!r) { setSiren(k, false); continue; }
      s.g.gain.value = (s.base || 0.04) * Math.max(0, 1 - r.car.obj.position.distanceTo(G.camera.position) / 200);
    }
  }
  // in-game chat (multiplayer): Enter opens the input, Enter again sends, Esc cancels; lines fade after 8 s
  function chatLine(text) {
    const box = $('chatlog'); if (!box) return; const d = document.createElement('div'); d.textContent = text; box.appendChild(d);
    while (box.children.length > 6) box.removeChild(box.firstChild); setTimeout(() => d.remove(), 8000);
  }
  function setupChat(net) {
    if ($('chatbox')) return; const wrap = document.createElement('div'); wrap.id = 'chatbox';
    wrap.style.cssText = 'position:fixed;left:12px;bottom:70px;width:340px;font:14px sans-serif;color:#fff;z-index:20;pointer-events:none;text-shadow:0 1px 2px #000';
    wrap.innerHTML = '<div id="chatlog"></div><input id="chatin" maxlength="100" style="display:none;width:100%;pointer-events:auto;background:rgba(0,0,0,.6);color:#fff;border:1px solid #888;padding:4px;box-sizing:border-box">';
    document.body.appendChild(wrap); const inp = $('chatin');
    addEventListener('keydown', e => { if (e.code === 'Enter' && inp.style.display === 'none') { inp.style.display = 'block'; inp.focus(); e.preventDefault(); } });
    inp.addEventListener('keydown', e => {
      e.stopPropagation();   // typing must not drive the car
      if (e.code === 'Enter') { const t = inp.value.trim(); if (t) { net.sendChat(t); chatLine(armToU(net.hello.name) + ': ' + t); } inp.value = ''; inp.style.display = 'none'; inp.blur(); }
      else if (e.code === 'Escape') { inp.value = ''; inp.style.display = 'none'; inp.blur(); }
    });
    inp.addEventListener('keyup', e => e.stopPropagation());
  }
  // ArmSCII-8 (game font bytes) -> Unicode, for names shown in HTML (chat)
  const armToU = s => String(s || '').replace(/[\xb2-\xff]/g, ch => { const k = ch.charCodeAt(0) - 0xb2; return k < 76 ? String.fromCharCode((k & 1 ? 0x561 : 0x531) + (k >> 1)) : ch; });
  // network messages ([STRINGS] LeaveGame, PleaseRestart, Server) drawn with the game font at the top of the screen for 5 s
  // FUN_00427350 (text, r, g, b): ring of 8, life 5 s; drawn by FUN_00427410 newest first at x -0.95, y 0.95 - 0.07*i, small font 0.05, alpha life*255 below 1 s.
  // The original stores all three colour bytes into the same byte (red; green/blue stay 0), so the colour is red = the b argument: PleaseRestart (0,0,255) red,
  // Busted (255,0,0) and LeaveGame (0,255,0) black. argb overrides it (Server down: not a ring message in the original).
  function netMsg(text, b, argb) { if (!G) return; const m = G.netMsgs = G.netMsgs || []; m.unshift({ text, t: performance.now(), rgb: argb !== undefined ? argb & 0xffffff : ((b || 0) & 255) << 16 }); if (m.length > 8) m.length = 8; }
  function stopSirens() { for (const k of [...sirens.keys()]) setSiren(k, false); }
  function autostart() { if (new URLSearchParams(location.search).has('auto')) $('start').click(); }
  function fail(e) { console.error(e); $('menu').style.display = 'none'; $('loading').style.display = 'flex'; $('lmsg').textContent = 'Error: ' + (e && e.message || e); }

  const DEMO = new URLSearchParams(location.search).has('demo');
  // ---------------- input ----------------
  const keys = new Set(); const pressed = new Set();
  addEventListener('keydown', e => { if (!keys.has(e.code)) pressed.add(e.code); keys.add(e.code); if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'F3'].includes(e.code)) e.preventDefault(); });
  addEventListener('keyup', e => keys.delete(e.code)); addEventListener('blur', () => { keys.clear(); horn(false); });
  const touch = { steer: 0, throttle: 0, brake: 0, hb: false };
  function bindTouch() {
    const set = (id, fn, off) => { const el = $(id); if (!el) return; const on = e => { e.preventDefault(); fn(true); }; const of = e => { e.preventDefault(); fn(false); };
      el.addEventListener('pointerdown', on); el.addEventListener('pointerup', of); el.addEventListener('pointerleave', of); el.addEventListener('pointercancel', of); };
    set('tl', d => touch.steer = d ? -1 : (touch.steer < 0 ? 0 : touch.steer)); set('tr', d => touch.steer = d ? 1 : (touch.steer > 0 ? 0 : touch.steer));
    set('tg', d => touch.throttle = d ? 1 : 0); set('tb', d => touch.brake = d ? 1 : 0); set('th', d => touch.hb = d);
    set('tho', d => { if (d) keys.add('KeyH'); else keys.delete('KeyH'); }); set('tc', d => { if (d) pressed.add('KeyC'); });
    // phones / tablets: on-screen d-pad (right) and STOP = handbrake (left); also shown after the first touch on a hybrid device
    const show = () => { window.touchMode = true; $('touch').style.display = 'block'; $('menubtn').style.display = 'block'; };   // no Esc key on a phone: menu button (touch only)
    if (matchMedia('(pointer:coarse)').matches || navigator.maxTouchPoints > 0 && !matchMedia('(pointer:fine)').matches) show(); else addEventListener('touchstart', show, { once: true, passive: true });
  }
  function readInput() {
    const k = c => keys.has(c);
    // controls follow the original readme: arrows drive, Space handbrake, A/Z shift up/down
    const i = {
      throttle: Math.max(k('ArrowUp') ? 1 : 0, touch.throttle),
      brake: Math.max(k('ArrowDown') ? 1 : 0, touch.brake),
      steer: (k('ArrowRight') ? 1 : 0) - (k('ArrowLeft') ? 1 : 0),
      handbrake: k('Space') || touch.hb,
      shiftUp: pressed.has('KeyA'), shiftDown: pressed.has('KeyZ'),
    };
    if (touch.steer) i.steer = touch.steer;
    if (DEMO) { i.throttle = 1; i.steer = Math.sin(G.t * 0.6) * 0.5; }
    i.steer = -i.steer; // world is mirrored on X: physics heading increases toward the driver's left
    return i;
  }

  // ---------------- audio ----------------
  const AU = window.AU = { ctx: null, engine: null, engGain: null, music: null, songs: [], songIdx: 0, enabled: true };
  // [VOLUME] Sound/Music 0..100 as the original applies them: Sound = DirectMusic master volume (Sound*5-500)*4 /100 dB (FUN_004089c0: 50 -> -10 dB,
  // 0 -> -20 dB) on every effect; Music = DirectShow put_Volume (Music-100)*30 /100 dB, 0 = off (FUN_0042bc10: 50 -> -15 dB). Sliders: ui.onSettings
  const YDVol = window.YDVol = { sfx: s => Math.pow(10, (Math.min(100, Math.max(0, s)) - 100) / 100), music: s => s > 0 ? Math.pow(10, (Math.min(100, s) - 100) * 0.015) : 0 };
  function applyVolume(st) { st = st || (state.ui && state.ui.settings); if (!st) return; if (AU.sfx) AU.sfx.gain.value = YDVol.sfx(st.sound); AU.musicVol = YDVol.music(st.music); if (AU.music) AU.music.volume = AU.musicVol; if (state.ui && state.ui.menuMusic) state.ui.menuMusic.volume = AU.musicVol; }
  // Browsers keep an AudioContext (created after the long loading phase, so after the click's activation expired) suspended and block music
  // autoplay until the next user gesture: resume on every key press / click.
  function unlockAudio() {
    if (AU.ctx && AU.ctx.state === 'suspended') AU.ctx.resume().catch(() => { });
    if (AU.music && AU.music.paused && !AU.mutedByUser && window.G && !G.paused && !G.lobby) AU.music.play().catch(() => { });
  }
  ['keydown', 'pointerdown', 'mousedown', 'touchstart'].forEach(ev => addEventListener(ev, unlockAudio, true));
  async function initAudio(carFolder) {
    try {
      AU.ctx = new (window.AudioContext || window.webkitAudioContext)();
      AU.ctx.resume().catch(() => { });
      AU.sfx = AU.ctx.createGain(); AU.sfx.connect(AU.ctx.destination); applyVolume();   // every effect goes through AU.sfx (Sound slider)
      await Promise.all([carFolder, ...carFolders].map(f => engBuf(f).p));   // engine.wav of every model loaded so far (player, rivals, traffic, remotes); later ones load on first use
      loadVoices().catch(e => console.warn('voices', e));
    } catch (e) { console.warn('engine audio', e); }
    try { const cs = YD.readBFX(await vfs.bytes('Cars/carstd.snd')); AU.horns = []; for (let i = 0; i < 3; i++) { const h = cs.get('horn' + i + '.wav'); if (h) AU.horns.push(await AU.ctx.decodeAudioData(h.slice(0))); } AU.horn = AU.horns[Math.floor(Math.random() * AU.horns.length)]; /* every car (the player too) gets horn rand()%3 at creation (FUN_00410270) */ const sk = cs.get('skid.wav'); if (sk) { try { AU.skidBuf = await AU.ctx.decodeAudioData(imaToWav(sk)); } catch (e) { console.warn('skid', e); } } try { const po = cs.get('police.wav'); if (po) AU.police = await AU.ctx.decodeAudioData(msToWav(po)); } catch (e) { console.warn('police', e); } try { AU.start = []; for (const n of ['start0.wav', 'start1.wav']) { const b = cs.get(n); if (b) AU.start.push(await AU.ctx.decodeAudioData(b.slice(0))); } } catch (e) { } AU.bum = []; for (let i = 0; i < 5; i++) { const b = cs.get('bum' + i + '.wav'); /* 'bum.wav' x5 variants = bum0..4 (bum5.WAV is in the archive but never loaded) */ if (b) AU.bum.push(await AU.ctx.decodeAudioData(b.slice(0))); } } catch (e) { console.warn('horn', e); }
    // music: MP3/*.mp3 (listing from folder picker, or track_NN.mp3 probing)
    AU.songs = [];
    if (!vfs.files) try { const r = await fetch('/playlist'); if (r.ok) AU.songs = (await r.json()).filter(n => typeof n === 'string'); } catch (e) { }   // server.js lists every MP3/*.mp3 (any name, like the original)
    if (!vfs.files && !AU.songs.length) for (let i = 1; i < 30; i++) { const n = 'MP3/track_' + String(i).padStart(2, '0') + '.mp3'; if (await vfs.exists(n)) AU.songs.push(n); else if (i > 12) break; }   // static hosting without the list
    if (vfs.files) for (const k of vfs.files.keys()) if (/^mp3\/.*\.mp3$/.test(k) && !AU.songs.some(s => s.toLowerCase() === k)) AU.songs.push(k);
    if (AU.songs.length) nextSong(true);
  }
  // playlist entries are paths in the game folder, or {name, url} for MP3 files the player dropped onto the page
  async function nextSong(first, step) {
    if (!AU.songs.length || !AU.ctx) return;
    if (AU.music) { AU.music.pause(); if (AU.music.dataset.own !== '1') URL.revokeObjectURL(AU.music.src); }
    const n = AU.songs.length; AU.songIdx = (((step === -1 ? AU.songIdx - 2 : AU.songIdx) % n) + n) % n;
    const e = AU.songs[AU.songIdx++ % n]; let url;
    const stream = typeof e === 'string' && !vfs.files;   // served game folder: let <audio> stream the MP3 instead of downloading it first
    if (typeof e !== 'string') url = e.url; else if (stream) url = vfs.url(e); else url = URL.createObjectURL(new Blob([await vfs.bytes(e)], { type: 'audio/mpeg' }));
    const a = new Audio(url); if (typeof e !== 'string' || stream) a.dataset.own = '1';
    a.volume = AU.musicVol === undefined ? YDVol.music(50) : AU.musicVol; a.onended = () => nextSong(); AU.music = a; if (!AU.mutedByUser) a.play().catch(() => { });
    $('song').textContent = '♪ ' + (typeof e === 'string' ? e : e.name).split('/').pop();
  }
  // drop MP3 files onto the page to add them to the playlist (the original reads any MP3 in its \MP3\ folder)
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', e => {
    e.preventDefault(); const fs = [...(e.dataTransfer && e.dataTransfer.files || [])].filter(f => /\.(mp3|ogg|wav|m4a)$/i.test(f.name)); if (!fs.length) return;
    for (const f of fs) AU.songs.push({ name: f.name, url: URL.createObjectURL(f) });
    AU.songIdx = AU.songs.length - fs.length; nextSong(); toast && toast(fs.length + ' song(s) added');
  });
  function musicVolume(d) { const st = state.ui && state.ui.settings; if (!st) return; st.music = Math.max(0, Math.min(100, Math.round((st.music || 0) + d * 100))); applyVolume(st); $('song').textContent = '♪ volume ' + st.music + '%'; }   // [ ] step the Music setting
  // any WAV from the .snd archives -> a copy decodeAudioData accepts (PCM as is; IMA 0x11 / MS 2 ADPCM converted)
  function toPcm(buf) {
    const u = new Uint8Array(buf), dv = new DataView(buf); let p = 12, f = 1;
    while (p + 8 <= u.length) { const n = dv.getUint32(p + 4, true); if (String.fromCharCode(u[p], u[p + 1], u[p + 2], u[p + 3]) === 'fmt ') { f = dv.getUint16(p + 8, true); break; } p += 8 + n + (n & 1); }
    return f === 0x11 ? imaToWav(buf) : f === 2 ? msToWav(buf) : buf.slice(0);
  }
  // skid.wav is IMA ADPCM (WAVE format 0x11), which browsers cannot decode: convert to 16-bit PCM WAV
  function imaToWav(buf) {
    const u = new Uint8Array(buf), dv = new DataView(u.buffer, u.byteOffset, u.byteLength); let p = 12, fmt = null, data = null;
    while (p + 8 <= u.length) { const id = String.fromCharCode(u[p], u[p + 1], u[p + 2], u[p + 3]), n = dv.getUint32(p + 4, true); if (id === 'fmt ') fmt = p + 8; else if (id === 'data') { data = [p + 8, Math.min(n, u.length - p - 8)]; break; } p += 8 + n + (n & 1); }
    if (!fmt || !data) throw new Error('bad wav');
    const ch = dv.getUint16(fmt + 2, true), rate = dv.getUint32(fmt + 4, true), ba = dv.getUint16(fmt + 12, true), spb = dv.getUint16(fmt + 18, true);
    const IT = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767], IX = [-1, -1, -1, -1, 2, 4, 6, 8];
    const blocks = Math.floor(data[1] / ba), out = new Int16Array(blocks * spb * ch);
    for (let b = 0; b < blocks; b++) for (let c = 0; c < ch; c++) {
      let o = data[0] + b * ba + c * 4, pred = dv.getInt16(o, true), idx = Math.min(88, u[o + 2]), n = 0; out[(b * spb) * ch + c] = pred; n++;
      const body = data[0] + b * ba + ch * 4;   // mono: nibbles follow the header (stereo interleaves 4-byte groups)
      for (let i = 0; n < spb; i++) {
        const base = ch === 1 ? body + i : body + Math.floor(i / 4) * 4 * ch + c * 4 + (i & 3);
        for (const nib of [u[base] & 15, u[base] >> 4]) {
          if (n >= spb) break; let d = IT[idx], df = d >> 3; if (nib & 1) df += d >> 2; if (nib & 2) df += d >> 1; if (nib & 4) df += d; if (nib & 8) pred -= df; else pred += df;
          pred = Math.max(-32768, Math.min(32767, pred)); idx = Math.max(0, Math.min(88, idx + IX[nib & 7])); out[(b * spb + n) * ch + c] = pred; n++;
        }
      }
    }
    const w = new ArrayBuffer(44 + out.length * 2), v = new DataView(w), tag = (o, t) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    tag(0, 'RIFF'); v.setUint32(4, 36 + out.length * 2, true); tag(8, 'WAVE'); tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, rate, true); v.setUint32(28, rate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, out.length * 2, true);
    new Int16Array(w, 44).set(out); return w;
  }
  // MS ADPCM (WAVE format 2, used by police.wav and Cars/op.snd) -> 16-bit PCM WAV
  function msToWav(buf) {
    const u = new Uint8Array(buf), dv = new DataView(u.buffer, u.byteOffset, u.byteLength); let p = 12, fmt = null, data = null;
    while (p + 8 <= u.length) { const id = String.fromCharCode(u[p], u[p + 1], u[p + 2], u[p + 3]), n = dv.getUint32(p + 4, true); if (id === 'fmt ') fmt = p + 8; else if (id === 'data') { data = [p + 8, Math.min(n, u.length - p - 8)]; break; } p += 8 + n + (n & 1); }
    if (!fmt || !data) throw new Error('bad wav');
    const ch = dv.getUint16(fmt + 2, true), rate = dv.getUint32(fmt + 4, true), ba = dv.getUint16(fmt + 12, true), spb = dv.getUint16(fmt + 18, true), nc = dv.getUint16(fmt + 20, true);
    const c1 = [], c2 = []; for (let i = 0; i < nc; i++) { c1.push(dv.getInt16(fmt + 22 + i * 4, true)); c2.push(dv.getInt16(fmt + 24 + i * 4, true)); }
    const AD = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
    const blocks = Math.floor(data[1] / ba), out = new Int16Array(blocks * spb * ch), clamp = v => Math.max(-32768, Math.min(32767, v));
    for (let b = 0; b < blocks; b++) {
      let o = data[0] + b * ba; const pr = [], dl = [], s1 = [], s2 = [];
      for (let c = 0; c < ch; c++) pr.push(u[o++]); for (let c = 0; c < ch; c++) { dl.push(dv.getInt16(o, true)); o += 2; } for (let c = 0; c < ch; c++) { s1.push(dv.getInt16(o, true)); o += 2; } for (let c = 0; c < ch; c++) { s2.push(dv.getInt16(o, true)); o += 2; }
      let n = 0; for (let c = 0; c < ch; c++) { out[(b * spb) * ch + c] = s2[c]; out[(b * spb + 1) * ch + c] = s1[c]; } n = 2;
      for (let i = 0; n < spb; i++) {
        const by = u[o + (i >> 1)]; const nib = (i & 1) ? by & 15 : by >> 4, c = ch === 1 ? 0 : i & 1, fr = n;
        const sn = nib > 7 ? nib - 16 : nib, k = Math.min(pr[c], nc - 1);
        let pred = (s1[c] * c1[k] + s2[c] * c2[k]) >> 8; pred = clamp(pred + sn * dl[c]); s2[c] = s1[c]; s1[c] = pred; dl[c] = Math.max(16, (AD[nib] * dl[c]) >> 8);
        out[(b * spb + fr) * ch + c] = pred; if (ch === 1 || c === 1) n++;
      }
    }
    const w = new ArrayBuffer(44 + out.length * 2), v = new DataView(w), tag = (o2, t) => { for (let i = 0; i < 4; i++) v.setUint8(o2 + i, t.charCodeAt(i)); };
    tag(0, 'RIFF'); v.setUint32(4, 36 + out.length * 2, true); tag(8, 'WAVE'); tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, rate, true); v.setUint32(28, rate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, out.length * 2, true);
    new Int16Array(w, 44).set(out); return w;
  }
  // tyre squeal (skid.wav): looped, volume follows the tyre slip / handbrake lock while the car moves
  function skidSound(level) {
    if (!AU.ctx || !AU.skidBuf) return;
    if (!AU.skidG) { const src = AU.ctx.createBufferSource(); src.buffer = AU.skidBuf; src.loop = true; AU.skidG = AU.ctx.createGain(); AU.skidG.gain.value = 0; src.connect(AU.skidG).connect(AU.sfx); src.start(); }
    AU.skidG.gain.value += (Math.min(0.6, level) - AU.skidG.gain.value) * 0.3;
  }
  // DirectSound3D distance gain (rolloff 1): 1 inside min, min/d up to max; beyond max the original does not play the sound at all (FUN_00408180/00408370)
  const d3 = (d, min, max) => d > max ? 0 : Math.min(1, min / Math.max(d, 1e-3));
  // crash thud, as the car update FUN_00413480: a contact impulse |J| > 200 recorded while the 0.2 s cooldown is 0 (b.hitJ, physics-orig noteHit) plays
  // a random bum0..4 (the first free one if busy) at the contact point (3D 7..50 m) with DirectSound volume (1 - (min(J,5000)-200)/4800) * -1000 (-10..0 dB).
  // Every car: player, rivals, traffic and remote players.
  function crashSounds(bodies, dt) {
    const ctx = AU.ctx, L = G.camera.position, now = ctx ? ctx.currentTime : 0, end = AU.bumEnd || (AU.bumEnd = []);
    for (const b of bodies) {
      if (b.bumCd > 0) { b.bumCd = Math.max(0, b.bumCd - dt); b.hitJ = 0; continue; }
      const J = b.hitJ || 0; if (!J) continue; b.hitJ = 0; b.bumCd = 0.2;
      if (!ctx || !AU.bum || !AU.bum.length) continue;
      const P = b.hitP || b.pos, g3 = d3(Math.hypot(P.x - L.x, (P.y || 0) - L.y, P.z - L.z), 7, 50); if (!g3) continue;
      let i = Math.floor(Math.random() * AU.bum.length); if ((end[i] || 0) > now) { i = AU.bum.findIndex((x, k) => (end[k] || 0) <= now); if (i < 0) continue; }
      const s = ctx.createBufferSource(), g = ctx.createGain(); s.buffer = AU.bum[i]; end[i] = now + s.buffer.duration;
      g.gain.value = Math.pow(10, -(1 - (Math.min(J, 5000) - 200) / 4800) / 2) * g3; s.connect(g).connect(AU.sfx); s.start();
      if (G.carFx) G.carFx.spawnSparks(P); else if (G.sparks) G.sparks.add(P);   // sparks only when the sound plays (FUN_0041a4f0 after FUN_00408180); carfx.js = the original streaks (camera-speed stretch), YDSim.Sparks = fallback points
    }
  }
  function horn(on) {   // the player's horn (horn0..2.wav, picked at random like every car's), looped only while H is held; 0 dB, the car is inside the 15 m min distance
    if (!AU.ctx) return;
    if (on && !AU.hornO && AU.horn) { const s = AU.ctx.createBufferSource(); s.buffer = AU.horn; s.loop = true; s.connect(AU.sfx); s.start(); AU.hornO = s; }
    if (!on && AU.hornO) { try { AU.hornO.stop(); } catch (e) { } AU.hornO = null; }
  }
  // other cars' horns. Traffic (FUN_0041b880) and rivals (FUN_0041c300) look for the car ahead with FUN_0041ae80: along the heading up to 20 m (traffic) /
  // 10 + 0.75*speed (rivals), lateral offset < 1.1*(rA+rB), and closer than 10 m or closing > 0.1 m/s with < 5 s to impact; they press the horn while
  // |vA - vB| > 12 m/s (traffic) / 15 m/s (rivals). Own random horn0..2, looped, 3D 15..60 m, 3 buffers per sample (player's horn included).
  const hornRad = b => b.bnd ? b.bnd.max[0] : b.box ? b.box.hw : 1;   // FUN_0041ae80 radius = type+0x710 (the 'bound' box object) +0x28 = its max.x (then * 1.1)
  function otherHorns(stop) {
    const ctx = AU.ctx; if (!ctx || !AU.horns || !AU.horns.length || !G) return;
    const L = G.camera.position, on = new Map(), H = AU.hornCars || (AU.hornCars = new Map());
    if (!stop) {
      const all = [G.phys, ...G.ais.map(a => a.phys), ...(G.traffic ? G.traffic.cars : []), ...(G.remotes || []).map(r => r.phys)];
      const list = G.ais.map((a, i) => [a.phys, 15, 10 + 0.75 * Math.abs(a.phys.speed || 0), AU.opV && AU.opV[i % AU.opV.length], 15]); if (G.traffic) for (const c of G.traffic.cars) list.push([c, 12, 20, AU.trafV && AU.trafV[c.trafV === undefined ? (c.trafV = Math.floor(Math.random() * 3)) : c.trafV], 20]);   // rival i speaks as OPPONENT i (its name); traffic: traf group rand()%3 at spawn (FUN_00410290)
      for (const [b, thr, look, vg, vmin] of list) {
        const dl = Math.hypot(b.pos.x - L.x, (b.pos.y || 0) - L.y, b.pos.z - L.z), g3 = d3(dl, 15, 60); if (dl > 80 || !b.vel) continue;   // 80 m = the voices' max distance
        const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw); let best = look, hit = null;
        for (const o of all) {
          if (o === b || !o.vel) continue; const dx = o.pos.x - b.pos.x, dz = o.pos.z - b.pos.z, t = dx * fx + dz * fz; if (t <= 0 || t >= best) continue;
          if (Math.hypot(dx - fx * t, dz - fz * t) >= 1.1 * (hornRad(b) + hornRad(o))) continue;
          if (t >= 10) { const cl = (b.vel.x - o.vel.x) * fx + (b.vel.z - o.vel.z) * fz; if (!(cl > 0.1 && t / cl < 5)) continue; }
          best = t; hit = o;
        }
        const rel = hit ? Math.hypot(b.vel.x - hit.vel.x, b.vel.z - hit.vel.z) : 0;
        if (rel > thr && g3) on.set(b, g3);
        if (rel > 15 && vg && Math.floor(Math.random() * 50) === 0) voice(b, vg, vmin, 80);   // 1 in 50 per update while |vA - vB| > 15 (0x484630), see voices
      }
      const now = performance.now();
      for (const r of G.remotes || []) if (r.inp && r.inp.horn && now - r.t < 1000) { const b = r.phys, g3 = d3(Math.hypot(b.pos.x - L.x, (b.pos.y || 0) - L.y, b.pos.z - L.z), 15, 60); if (g3) on.set(b, g3); }   // other players: H held = flag 32 of their state packet (bit of +0x17c), same horn voice rules
    }
    for (const [b, h] of H) if (!on.has(b)) { try { h.s.stop(); } catch (e) { } H.delete(b); }
    for (const [b] of on) {
      let h = H.get(b);
      if (!h) {
        if (b.hornIdx === undefined) b.hornIdx = Math.floor(Math.random() * AU.horns.length);
        let n = AU.hornO && AU.horn === AU.horns[b.hornIdx] ? 1 : 0; for (const x of H.values()) if (x.i === b.hornIdx) n++; if (n >= 3) continue;
        const s = ctx.createBufferSource(), p = pan3(15, 60); s.buffer = AU.horns[b.hornIdx]; s.loop = true; s.connect(p).connect(AU.sfx); s.start(); H.set(b, h = { s, p, i: b.hornIdx });
      }
      at3(h.p, b.pos); h.s.playbackRate.value = dop3(b.pos, b.vel);   // panner distance gain = the old d3(15, 60)
    }
  }

  // ---- 3D sound. The original makes every car sound a DirectSound3D buffer: listener = camera eye with the followed car's velocity car+0x3c
  // (FUN_00417630 -> FUN_00408670 -> SetAllParameters; default listener: distance factor 1, rolloff 1, doppler factor 1), each source gets the car
  // position and velocity (FUN_0040e0e0 -> SetPosition / SetVelocity). Gain: rolloff 1 = min/d past min (PannerNode 'inverse', ref = min); past max
  // the original stops the sound (FUN_00408370), so the panner's maxDistance never matters. Web Audio dropped PannerNode doppler, so it goes into
  // playbackRate: f' = f (c - vL.u) / (c - vS.u), u = unit(listener - source), c = 343 m/s.
  const LV = new THREE.Vector3(), LF = new THREE.Vector3(), LU = new THREE.Vector3();
  function listener3() {
    const l = AU.ctx.listener, cam = G.camera, P = cam.position, e = G.camEnt || G.player, v = e && e.phys && e.phys.vel; if (v) LV.copy(v); else LV.set(0, 0, 0);
    LF.set(0, 0, -1).applyQuaternion(cam.quaternion); LU.set(0, 1, 0).applyQuaternion(cam.quaternion);
    if (l.positionX) { l.positionX.value = P.x; l.positionY.value = P.y; l.positionZ.value = P.z; l.forwardX.value = LF.x; l.forwardY.value = LF.y; l.forwardZ.value = LF.z; l.upX.value = LU.x; l.upY.value = LU.y; l.upZ.value = LU.z; }
    else { l.setPosition(P.x, P.y, P.z); l.setOrientation(LF.x, LF.y, LF.z, LU.x, LU.y, LU.z); }
  }
  function pan3(min, max) { const p = AU.ctx.createPanner(); p.panningModel = 'equalpower'; p.distanceModel = 'inverse'; p.refDistance = min; p.maxDistance = max; p.rolloffFactor = 1; return p; }
  function at3(p, P) { const y = P.y || 0; if (p.positionX) { p.positionX.value = P.x; p.positionY.value = y; p.positionZ.value = P.z; } else p.setPosition(P.x, y, P.z); }
  function dop3(P, V) { const L = G.camera.position, dx = L.x - P.x, dy = L.y - (P.y || 0), dz = L.z - P.z, d = Math.hypot(dx, dy, dz) || 1, vs = V ? (V.x * dx + (V.y || 0) * dy + V.z * dz) / d : 0, vl = (LV.x * dx + LV.y * dy + LV.z * dz) / d; return Math.max(0.5, Math.min(2, (343 - vl) / (343 - Math.min(300, vs)))); }
  const dist3 = P => { const L = G.camera.position; return Math.hypot(P.x - L.x, (P.y || 0) - L.y, P.z - L.z); };
  function wavRate(buf) { const u = new Uint8Array(buf), dv = new DataView(u.buffer, u.byteOffset, u.byteLength); for (let p = 12; p + 16 <= u.length;) { const n = dv.getUint32(p + 4, true); if (String.fromCharCode(u[p], u[p + 1], u[p + 2], u[p + 3]) === 'fmt ') return dv.getUint32(p + 12, true); p += 8 + n + (n & 1); } return 22050; }
  // ---- engine loops, every car (car update FUN_00413480 @0x413cc5..0x413d67). Each model's avto.snd 'engine.wav' is loaded with 5 buffers, looped,
  // 3D 10..60 m (FUN_0040f6b0: flags 0xa0000000, count 5, min 10 = 0x41200000, max 60 = 0x42700000); f0 = its own frequency (GetFrequency -> type+0x714).
  // Per car and frame: engine w (car+0x1c0) <= idle (type+0x38c) and no gas flag (0x80000000 in car+0x17c, FUN_00410780) -> the sound is stopped, so a
  // car standing in gear off the gas is silent; else SetFrequency(min(f0, f0 * max(w, idle) / wmax + 1000)) (wmax = type+0x390, 1000 = 0x48482c) and
  // play / move it at the car. There is no SetVolume on it (0 dB): only the 3D distance sets the level. FUN_00408180(-1): a random one of the model's
  // 5 buffers, the first free one if that is busy, none if all 5 are busy (at most 5 cars of one model are heard). (GAPS #47 pointed at par 0xb4: that is
  // the first float of the front wheel block, copied to type+0x2bc -> +0x300, not a sound value.)
  const engBufs = new Map(), parFolder = new WeakMap(), carFolders = new Set();
  if (window.YDCar && !YDCar.loadCar.sndTag) { const lc = YDCar.loadCar; YDCar.loadCar = async (...a) => { const c = await lc(...a); if (c && c.folder) { carFolders.add(c.folder); if (c.parOrig) parFolder.set(c.parOrig, c.folder); } return c; }; YDCar.loadCar.sndTag = true; }   // traffic cars only keep their par: par -> model folder
  function engBuf(folder) {
    let e = engBufs.get(folder); if (e) return e; engBufs.set(folder, e = { v: null, p: null });
    e.p = (async () => { const snd = YD.readBFX(await vfs.bytes('Cars/' + folder + '/avto.snd')), w = snd.get('engine.wav') || [...snd.values()][0]; e.v = { buf: await AU.ctx.decodeAudioData(toPcm(w)), f0: wavRate(w), busy: [null, null, null, null, null] }; })().catch(er => console.warn('engine audio ' + folder, er));   // 8 of 17 cars ship IMA ADPCM engine.wav
    return e;
  }
  const RPM = 9.549296586;
  function engRpm(b, par) {   // car+0x1c0 as rpm; kinematic stand-ins (remote players, network traffic): from the road speed in the lowest gear under the shift point
    if (b._eOmega !== undefined) return b._eOmega * RPM; if (!b.kin && typeof b.rpm === 'number') return b.rpm;
    const k = Math.abs(b.speed || 0) / ((par.rear && par.rear.radius) || 0.3) * (par.finalDrive || 4) * RPM; let rpm = 0; for (const r of (par.gears || [3])) { rpm = k * r; if (rpm <= (par.shiftRpm || par.maxRpm)) break; } return Math.min(rpm, par.maxRpm);
  }
  function engines(stop) {
    const ctx = AU.ctx; if (!ctx || !G) return; const E = AU.engCars || (AU.engCars = new Map()), want = new Set();
    if (!stop) {
      const add = (b, folder, par) => {
        if (!b || !b.pos || !folder || !par || !par.maxRpm) return; const e = engBuf(folder).v; if (!e) return;
        const rpm = engRpm(b, par), gas = b._gas !== undefined ? b._gas : (b.throttle || 0) > 0; if (!(rpm > par.idleRpm) && !gas) return;
        if (dist3(b.pos) > 60) return;
        let h = E.get(b); if (h && h.e !== e) { stopEng(h); E.delete(b); h = null; }   // model changed (CHOICE CAR)
        if (!h) {
          let i = Math.floor(Math.random() * 5); if (e.busy[i]) i = e.busy.indexOf(null); if (i < 0) return;
          const s = ctx.createBufferSource(), p = pan3(10, 60); s.buffer = e.buf; s.loop = true; s.connect(p).connect(AU.sfx); s.start(0, Math.random() * e.buf.duration); e.busy[i] = b; E.set(b, h = { s, p, e, i });
        }
        want.add(b); at3(h.p, b.pos);
        h.s.playbackRate.value = Math.min(1, Math.max(rpm, par.idleRpm) / par.maxRpm + 1000 / e.f0) * dop3(b.pos, b.vel);
      };
      const pf = c => c && (c.parOrig || c.par);
      add(G.phys, G.car && G.car.folder, G.phys.par || pf(G.car)); for (const a of G.ais) add(a.phys, a.car && a.car.folder, a.phys.par || pf(a.car)); for (const r of (G.remotes || [])) add(r.phys, r.car && r.car.folder, r.phys.par || pf(r.car));
      if (G.traffic) for (const c of G.traffic.cars) { const par = (c.phys && c.phys.par) || (G.traffic.tpl && G.traffic.tpl[c.ti] && G.traffic.tpl[c.ti].par); add(c.phys || c, par && parFolder.get(par), par); }
    }
    for (const [b, h] of E) if (!want.has(b)) { stopEng(h); E.delete(b); }
  }
  function stopEng(h) { try { h.s.stop(); } catch (e) { } h.s.disconnect(); if (h.e.busy[h.i]) h.e.busy[h.i] = null; }
  // ---- driver voices. Rivals (FUN_0041c300) and traffic (FUN_0041b880) with a car ahead (otherHorns) and |vA - vB| > 15 m/s (0x484630) shout
  // with a 1-in-50 chance per update (rand() % 50 == 0) on the car's voice slot car+0x2bc (FUN_00410840), only while that slot is silent. Rival: its
  // opponent's speech from Cars/op.snd (opponents.ini Speech/NumSpeech -> name0..N-1.wav; a missing one falls back to name0, FUN_00408790), 3D 15..80 m
  // (bank setup FUN_004127d0: flags 0x60000000 = 3D + variants, not looped, min 15, max 80). Traffic: traf0_/traf1_/traf2_ (picked at spawn), 3 variants each
  // (trafK_0..2), 3D 20..80 m (flags 0x60000000). A random variant, the first free one if busy, none if all are busy (one buffer per variant,
  // FUN_00408180); the slot follows the car and stops past max (FUN_00408370). The siren of the Gogh & Milica police uses the same slot in the original.
  async function loadVoices() {
    const dec = async (bfx, name, n) => { const g = { bufs: [], end: [] }; for (let k = 0; k < n; k++) { const b = bfx.get(name.replace(/\.wav$/i, k + '.wav')) || bfx.get(name.replace(/\.wav$/i, '0.wav')); if (b) try { g.bufs.push(await AU.ctx.decodeAudioData(toPcm(b))); } catch (e) { console.warn('voice ' + name + k, e); } } return g; };
    const cs = YD.readBFX(await vfs.bytes('Cars/carstd.snd')), tv = []; for (let i = 0; i < 3; i++) tv.push(await dec(cs, 'traf' + i + '_.wav', 3)); AU.trafV = tv;
    const op = YD.readBFX(await vfs.bytes('Cars/op.snd')), oi = YDUI.parseIni(await vfs.bytes('Cars/opponents.ini')), ov = [];
    for (let i = 0; i < 7; i++) ov.push(await dec(op, oi.get('OPPONENT' + i, 'Speech', 'tati.wav'), +oi.get('OPPONENT' + i, 'NumSpeech', '1') || 1)); AU.opV = ov;
  }
  function voice(b, g, min, max) {
    const ctx = AU.ctx, now = ctx ? ctx.currentTime : 0; if (!ctx || !g.bufs.length || (b.voiceEnd || 0) > now || dist3(b.pos) > max) return;
    let i = Math.floor(Math.random() * g.bufs.length); if ((g.end[i] || 0) > now) { i = g.bufs.findIndex((x, k) => !((g.end[k] || 0) > now)); if (i < 0) return; }
    const s = ctx.createBufferSource(), p = pan3(min, max); s.buffer = g.bufs[i]; s.connect(p).connect(AU.sfx); at3(p, b.pos); s.start();
    b.voiceEnd = g.end[i] = now + s.buffer.duration; (AU.voices || (AU.voices = new Set())).add({ b, s, p, g, i, max, end: b.voiceEnd });
  }
  function voices() {
    if (!AU.voices) return; const now = AU.ctx.currentTime;
    for (const v of AU.voices) {
      if (now >= v.end) { AU.voices.delete(v); continue; }
      if (dist3(v.b.pos) > v.max) { try { v.s.stop(); } catch (e) { } if (v.g.end[v.i] === v.end) v.g.end[v.i] = 0; v.b.voiceEnd = 0; AU.voices.delete(v); continue; }
      at3(v.p, v.b.pos); v.s.playbackRate.value = dop3(v.b.pos, v.b.vel);
    }
  }

  // ---------------- game ----------------

  // ---- licence plates: plate template (carmat hamar<type>.tga) + text in the big bitmap font, like the UI's drawPlate ----
  function makePlateTexture(UI, type, text) {
    if (!UI || !UI.carmat) return null;
    const m = UI.carmat.get('stdhamar'); const img = m && m.frames[type % Math.max(1, m.frames.length)]; if (!img) return null;
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 768;
    const g = cv.getContext('2d'), R = new YDUI._core.Renderer(g);
    const w = 1.9, h = w * 512 * img.height / (img.width * 384), x = -w / 2, y = -h / 2;       // NDC rect with the template's pixel aspect
    R.sprite(img, x, y, w, h, 0xffffffff);
    if (text) R.text(UI.fontBig, 0, 0, h * 0.6, h * 0.6, 0xff000000, text, 0xb);
    const px = Math.round((x + 1) * 512), py = Math.round((y + 1) * 384), pw = Math.round(w * 512), ph = Math.round(h * 384);
    const out = document.createElement('canvas'); out.width = pw; out.height = ph; out.getContext('2d').drawImage(cv, px, py, pw, ph, 0, 0, pw, ph);
    const t = new THREE.CanvasTexture(out); t.flipY = false; t.anisotropy = 4; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t;
  }
  function applyPlate(car, UI, type, text) {
    const tex = makePlateTexture(UI, type, text); if (!tex) return;
    (car.descs || []).forEach((d, i) => { if (/^hamar$/i.test(d.name) || /^hamar\./i.test(d.tex || '')) { const m = car.materials[i]; if (m) { m.map = tex; m.color.set(0xffffff); m.needsUpdate = true; } } });
  }
  const randPlate = () => { const L = 'ABCDEFGHKLMNPRSTUVXYZ'; const d = n => Array.from({ length: n }, () => (Math.random() * 10) | 0).join(''); return d(2) + ' ' + L[(Math.random() * L.length) | 0] + L[(Math.random() * L.length) | 0] + ' ' + d(3); };

  let G = null; const Q0 = new URLSearchParams(location.search), G0 = {};
  // WebGL context loss (phones drop it when the tab goes to the background): the game stands still (as the original while its D3D device is lost) behind the
  // original loading screen; on restore three rebuilds its GL state and re-uploads what it still holds, TexSet.refillAll decodes the city textures whose CPU
  // pixels were dropped after the upload again (bar = archives done), then the game goes on where it was
  const GL = { lost: false, p: 0, cv: null };
  function glLost(on) {
    const eb = $('errbox'); if (eb) { eb.textContent = eb.textContent.replace(/WebGL context lost[^\n]*\n/g, ''); if (!eb.textContent) eb.remove(); }   // index.html's generic notice: handled here
    const cv = $('uicanvas'), UI = state.ui;
    if (on) {
      if (GL.lost) return; GL.lost = true; GL.p = 0; GL.cv = [cv.style.display, cv.style.background]; cv.style.display = 'block'; cv.style.background = '#000';
      if (!UI) { $('lmsg').textContent = 'Restoring graphics…'; $('loading').style.display = 'flex'; }
      if (G) { engines(true); horn(false); otherHorns(true); skidSound(0); if (G.amb) G.amb.stop(); } if (AU.music) AU.music.pause(); return;
    }
    YD.TexSet.refillAll((i, n) => { GL.p = i / n; }).catch(e => console.warn('texture refill', e)).then(() => {
      const ov = !!(UI && UI.overlay); GL.lost = false; cv.style.display = ov ? 'block' : G ? 'none' : GL.cv[0]; cv.style.background = ov ? 'transparent' : GL.cv[1]; if (!UI && G) $('loading').style.display = 'none';
      if (UI && !UI.overlay && UI.ctx) UI.ctx.clearRect(0, 0, UI.ctx.canvas.width, UI.ctx.canvas.height);
      if (AU.music && !AU.mutedByUser && !(G && G.paused)) AU.music.play().catch(() => { }); if (G) G.last = performance.now();
    });
  }
  async function start() {
    const UI = state.ui; if (!UI) $('loading').style.display = 'flex';
    // loading bar (FUN_004286d0 draws progress*10, so 0.2 = full): weighted steps (the city file and its textures are the big ones), creeping inside a step
    const wOf = t => /^Reading city|^Preparing tex/.test(t) ? 3 : /^Placing/.test(t) ? 2 : 1, total = () => 12 + (state.net ? 1 : 0) + (state.mode === 'gonka' ? 1 + Math.min(7, state.opts.opponents || 0) : 0) + (state.opts.traffic ? 1 : 0);
    let done = 0, stepEnd = 0; clearInterval(G0.creep); if (UI) G0.creep = setInterval(() => { if (UI.mode !== 'loading' || G) return clearInterval(G0.creep); UI.progress += (0.2 * stepEnd - UI.progress) * 0.03; }, 100);
    const msg = t => { if (UI) { UI.setMode('loading', Math.max(UI.progress || 0, 0.2 * Math.min(0.98, done / total()))); done += wOf(t); stepEnd = Math.min(0.98, done / total()); } else $('lmsg').textContent = t; return new Promise(r => setTimeout(r, 0)); };
    let net = null, welcome = null;
    if (state.net) {   // multiplayer: join/create the session first (room settings decide track, laps and game type)
      const d = state.net.d, create = state.net.action === 'create';
      net = new YDNet({ team: new URLSearchParams(location.search).get('team') || undefined, name: d.name || 'Player', session: create ? undefined : d.session, password: d.password || '', car: state.selected, col: state.color, plate: state.plate || (UI && UI.settings ? { type: UI.settings.plateType, text: UI.settings.plateText } : null), create: create ? { session: d.session, maxPlayers: +d.maxPlayers, gameType: d.gameType, laps: d.laps, password: d.password } : undefined }, {});
      await msg('Connecting…'); welcome = await net.ready;
      state.opts.track = welcome.room.track; state.opts.laps = welcome.room.laps; state.mode = welcome.room.gameType === 1 ? 'gonka' : 'walker'; state.gm = welcome.room.gameType === 2 ? { team: welcome.team } : null;
    }
    await msg('Starting renderer…');
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(innerWidth, innerHeight);
    $('stage').innerHTML = ''; $('stage').appendChild(renderer.domElement);
    renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); glLost(true); }, false); renderer.domElement.addEventListener('webglcontextrestored', () => glLost(false), false);
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x9ec3e6);
    const camera = new THREE.PerspectiveCamera(56.25, innerWidth / innerHeight, 0.9, 1000);
    addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });

    await msg('Loading city…');
    const world = await (window.YDWorld ? YDWorld.load(vfs, scene, msg, state) : fallbackWorld(scene));
    const R = window.YDRender; if (R && Q0.has('refl')) R.C.REFLECT_MAX = +Q0.get('refl');   // experiment: reflection strength
    let rig = null, skyObj = null, sunObj = null, envCube = null, dynEnv = null;
    if (R) {
      rig = R.setupScene(scene, renderer, camera, { aspect: innerWidth / innerHeight });
      try { skyObj = await R.makeSkybox(vfs, scene, camera); } catch (e) { console.warn('sky', e); }
      try { sunObj = await R.makeSun(vfs, scene, rig); } catch (e) { console.warn('sun', e); }
      try { envCube = await R.buildEnvCube(vfs); } catch (e) { console.warn('envcube', e); }
    } else { scene.add(new THREE.HemisphereLight(0xdfeeff, 0x5a5648, 0.95), Object.assign(new THREE.DirectionalLight(0xfff2d8, 0.85), { position: new THREE.Vector3(-300, 400, 200) })); }
    await msg('Loading ' + state.carNames[state.selected] + '…');
    const car = await YDCar.loadCar(vfs, state.selected, state.color, state.carcol);
    scene.add(car.obj);
    if (UI) applyPlate(car, UI, state.plate ? state.plate.type : 0, state.plate ? state.plate.text : '');
    const shadowOn = !Q0.has('noshadow');
    if (R && envCube && !Q0.has('noenv')) { dynEnv = new R.DynamicEnv(128); R.applyEnvironment(car.obj, dynEnv.texture, R.C.REFLECT_MAX); }
    const phys = YDCar.makePhysics(car, world);
    if (phys.autoShift !== undefined) phys.autoShift = state.auto;
    const player = { phys, car, isPlayer: true, name: (state.net && state.net.d.name) || (UI && UI.settings.myName) || 'Player' };   // MyName (config.ini [MYCAR]) / the network player name
    if (shadowOn) player.shadow = YDSim.makeShadow(car, scene);
    phys.pos.copy(world.spawn.pos); phys.yaw = world.spawn.yaw; phys.gy = world.spawn.gy;
    const opts = state.opts, modeRace = state.mode === 'gonka' && world.cit;
    let race = null, route = null, trc = null; const ais = [];
    // start slot s: race grid of the track, else the city's 8 network spawn points (CIT spawns; slot 0 in front)
    const spawnSlot = s => { const e = G ? G.player : player; if (modeRace) putOn(e, trc.grid[s % 8]); else if (world.grid8 && world.grid8.length) putOn(e, world.grid8[s % world.grid8.length]); else { e.phys.pos.copy(world.spawn.pos); e.phys.pos.x += s * 4; } e.phys.vel.set(0, 0, 0); e.phys.speed = 0; e.phys.yawRate = 0; };
    let oppNames = []; try { const oi = YDUI.parseIni(await vfs.bytes('Cars/opponents.ini')); for (let i = 0; i < 7; i++) oppNames.push(oi.get('OPPONENT' + i, 'Name', '')); } catch (e) { }   // rival names (Cars/opponents.ini)
    const putOn = (e, slot) => { e.phys.pos.copy(slot.pos); e.phys.yaw = slot.yaw; e.phys.gy = slot.pos.y - 0.3; };
    if (modeRace) {
      await msg('Loading track…');
      trc = YDSim.parseTrc(await vfs.bytes('Tracks/track' + opts.track + '.trc'));
      route = YDSim.buildRoute(world, trc.segs);
      const n = Math.min(7, opts.opponents);
      putOn(player, trc.grid[net ? net.slot % 8 : n]);   // network: per-room slot from the server
      const folders = CAR_FOLDERS.filter(f => state.carNames[f]);
      for (let i = 0; i < n; i++) {
        await msg('Loading opponent ' + (i + 1) + '…');
        const f = opts.sameCar ? state.selected : folders[(Math.random() * folders.length) | 0];
        const c = await YDCar.loadCar(vfs, f, (Math.random() * state.carcol.length) | 0, state.carcol);
        scene.add(c.obj); if (UI) applyPlate(c, UI, (Math.random() * 10) | 0, randPlate()); if (R && envCube) R.applyEnvironment(c.obj, envCube, R.C.REFLECT_MAX * 0.6);
        const e = { phys: YDCar.makePhysics(c, world), car: c, name: oppNames[i] || ('Racer ' + (i + 1)), ai: new YDSim.AIDriver(route, [[0.45, 0.6], [0.65, 0.8], [0.85, 1.0]][Math.min(2, opts.hardness || 0)].reduce((lo, hi) => lo + Math.random() * (hi - lo))) };
        putOn(e, trc.grid[i]); ais.push(e);   // rivals collide with poles / trees like the player (the AI backs up or respawns when stuck)
      }
      race = new YDSim.Race(world, route, opts.laps, [player, ...ais], player);
    }
    const remotes = [];
    if (net) {
      if (!modeRace) spawnSlot(net.slot);
      const addRemote = async peer => {
        if (net.remote.has(peer.id)) return; const c = await YDCar.loadCar(vfs, state.carNames[peer.car] ? peer.car : 'bmw', peer.col, state.carcol); if (net.remote.has(peer.id)) return;   // a reconnect can announce a player twice
        scene.add(c.obj); if (UI) applyPlate(c, UI, peer.plate ? peer.plate.type : (Math.random() * 10) | 0, peer.plate && peer.plate.text ? peer.plate.text : randPlate()); if (R && envCube) R.applyEnvironment(c.obj, envCube, R.C.REFLECT_MAX * 0.6);   // every car carries a plate
        const e = { team: peer.team, id: 'n' + peer.id, name: peer.name, car: c, phys: YDCar.makePhysics(c, world), remote: true, live: false };   // a full physics body like the AI (spec-collision-camera.md B): simulated with the sender's inputs (e.inp), corrected per packet (net.js); live after its first packet
        if (shadowOn) e.shadow = YDSim.makeShadow(c, scene);
        net.remote.set(peer.id, e); remotes.push(e);
        if (race) { Object.assign(e, { lap: -9, idx: -1, progress: 0, done: false, time: null, ext: true }); race.entries.push(e); }   // ext: its finish comes from its owner ('fin'), not from this copy
      };
      if (state.gm) { player.team = state.gm.team; }
      net.hooks.onJoin = addRemote;
      net.hooks.onSiren = m => setSiren('n' + m.id, m.on);
      net.hooks.onGo = () => { if (G) G.spawnSlot(net.slot); if (G && G.lobby) leaveLobby(); };   // everybody to the grid slot the server gave out with the start message
      net.hooks.onRestart = () => { if (G) netRestart(); };
      net.hooks.onPleaseRestart = m => netMsg(m.name + ' ' + UI.S('STRINGS', 'PleaseRestart', 'please restart'), 255);   // host: message 10 -> FUN_004294c0 "%s %s", FUN_00427350(.., 0, 0, 255)
      net.hooks.onClose = () => { if (G) netMsg(UI.S('STRINGS', 'Server', 'Server is down!'), 0, 0xffffff); };   // connection lost: net.js reconnects with the same id for ~55 s
      net.hooks.onGone = () => { if (G) netMsg(UI.S('STRINGS', 'Server', 'Server is down!'), 0, 0xffffff); };
      net.hooks.onBust = id => { if (G && G.gm && !G.gm.over) gmBust(netEnt(id)); };   // Gogh & Milica: the host's decision
      net.hooks.onOver = m => {   // game over from the host (message 0x12): Gogh & Milica winner / race finish order
        if (!G) return;
        if (G.gm && !G.gm.over && (m.w === 0 || m.w === 1)) G.gm.over = { cops: m.w === 1, t: 0 };
        if (G.race && Array.isArray(m.order) && !G.resShown) { G.netOrder = m.order; G.resShown = true; showResults(); }
      };
      net.hooks.onFin = m => { const e = net.remote.get(m.id); if (G && G.race && e && !e.done && G.race.state !== 'countdown') { e.done = true; e.time = m.time; } };   // the owner's own finish (race time on the shared clock)
      net.hooks.onHost = () => { if (G && G.lobby && G.lobbyChosen) state.ui.lobbyCanGo = true; };
      net.hooks.onCar = async m => {   // another player pressed CHOICE CAR: swap the model of its car
        const e = net.remote.get(m.id); if (!e) return;
        const c = await YDCar.loadCar(vfs, state.carNames[m.car] ? m.car : 'bmw', m.col, state.carcol);
        scene.remove(e.car.obj); if (e.shadow) scene.remove(e.shadow.group);
        scene.add(c.obj); if (UI && m.plate) applyPlate(c, UI, m.plate.type, m.plate.text || randPlate()); if (R && envCube) R.applyEnvironment(c.obj, envCube, R.C.REFLECT_MAX * 0.6);
        e.car = c; e.phys = YDCar.makePhysics(c, world); e.inp = null; e.live = false; if (shadowOn) e.shadow = YDSim.makeShadow(c, scene);   // new par (mass, wheels, box): the next packet snaps the new body
      };
      net.hooks.onChat = m => chatLine(armToU(m.name) + ': ' + m.text);
      setupChat(net);
      net.hooks.onLeave = id => { const e = net.remote.get(id); if (!e) return; netMsg(e.name + ' ' + UI.S('STRINGS', 'LeaveGame', ' leavs game!'), 0); scene.remove(e.car.obj); if (e.shadow) scene.remove(e.shadow.group); net.remote.delete(id); remotes.splice(remotes.indexOf(e), 1); if (race) race.entries.splice(race.entries.indexOf(e), 1); };
      net.hooks.onRejoin = async m => {   // reconnected with the same id (net.js): drop the players that left meanwhile, add the new ones, take the host role as it is now
        const ids = new Set(m.peers.map(p => p.id)); for (const id of [...net.remote.keys()]) if (!ids.has(id)) net.hooks.onLeave(id);
        for (const pe of m.peers) await addRemote(pe);
        if (G && G.traffic) G.traffic.setRemote(!net.isHost); if (net.isHost && net.hooks.onHost) net.hooks.onHost();
      };
      for (const pe of welcome.peers) await addRemote(pe);
    }
    let traffic = null;
    if (opts.traffic && world.pathLines) {
      await msg('Loading traffic…');
      const tpl = [];
      for (const f of ['Vaz 2108', 'niva', 'Peugeot', '2110', 'Honda', 'Nissan', 'gazel']) {
        if (!state.carNames[f]) continue;
        const c = await YDCar.loadCar(vfs, f, (Math.random() * state.carcol.length) | 0, state.carcol); if (UI) applyPlate(c, UI, (Math.random() * 10) | 0, randPlate()); const pathTo = (root, node) => { const p = []; for (let n = node; n && n !== root; n = n.parent) p.unshift(n.parent.children.indexOf(n)); return p; };   // traffic: random palette colour (FUN_00410230: rand() % count)
        tpl.push({ obj: c.obj, radius: c.radius, wheelBase: (c.parOrig ? c.parOrig.frontAxle + c.parOrig.rearAxle : 2.6), wheels: c.wheels.map(w => ({ front: w.front, pivot: pathTo(c.obj, w.pivot), spin: pathTo(c.obj, w.spin), pos: w.pos.clone() })), box: c.box, bnd: c.bnd, par: c.parOrig, parts: Object.fromEntries(['tormz', 'zadni', 'bound'].filter(k => c.parts[k]).map(k => [k, pathTo(c.obj, c.parts[k])])) });
      }
      if (tpl.length) traffic = new YDSim.Traffic(world, scene, tpl, opts.trafficCount || 14);
      if (traffic && net) { traffic.setRemote(!net.isHost); net.hooks.onTraffic = m => { if (traffic.remoteMode && Array.isArray(m.c)) traffic.applyRemote(m.c, (+m.l || 0) + net.half); }; const oh = net.hooks.onHost; net.hooks.onHost = () => { traffic.setRemote(false); if (oh) oh(); }; net.hooks.onUnhost = () => traffic.setRemote(true); }   // network: only the host simulates the traffic, the others show it; a host change hands the cars over (sim.js setRemote)
    }
    await msg('Loading sound…'); await initAudio(state.selected);
    const amb = world.emitters && AU.ctx ? new YDSim.Ambience(AU.ctx, world, vfs, toPcm, AU.sfx) : null; if (amb) amb.init().catch(e => console.warn('ambience', e));
    bindTouch(); bindPause();
    let tyreFx = null;
    try { const cts = await YD.TexSet.load(vfs, 'Graph/citstdmat.tex'); tyreFx = new YDSim.TyreFx(scene, await cts.get('tsmoke.tga'), await cts.get('sled.dds')); G0.sparks = new YDSim.Sparks(scene, await cts.get('bparticle.tga')); } catch (e) { console.warn('tyrefx', e); }
    const mini = new YDSim.Minimap($('minimap')); $('minimap').style.display = world.pathLines ? 'block' : 'none';
    try { const pt = (await YD.TexSet.load(vfs, 'Graph/citstdmat.tex')).raw('point.dds'); if (!mini.build(world, trc, pt && YD.decodeDDS(pt))) console.warn('minimap: old map (no path flags / point.dds)'); } catch (e) { console.warn('minimap', e); }   // FUN_00428c80 (race: with the route)
    G = { renderer, scene, camera, world, car, phys, player, R, envCube, rig, skyObj, sunObj, dynEnv, chase: R ? new R.ChaseCamera() : null, ais, race, route, traffic, amb, mini, tyreFx, net, remotes, gm: state.gm && net ? { t: 0, over: null, msgs: [], meters: new Map() } : null, view: 0, t: 0, last: performance.now(), look: false, hud: { speed: $('speed'), gear: $('gear'), rpm: $('rpmfill') } };
    G.spawnSlot = spawnSlot; G.sparks = G0.sparks || null;   // collision sparks (YDSim.Sparks)
    if (window.YDCarFx) YDCarFx.create(vfs, scene).then(fx => { if (G && G.scene === scene) G.carFx = fx; }).catch(e => console.warn('carfx', e));   // police light bar + collision sparks (carfx.js)
    G.reset = () => {
      const phys = G.phys;
      if (route) { const i = YDSim.nearest(route, phys.pos.x, phys.pos.z, -1, 0); phys.pos.set(route.xs[i], route.ys[i], route.zs[i]); phys.yaw = YDSim.heading(route, i); phys.gy = route.ys[i]; }
      else if (world.pathLines && world.pathLines.length) {   // free drive: back onto the nearest street, facing along it (not the start)
        let best = 1e18, bp = null;
        for (const q of world.pathLines) { const p = q.pts, n = p.length / 3; for (let i = 0; i < n - 1; i++) { const dx = p[i * 3] - phys.pos.x, dz = p[i * 3 + 2] - phys.pos.z, d = dx * dx + dz * dz; if (d < best) { best = d; bp = [p, i]; } } }
        if (bp) { const [p, i] = bp, a = i * 3, b = a + 3; phys.pos.set(p[a], p[a + 1], p[a + 2]); phys.yaw = Math.atan2(p[b] - p[a], p[b + 2] - p[a + 2]); phys.gy = p[a + 1]; }
      } else { phys.pos.copy(world.spawn.pos); phys.yaw = world.spawn.yaw; phys.gy = world.spawn.gy; }
      phys.vel.set(0, 0, 0); phys.yawRate = 0; phys.gear = 1; phys.speed = 0; phys._init = false; G.justReset = true;   // _init: OrigCarPhysics puts the CG back on the ground
    };
    state.G = G; window.G = G; G.stepWorld = stepWorld;   // stepWorld: test aid (headless scenarios step the whole simulation with the RAF loop paused)
    const atq = net ? null : new URLSearchParams(location.search).get('at'); // debug: teleport 'x,z,yaw' (never in network games: no cheating past the others)
    if (atq) { const [ax, az, ay] = atq.split(',').map(Number); phys.pos.set(ax, 0, az); phys.yaw = ay || 0; phys.gy = (world.ground(ax, az, 50) ?? 0); }
    const warp = net ? 0 : +(new URLSearchParams(location.search).get('warp') || 0);
    if (warp) { // test aid: fast-forward the simulation (no rendering) with the demo inputs
      for (let t = 0; t < warp; t += 0.02) stepWorld(0.02, readInput());
    }
    if (new URLSearchParams(location.search).has('dbg') && race) console.log('RACE ' + JSON.stringify({ t: race.t.toFixed(1), len: race.route.len.toFixed(0), st: race.standings().map(e => [e.name.slice(0, 10), e.lap, Math.round(e.progress), Math.round(Math.abs(e.phys.speed * 3.6)), e.done, e.phys.pos.x.toFixed(1), e.phys.pos.z.toFixed(1), (e.phys.yaw).toFixed(2), (e.phys.hitTimer || 0).toFixed(2), e.ai ? e.ai.idx : -1]) }));
    if (race) $('race').style.display = 'block';
    $('loading').style.display = 'none'; $('hud').style.display = 'block';
    if (UI) { UI.stop(); $('uicanvas').style.display = 'none'; }
    if (net && UI) enterLobby();   // network games: the world is loaded, now the car choice screen (GMCar) opens over the live city
    setTimeout(() => { if (AU.ctx && AU.start && AU.start.length) { const b = AU.ctx.createBufferSource(), g = AU.ctx.createGain(); b.buffer = AU.start[Math.floor(Math.random() * AU.start.length)]; g.gain.value = 0.6; b.connect(g).connect(AU.sfx); b.start(); } }, 300);   // engine start (start0/1.wav)
    requestAnimationFrame(loop);
    if (Q0.get('pause') === 'menu') setTimeout(() => setPaused(true), 300);       // test aids: open the original in-game screens
    if (Q0.get('pause') === 'report' && race) setTimeout(() => { G.resShown = true; showResults(); }, 300);
  }

  function fallbackWorld(scene) {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshLambertMaterial({ color: 0x6f7a63 }));
    g.rotation.x = -Math.PI / 2; scene.add(g);
    const grid = new THREE.GridHelper(4000, 400, 0x333333, 0x555555); scene.add(grid);
    return { spawn: { pos: new THREE.Vector3(0, 0, 0), yaw: 0 }, heightAt: () => 0, update() { } };
  }

  function setPaused(p) {
    if (!!G.paused === !!p) return;
    G.paused = p;
    const UI = state.ui;
    if (UI) { // original in-game menu (GSMain, id 0x31) drawn over the frozen scene
      const cv = $('uicanvas');
      if (p) {   // network games: GMMain 0x37 (FUN_004283f0; the game keeps running), RESTART GAME (0x32) for the host, PLEASE RESTART GAME (0x33) for the others (FUN_0042a6c0)
        const gm = G.net && UI.screens.get(0x37); if (gm) { const a = gm.find(0x32), b = gm.find(0x33); if (a) a.setVisible(!!G.net.isHost); if (b) b.setVisible(!G.net.isHost); }   // set when opened: the host can change (left / hidden tab)
        cv.style.display = 'block'; cv.style.background = 'transparent'; UI.openOverlay(gm ? 0x37 : 0x31); cv.focus(); }
      else { UI.closeOverlay(); cv.style.display = 'none'; }
    } else { $('pause').style.display = p ? 'flex' : 'none'; $('pMusic').textContent = 'Music: ' + (AU.mutedByUser ? 'off' : 'on'); }
    if (AU.music) { if (p) AU.music.pause(); else if (!AU.mutedByUser) AU.music.play().catch(() => { }); }
  }
  // ---- network lobby (original FUN_0042a6c0: for network game types the world loads first, then screen GMCar 0x38 opens over the live city) ----
  function enterLobby() {
    const UI = state.ui, cv = $('uicanvas'); G.lobby = true; G.lobbyChosen = false; UI.lobbyCanGo = false; engines(true);   // engine loops stop while the car choice is open
    $('hud').style.display = 'none'; $('minimap').style.display = 'none'; if ($('race')) $('race').style.display = 'none';
    cv.style.display = 'block'; cv.style.background = 'transparent'; UI.openOverlay(0x38); cv.focus();
    if (Q0.has('autogo')) setTimeout(async () => { await swapPlayerCar(); mpGoNow(); }, +Q0.get('autogo') > 100 ? +Q0.get('autogo') : 2500);   // test aid (autogo=ms delay)
  }
  // the host restarted the session (server 'restart'): new race / chase state, everybody back to the car choice; the next GO TO CITY puts them on their slots
  function netRestart() {
    const UI = state.ui; G.report = null; G.resShown = false; G.finSent = false; G.netOrder = null; G.netMsgs = []; if (G.paused) setPaused(false);
    if (G.race) G.race = new YDSim.Race(G.world, G.route, G.race.laps, G.race.entries, G.player);
    if (G.gm) { G.gm = { t: 0, over: null, msgs: [], meters: new Map() }; for (const e of [G.player, ...G.remotes]) e.busted = false; stopSirens(); }
    G.spawnSlot(G.net.slot); if (UI.overlay) UI.closeOverlay(); enterLobby();
  }
  // network game with the in-game menu or report open: the world keeps running (your car stands, the host keeps sending traffic, the chase clock runs)
  function netIdle(dt) {
    const { world, ais } = G; stepFrame(dt, Object.assign({}, IDLE, { handbrake: true }));
    YDSim.placeCar(G.player, dt, world); for (const a of ais) YDSim.placeCar(a, dt, world); if (G.gm) stepGM(dt);
    G.net.sendState(dt, G.phys, G.netInp); G.net.updateRemote(dt); for (const r of G.remotes) YDSim.placeCar(r, dt, world); trafficShadows();
  }
  // host: start the game for everybody; other players: wait for the host (the button used to do nothing)
  function mpGoNow() { const n = G.net; if (!n) return; if (n.goAt) { leaveLobby(); return; } if (n.isHost) n.sendStart(); else { const b = state.ui.screens.get(0x38).find(0x11); if (b) b.setEnabled(false); } }   // non-host: button greys out until the host starts (go -> leaveLobby)
  function leaveLobby() {
    const UI = state.ui, cv = $('uicanvas'); G.lobby = false; G.camEnt = null; if (G.chase) G.chase.init = false; UI.lobbyCanGo = false; UI.closeOverlay(); cv.style.display = 'none';   // start: the camera follows the own car again (FUN_00417240, mode 0)
    $('hud').style.display = 'block'; if (G.world.pathLines) $('minimap').style.display = 'block'; if (G.race) $('race').style.display = 'block';
  }
  // traffic cars: same planar shadow as the player's (made on first sight, dropped with the car)
  function trafficShadows(L) {
    const traffic = G.traffic; if (!traffic || Q0.has('noshadow')) return; L = L || (G.rig ? G.rig.sunDir : new THREE.Vector3(-0.1, -0.43, 0.9).normalize());
    const ts = G.trShadows || (G.trShadows = new Map()), live = new Set(traffic.cars);
    for (const [c, sh] of ts) if (!live.has(c)) { G.scene.remove(sh.group); ts.delete(c); }
    for (const c of traffic.cars) { let sh = ts.get(c); if (!sh) ts.set(c, sh = YDSim.makeShadow({ parts: c.parts, obj: c.obj }, G.scene)); YDSim.updateShadow(sh, c.obj, L, c.obj.position.y - c.radius - 0.02, c.obj.position.distanceTo(G.camera.position) < 150 && !(G.qLevel >= 3)); }
  }
  function lobbyFrame(dt) {
    const { player, world, camera, renderer, scene, net, remotes } = G;
    stepFrame(dt, Object.assign({}, IDLE, { handbrake: true }));   // the world runs on while this player picks a car: own car standing (handbrake), the others driving, traffic stepped and colliding (host: simulated and sent)
    const phys = G.phys; trafficShadows();
    net.updateRemote(dt); YDSim.placeCar(player, dt, world); for (const r of remotes) YDSim.placeCar(r, dt, world);
    net.sendState(dt, phys, null);
    const L = G.rig ? G.rig.sunDir : new THREE.Vector3(-0.1, -0.43, 0.9).normalize();
    for (const e of [player, ...remotes]) if (e.shadow) YDSim.updateShadow(e.shadow, e.car.obj, L, e.gy, true);
    if (world.updateMovers) world.updateMovers(dt, [phys, ...remotes.map(r => r.phys)]);
    if (world.update) world.update(dt, phys, camera);
    if (G.R) { G.R.updateLighting(G.rig, camera, dt, null); if (G.skyObj) G.skyObj.update(); if (G.sunObj) G.sunObj.update(camera); }
    const fwd = new THREE.Vector3(Math.sin(phys.yaw), 0, Math.cos(phys.yaw));
    camera.position.copy(phys.pos).addScaledVector(fwd, -9).add(new THREE.Vector3(0, 3.2, 0)); camera.lookAt(phys.pos.x, phys.pos.y + 1, phys.pos.z);
    renderer.render(scene, camera);
    state.ui.overlayFrame(dt);
  }
  // CHOICE CAR: load the chosen model, give it its own physics, and tell the others
  async function swapPlayerCar() {
    const st = state.ui.settings, folder = st.car().folder, color = st.colorIdx, plate = { type: st.plateType, text: st.plateText }, auto = st.auto;
    const old = G.car, op = G.phys, nc = await YDCar.loadCar(vfs, folder, color, state.carcol);
    G.scene.remove(old.obj); G.scene.add(nc.obj); applyPlate(nc, state.ui, plate.type, plate.text);
    const np = YDCar.makePhysics(nc, G.world); np.pos.copy(op.pos); np.yaw = op.yaw; np.gy = op.gy; if (np.autoShift !== undefined) np.autoShift = auto;
    if (G.R && G.dynEnv) G.R.applyEnvironment(nc.obj, G.dynEnv.texture, G.R.C.REFLECT_MAX);
    if (G.player.shadow) { G.scene.remove(G.player.shadow.group); G.player.shadow = YDSim.makeShadow(nc, G.scene); }
    G.car = nc; G.phys = np; G.player.car = nc; G.player.phys = np; state.selected = folder; state.color = color; state.plate = plate; state.auto = auto;
    G.lobbyChosen = true; G.net.sendCar({ car: folder, col: color, plate, auto });
    if (G.net.isHost || G.net.goAt) { state.ui.lobbyCanGo = true; const b = state.ui.screens.get(0x38).find(0x11); if (b) b.setEnabled(true); }   // GO TO CITY unlocks after the first choice
  }
  function restartUrl() {
    const o = state.opts || {};
    const q = { auto: 1, mode: state.mode, track: o.track || 0, laps: o.laps || 2, opps: o.opponents === undefined ? 7 : o.opponents, traffic: o.traffic ? 1 : 0, tl: Math.max(0, [8, 16, 28].indexOf(o.trafficCount)), hard: o.hardness || 0, car: state.selected, col: state.color, pt: state.plate ? state.plate.type : 0, ptx: state.plate ? state.plate.text || '' : '' };
    if (o.sameCar) q.same = 1; if (state.auto === false) q.manual = 1;   // every single-player option survives RESTART
    return location.pathname + '?' + new URLSearchParams(q);
  }
  function gameCommand(c) { // from the original in-game menu / report screen
    if (c === 'resume') { setPaused(false); pressed.delete('Escape'); }   // the same Esc must not reopen the menu in the next frame
    else if (c === 'restart') { if (G && G.net) { G.net.sendRestart(); if (!G.report) setPaused(false); } else location.href = restartUrl(); }   // network: the host restarts the session for everybody (message 5)
    else if (c === 'pleaserestart') { if (G && G.net) G.net.send({ t: 'pleaserestart' }); }   // GMMain 0x33 -> FUN_00426e10: message 10 to the host, the menu stays open
    else if (c === 'menu') location.href = location.pathname + '?skipsplash=1';
    else if (c === 'exit') { if (state.ui && state.ui.onQuit) state.ui.onQuit(); }
    else if (c === 'mpchoice') swapPlayerCar().catch(e => console.error('car swap', e));
    else if (c === 'mpgo') {
      const n = G.net; if (n.goAt) { leaveLobby(); return; }
      if (!G.lobbyChosen) swapPlayerCar().catch(e => console.error('car swap', e)).then(() => mpGoNow());   // GO TO CITY without CHOICE CAR first: take the car on screen
      else mpGoNow();
    }
  }
  function bindPause() {
    $('pResume').onclick = () => setPaused(false);
    $('pCam').onclick = () => { if (G.chase) { G.chase.cycle(); G.view = G.chase.mode; } };
    $('pMusic').onclick = () => { AU.mutedByUser = !AU.mutedByUser; $('pMusic').textContent = 'Music: ' + (AU.mutedByUser ? 'off' : 'on'); };
    $('pReset').onclick = () => { G.reset(); setPaused(false); };
    $('pMenu').onclick = () => { location.href = location.pathname; };
  }
  // what the camera object reads from the followed car: position, velocity, up / forward axes, the avto.par camera bytes 0x1b8..0x1bb
  const ZV = new THREE.Vector3();
  function camCar(e) { const q = e.car.obj.quaternion; return { pos: e.car.obj.position, vel: (e.phys && e.phys.vel) || ZV, up: new THREE.Vector3(0, 1, 0).applyQuaternion(q), fwd: new THREE.Vector3(0, 0, 1).applyQuaternion(q), par: { camBytes: e.car.camBytes } }; }
  const IDLE = { throttle: 0, brake: 0, steer: 0, handbrake: false, shiftUp: false, shiftDown: false };
  // one physics step of every simulated remote player's car (network controller FUN_0041cce0: the sender's flags between packets) + world collision
  // no packet for 1 s (tab hidden, connection lost): the copy brakes and stands instead of driving on with its last flags
  const STAND = { direct: true, throttle: 0, brake: 1, steer: 0, handbrake: true, shift: 0, thr: 0 };
  function stepRemotes(h) { if (!G || !G.remotes) return; const now = performance.now(); for (const r of G.remotes) if (r.inp && r.phys._init) { r.phys.step(h, now - r.t > 1000 ? STAND : r.inp); if (G.world.collide) G.world.collide(r.phys, h); } }
  // game time = real time (FUN_00436cb0): the frame time (clamped to 0.6 s) is split into n = 1 + trunc(ft*50) whole world updates of ft/n when ft > 0.02 s
  // (variable step, never more than 0.02 s; 60 fps and faster: one step, as before). DEVIATION: at most FRAME_STEPS updates (below 5 fps the game slows down)
  // so a slow phone cannot spiral; the old 0.05 s clamp slowed the game below 20 fps, by a different amount on every peer (network copies drifted).
  const FRAME_STEPS = 10, frameTime = raw => Math.max(0, Math.min(0.6, FRAME_STEPS * 0.02, raw || 0));
  function stepFrame(ft, inp) { const n = ft > 0.02 ? Math.min(FRAME_STEPS, 1 + Math.trunc(ft * 50)) : 1; for (let i = 0; i < n; i++) stepWorld(ft / n, i === 0 || !(inp.shiftUp || inp.shiftDown) ? inp : Object.assign({}, inp, { shiftUp: false, shiftDown: false })); }   // key presses are edges: one shift per frame
  // advance the whole simulation by dt (player, AI, traffic, collisions, race logic)
  function stepWorld(dt, inpRaw) {
    if (!(dt > 1e-5)) return; // a zero-length step would divide by zero in the original physics model
    const { phys, world, ais, race, traffic, player } = G;
    const netWait = G.net && G.net.countdown() > 0;   // multiplayer: everybody waits for the shared start time
    if (netWait && race && race.state === 'countdown') race.t = -G.net.countdown();
    const counting = (race && race.state === 'countdown') || netWait;
    const inp = (counting || (G.gm && player.busted)) ? IDLE : inpRaw;
    for (const a of ais) { a.input = counting ? IDLE : a.ai.drive(a, dt); if (a.needRespawn) a.ai.respawn(a); }
    G.netInp = inp;   // sent with the state packet (net.js)
    const live = (G.remotes || []).filter(r => r.live);   // other players' cars (after their first packet)
    if (traffic) { traffic.others = [phys, ...ais.map(a => a.phys), ...live.map(r => r.phys)]; traffic.players = [phys.pos, ...live.map(r => r.phys.pos)]; traffic.drive(dt, traffic.others); }   // traffic controller FUN_0041b880: this frame's flags
    const steps = Math.max(1, Math.ceil(dt / 0.008)), h = dt / steps;
    for (let i = 0; i < steps; i++) {
      phys.step(h, i === 0 ? inp : (inp.shiftUp || inp.shiftDown ? Object.assign({}, inp, { shiftUp: false, shiftDown: false }) : inp));   // key presses are edges: one shift per frame, not per sub-step
      if (world.collide) world.collide(phys, h);
      for (const a of ais) { a.phys.step(h, a.input); if (world.collide) world.collide(a.phys, h); }
      if (traffic) traffic.step(h, i === 0);   // traffic cars are full physics bodies too (network clients: the host's cars, simulated with its flags)
      stepRemotes(h);   // other players' cars: simulated with their last received inputs, corrected per packet (net.js updateRemote)
      const bodies = [phys]; for (const a of ais) bodies.push(a.phys); if (traffic) bodies.push(...traffic.colliders()); for (const r of live) bodies.push(r.phys);
      if (bodies.length > 1) YDSim.collideBodies(bodies, h);   // car vs car, every pair from both sides (FUN_0041f900); own car vs remote copies too: no contact message, each peer resolves its own car
    }
    const bad = p => !isFinite(p.pos.x + p.pos.z + p.speed + p.rpm);
    if (bad(phys)) G.reset();
    for (const a of ais) if (bad(a.phys)) { a.needRespawn = true; a.ai.respawn(a); }
    for (const r of live) if (r.inp && bad(r.phys)) { r.phys._init = false; r.inp = null; r.live = false; }   // blown-up copy: the next packet snaps it
    if (traffic) {
      traffic.update(dt, phys.pos);
      if (G.net && G.net.isHost && (G.trT = (G.trT || 0) + dt) > 0.1) { G.trT = 0; G.net.sendTraffic(traffic.snapshot()); }
    }
    if (race) race.update(dt);
    if (race && G.net && player.done && !G.finSent) { G.finSent = true; G.net.send({ t: 'fin', time: player.time }); }   // own finish -> everybody (each player is authoritative for its own car)
    G.t += dt;
  }
  const fmt = t => { t = Math.max(0, t); const m = Math.floor(t / 60); return m + ':' + (t - m * 60).toFixed(1).padStart(4, '0'); };
  // a car's paint colour as ARGB (car+0x1e0 = the diffuse the original puts on its paint materials; report car names and minimap dots use it)
  function paintARGB(car) { const m = car && car.materials && car.materials.find(x => x && x.userData && x.userData.paint && x.color); if (!m) return 0xffffffff; const b = v => Math.max(0, Math.min(255, Math.round(v * 255))); return ((0xff << 24) | (b(m.color.r) << 16) | (b(m.color.g) << 8) | b(m.color.b)) >>> 0; }
  // Gogh & Milica over (host message 0x12 -> FUN_00427bb0(param)): the report screen opens at once with no rows and the label GWin (param 0) / MWin (1);
  // RESTART only for the host. The game stays there (no automatic return to the menu, no win sound: the original loads none).
  function showGMEnd() {
    const UI = state.ui, gm = G.gm; if (!UI || !gm || !gm.over) return; stopSirens();
    UI.setReport([], UI.S('STRINGS', gm.over.cops ? 'MWin' : 'GWin', gm.over.cops ? 'MILICANER WINS!' : 'GOXER WINS!'), !G.net || G.net.isHost);
    G.paused = true; G.report = []; const cv = $('uicanvas'); cv.style.display = 'block'; cv.style.background = 'transparent'; UI.openOverlay(0x35); cv.focus();
  }
  function showResults() {
    const r = G.race, UI = state.ui; let st = r.standings();
    if (G.net && G.netOrder) { const o = G.netOrder.map(netEnt).filter(e => e && st.includes(e)); st = o.concat(st.filter(e => !o.includes(e))); }   // network race: the host's finish order
    if (UI) { // original report screen (FUN_00427bb0: GReport 0x35 with one line per racer: "n.", name, car name in its paint colour)
      UI.setReport(st.map(e => ({ name: String(e.name || '').replace(/[^\x20-\xff]/g, ''), car: state.carNames[e.car && e.car.folder] || '', color: paintARGB(e.car) })), null, !G.net || G.net.isHost);   // network: RESTART only for the host (type 3: FUN_00427bb0 sets the flag from DAT_004dd090)
      G.paused = true; G.report = st; const cv = $('uicanvas'); cv.style.display = 'block'; cv.style.background = 'transparent'; UI.openOverlay(0x35); cv.focus(); return;
    }
    $('resTitle').textContent = r.place(G.player) === 1 ? 'You won!' : 'Finished ' + r.place(G.player) + (['st', 'nd', 'rd'][r.place(G.player) - 1] || 'th');
    $('resList').innerHTML = st.map((e, i) => `<div style="${e.isPlayer ? 'color:#f2b705;font-weight:700' : ''}">${i + 1}. ${e.name} <span style="float:right;margin-left:24px">${e.done ? fmt(e.time) : 'DNF'}</span></div>`).join('');
    $('results').style.display = 'flex'; G.paused = true;
    $('resAgain').onclick = () => { location.href = restartUrl(); };
    $('resMenu').onclick = () => { location.href = location.pathname; };
  }
  function loop(now) {
    requestAnimationFrame(loop);
    const raw = (now - G.last) / 1000, dt = frameTime(raw); G.last = now;
    // quality governor: if the average frame takes > 26 ms over ~1.5 s, drop the costliest extras one step at a time (1: rival live reflections, 2: player live reflection, 3: shadows)
    if (raw > 0 && raw < 0.5 && !G.paused && !Q0.has('fixedq')) { G.fpsAcc = (G.fpsAcc || 0) + raw; if ((G.fpsN = (G.fpsN || 0) + 1) >= 90) { const avg = G.fpsAcc / G.fpsN; G.fpsAcc = G.fpsN = 0; if (avg > 0.026 && (G.qLevel || 0) < 3) { G.qLevel = (G.qLevel || 0) + 1; console.warn('quality level', G.qLevel, 'avg frame ms', (avg * 1000).toFixed(1)); if (G.qLevel === 2 && G.dynEnv && G.R) { G.dynEnv = null; G.R.setReflectivity(G.car.obj, G.R.C.REFLECT_MAX, G.envCube); } } } } // never negative: the first RAF timestamp can predate G.last
    const { phys, car, camera, world, renderer, scene, player, ais, race, traffic } = G;
    if (GL.lost) { pressed.clear(); if (state.ui) state.ui.drawLoading(0.2 * GL.p); return; }   // WebGL context lost: nothing runs, the original loading screen (bar = texture refill)
    if (G.lobby) { lobbyFrame(dt); return; }
    if (pressed.has('Escape') && !G.report && !$('results').style.display.includes('flex')) setPaused(!G.paused);
    if (G.paused) {
      if (G.net) netIdle(dt);
      if (state.ui && state.ui.overlay) {
        state.ui.overlayFrame(dt);
      }
      if (G.chase && !G.lobby) { G.chase.setFree(true); G.chase.update(camCar(G.camEnt || player), dt, camera, { tris: world.camTris }); if (G.skyObj) G.skyObj.update(); if (G.sunObj) G.sunObj.update(camera); }   // paused (menu / report): free camera orbits the car at 9 m (FUN_004179e0), restored exactly on resume
      pressed.clear(); engines(true); horn(false); otherHorns(true); skidSound(0); if (G.amb) G.amb.stop(); renderer.render(scene, camera); return; }
    const inp = readInput();
    if (pressed.has('KeyC') && G.chase) { G.chase.cycle(); G.view = G.chase.mode; }   // C (also the touch CAM button): 0 -> 1 -> 2 -> 0
    if (pressed.has('F3')) G.pressedF3 = true;
    if (pressed.has('KeyN')) nextSong();
    if (pressed.has('KeyP')) nextSong(false, -1);
    if (pressed.has('BracketRight')) musicVolume(0.1);
    if (pressed.has('BracketLeft')) musicVolume(-0.1);
    // original controls (readme): + / - zoom the map, M = siren (only in the Gogh & Milica network game; police team)
    if (G.mini && (keys.has('Equal') || keys.has('NumpadAdd'))) G.mini.zoomBy(-dt);   // held: zoom window -1 / +1 map unit per s (FUN_00425ac0 numpad +, FUN_00425a90 - / numpad -; = for keyboards without a numpad)
    if (G.mini && (keys.has('Minus') || keys.has('NumpadSubtract'))) G.mini.zoomBy(dt);
    if (pressed.has('KeyM') && G.gm && G.player.team === 'm') toggleSiren();
    if (pressed.has('KeyU')) { AU.mutedByUser = !AU.mutedByUser; if (AU.music) { AU.mutedByUser ? AU.music.pause() : AU.music.play().catch(() => { }); } }
    if (pressed.has('KeyR')) G.reset();
    horn(keys.has('KeyH')); G.look = keys.has('KeyB');
    pressed.clear();
    stepFrame(dt, inp);
    // place every car on the ground
    YDSim.placeCar(player, dt, world); for (const a of ais) YDSim.placeCar(a, dt, world);
    if (G.gm) stepGM(dt);
    if (G.net) { G.net.sendState(dt, phys, G.netInp, keys.has('KeyH')); G.net.updateRemote(dt); for (const r of G.remotes) YDSim.placeCar(r, dt, world); updateSirens(); if (G.gm && G.gm.over && sirens.size) stopSirens(); }
    { // planar shadows (original: car mesh projected along the sun direction, alpha 0.3)
      const L = G.rig ? G.rig.sunDir : new THREE.Vector3(-0.1, -0.43, 0.9).normalize();
      for (const e of [player, ...ais, ...(G.remotes || [])]) if (e.shadow) YDSim.updateShadow(e.shadow, e.car.obj, L, e.gy, (e === player || e.car.obj.position.distanceTo(camera.position) < 150) && !(G.qLevel >= 3));
      trafficShadows(L);
    }
    if (G.sparks) G.sparks.update(dt);
    if (G.tyreFx) { player.id = 'p'; ais.forEach((x, i) => x.id = 'a' + i); G.tyreFx.update(dt, [player, ...ais, ...(traffic ? traffic.fxEnts() : [])], camera.position); }
    YDSim.updateLamps(car, (inp.brake > 0.1 && phys.gear >= 0) || inp.handbrake, phys.gear < 0);
    for (const a of ais) YDSim.updateLamps(a.car, (a.input && a.input.brake > 0.1 && a.phys.gear >= 0), a.phys.gear < 0);
    if (traffic) for (const c of traffic.cars) YDSim.updateLamps(c, c.braking, c.phys ? c.phys.gear < 0 : false);   // traffic reverses when stuck (FUN_0041b880)
    for (const r of G.remotes || []) YDSim.updateLamps(r.car, r.phys.braking !== undefined ? r.phys.braking && r.phys.gear >= 0 : false, r.phys.gear < 0);
    // spectator (FUN_00427e00 network race, FUN_00427fc0 Gogh & Milica): own car finished / busted and standing (< 0.2 m/s) -> every frame the camera follows
    // (FUN_00417240: reset, mode 0) the leading racer that has not finished / the first robber still free
    if (G.chase && G.net && (race ? player.done : G.gm && player.busted) && phys.vel.length() < 0.2) {
      const nx = race ? race.standings().find(e => !e.done) : G.remotes.find(e => e.team === 'g' && !e.busted);
      if (nx) { G.camEnt = nx === player ? null : nx; G.chase.reset(camCar(nx)); }
    }
    if (G.camEnt && !(G.remotes || []).includes(G.camEnt) && !ais.includes(G.camEnt)) { G.camEnt = null; if (G.chase) G.chase.reset(camCar(player)); }   // the followed car left the game
    // camera: the original camera object (render-orig ChaseCamera = FUN_00417ad0 update + FUN_00417630 view); the car is drawn in every mode
    if (G.chase) { const ch = G.chase; ch.setFree(false); ch.lookBehind = G.look; ch.update(camCar(G.camEnt || player), dt, camera, { tris: world.camTris }); G.view = ch.mode; }
    car.obj.visible = true;
    if (Q0.has('tilt') && ((G.tf = (G.tf || 0) + 1) === 3 || G.tf % 90 === 0)) { const q = car.obj.quaternion, u = new THREE.Vector3(0, 1, 0).applyQuaternion(q), f = new THREE.Vector3(0, 0, 1).applyQuaternion(q); console.log('TILT ' + JSON.stringify({ f: G.tf, pos: car.obj.position.toArray().map(v => +v.toFixed(2)), up: u.toArray().map(v => +v.toFixed(2)), fwd: f.toArray().map(v => +v.toFixed(2)), cam: camera.position.toArray().map(v => +v.toFixed(2)), mode: G.chase && G.chase.mode, view: G.view, eye: G.chase && G.chase.eye.toArray().map(v => +v.toFixed(2)), tgt: G.chase && G.chase.target.toArray().map(v => +v.toFixed(2)), look: G.look,  camUp: camera.up.toArray().map(v => +v.toFixed(2)), pitch: +phys.pitch.toFixed(3), roll: +phys.roll.toFixed(3), py: +phys.pos.y.toFixed(2), gy: +(phys.gy || 0).toFixed(2), kmh: +(phys.speed * 3.6).toFixed(0) })); }
    if (G.R) { // original lighting, sky, sun and live reflection cube
      G.R.updateLighting(G.rig, camera, dt, null);
      if (G.skyObj) G.skyObj.update(); if (G.sunObj) G.sunObj.update(camera);
      { const under = G.under = phys.pos.y < -2.5 && !!(world.roofAbove && world.roofAbove(car.obj.position.x, phys.pos.y, car.obj.position.z, 30)); if (G.skyObj) G.skyObj.object.visible = !under; if (G.sunObj && G.sunObj.object) G.sunObj.object.visible = !under; scene.background.setHex(under ? 0x050505 : 0x9ec3e6); }   // underground: dark, not sky blue, where the tunnel is not drawn
      if (G.dynEnv) G.dynEnv.update(renderer, scene, car.obj.position, new THREE.Vector3(0, 1, 0), car.obj, 1);   // one cube face per frame (full refresh every 6 frames)
      if (G.envCube && !Q0.has('noenv')) { // rivals: the nearest ones get a live cube each (pool), the rest the static cube; strength falls with distance
        const R_ = G.R, vd = (state.ui && state.ui.settings.viewDist) || 0, up = new THREE.Vector3(0, 1, 0);
        const near = ais.map(a => [a, a.car.obj.position.distanceTo(camera.position)]).sort((x, y) => x[1] - y[1]);
        G.envPool = G.envPool || Array.from({ length: +(Q0.get('envn') || 1) }, (_, i) => { const e = new R_.DynamicEnv(128); e.frame = i + 1; return e; });
        near.forEach(([a, d], i) => {
          const f = Math.max(0, R_.reflectionFactor(3.2, d, vd)), pooled = i < G.envPool.length && d < 70 && !(G.qLevel >= 1);
          R_.setReflectivity(a.car.obj, f, pooled ? G.envPool[i].texture : G.envCube);
          if (pooled) G.envPool[i].update(renderer, scene, a.car.obj.position, up, a.car.obj, 3);   // rivals: one face every 3 frames
        });
        R_.setReflectivity(car.obj, Math.max(0, R_.reflectionFactor(3.2, camera.position.distanceTo(car.obj.position), vd)) || R_.C.REFLECT_MAX);
      }
    }
    if (world.updateMovers) world.updateMovers(dt, [phys, ...ais.map(a => a.phys), ...(G.remotes || []).map(r => r.phys), ...(traffic ? traffic.colliders() : [])]);   // movable objects (metro doors, cola machines ...): rigid bodies (world.js)
    if (world.update) world.update(dt, phys, camera);
    if (G.amb) G.amb.update(dt, camera.position);   // the listener is the camera, as for every 3D sound
    // audio
    if (AU.ctx) {
      listener3(); engines(); voices();   // every car's engine.wav, driver voices (3D, doppler), listener = camera
      crashSounds([phys, ...ais.map(a => a.phys), ...(traffic ? traffic.colliders() : []), ...(G.remotes || []).map(r => r.phys)], dt); otherHorns(); G.justReset = false;
      { const sl = Math.max(phys.slip || 0, inp.handbrake ? 0.8 : 0, inp.brake > 0.5 ? 0.35 : 0), mv = Math.abs(phys.speed) > 4 ? 1 : 0; skidSound(sl > 0.3 ? (sl - 0.2) * mv * 0.8 : 0); }
    }
    // HUD
    const origHud = drawOrigHud(phys, car, race, player); $('dash').style.display = origHud ? 'none' : '';   // Takhometr off = no gauges at all (original)
    if (origHud && race) $('rpos').parentElement.style.display = 'none';
    G.hud.speed.textContent = Math.round(Math.abs(phys.speed) * 3.6);
    G.hud.gear.textContent = phys.gear < 0 ? 'R' : phys.gear === 0 ? 'N' : phys.gear;
    G.hud.rpm.style.width = Math.min(100, phys.rpm / car.par.maxRpm * 100) + '%';
    G.hud.rpm.style.background = phys.rpm > car.par.shiftRpm ? '#e33' : '#4c8';
    if (race) {
      $('rpos').textContent = 'P' + race.place(player) + '/' + race.entries.length;
      $('rlap').textContent = 'Lap ' + clampLap(player.lap + 1, race.laps) + '/' + race.laps;
      $('rtime').textContent = fmt(race.t);
      const c = $('count'); if (origHud) c.style.display = 'none'; else
      if (race.state === 'countdown') { c.style.display = 'block'; c.textContent = Math.ceil(-race.t); }
      else if (race.t < 1) { c.style.display = 'block'; c.textContent = 'GO!'; } else c.style.display = 'none';
      if (player.done && !G.resShown && (G.net ? G.net.isHost && race.entries.every(e => e.done) && phys.vel.length() < 0.2 : phys.vel.length() < 0.2 || (DEMO && race.t - race.finishedAt > 2.5))) { G.resShown = true; if (G.net) G.net.send({ t: 'over', order: race.standings().map(netIdOf) }); showResults(); }   // network: the host decides (FUN_0042b190 sends 0x12 only from the host) and its finish order goes to everybody   // single race (FUN_00427cd0): report once your finished car stands (< 0.2 m/s); network race (FUN_00427e00): also waits until every racer is in (spectator camera meanwhile)
    }
    if (G.mini) { const mk = Math.min(innerHeight, innerWidth) / 768, mc = $('minimap'); mc.style.width = 205 * mk + 'px'; mc.style.height = 205 * mk + 'px'; if (!state.ui || state.ui.settings.showMap) G.mini.draw(world, phys, race, ais, traffic, { ents: [player, ...ais, ...(G.remotes || [])], color: e => paintARGB(e.car), gm: !!G.gm, siren: e => e === player ? !!player.siren : sirens.has(e.id), t: G.t }); else mc.style.display = 'none'; }
    if (G.carFx) { // light bar on police cars (Gogh & Milica team 'm' = ctrl+0x6c), lights while the siren is on (+0x6d); ?migalka=1 forces it on the player
      const dbg = Q0.has('migalka'); if (dbg) { player.police = true; player.siren = Q0.get('migalka') !== '0'; } else player.police = !!G.gm && player.team === 'm';
      for (const r of G.remotes || []) r.police = !!G.gm && r.team === 'm';
      G.carFx.update(dt, [player, ...(G.remotes || [])], camera, G.chase && G.chase.vel);
    }
    renderer.render(scene, camera);
    perfOverlay(raw);
  }
  // F3: performance readout (frames/s, draw calls, triangles, GPU) - to see what the browser really does on this machine
  function perfOverlay(raw) {
    if (G.pressedF3) { G.pressedF3 = false; G.perfOn = !G.perfOn; if (!G.perfOn && G.perfEl) G.perfEl.style.display = 'none'; }
    if (!G.perfOn) return;
    G.perfMs = (G.perfMs || 16) * 0.95 + (raw > 0 && raw < 0.5 ? raw * 1000 : G.perfMs || 16) * 0.05; G.perfWorst = Math.max((G.perfWorst || 0) * 0.995, raw * 1000 || 0);
    if (!G.perfEl) { const d = G.perfEl = document.createElement('pre'); d.style.cssText = 'position:fixed;left:8px;top:215px;margin:0;padding:6px 8px;background:rgba(0,0,0,.65);color:#9f9;font:12px monospace;z-index:30;pointer-events:none;white-space:pre'; document.body.appendChild(d);
      try { const gl = G.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); G.gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown'; } catch (e) { G.gpu = 'unknown'; } }
    const now = performance.now(); if (now - (G.perfT || 0) < 400) return; G.perfT = now; G.perfEl.style.display = 'block';
    const inf = G.renderer.info, sw = /swiftshader|llvmpipe|software/i.test(G.gpu || '');
    G.perfEl.textContent = (1000 / G.perfMs).toFixed(0) + ' fps  ' + G.perfMs.toFixed(1) + ' ms  (worst ' + G.perfWorst.toFixed(0) + ' ms)\n' +
      'draw calls ' + inf.render.calls + '   triangles ' + (inf.render.triangles / 1000).toFixed(0) + 'k\n' +
      'geometries ' + inf.memory.geometries + '   textures ' + inf.memory.textures + '\n' +
      'quality level ' + (G.qLevel || 0) + '   traffic ' + (G.traffic ? G.traffic.cars.length : 0) + '   rivals ' + G.ais.length + '\n' +
      'GPU ' + (G.gpu || '?') + (sw ? '   << SOFTWARE RENDERING: slow, check browser hardware acceleration' : '') + '\n' + (G.under ? 'underground' : '');
  }
  // original HUD gauges (ui-orig.js drawGauges = FUN_00425af0) drawn on a 1024x768 canvas, blitted bottom-right with uniform scale
  // ---- Gogh & Milica (game type 4; FUN_00428xxx): cops (flag +0x6c) vs robbers; a robber's meter (+0x70, starts 1.0) drains at 0.1/s while a live cop is
  // within 7 m and the relative speed is < 10 m/s, otherwise recovers at 0.01/s; at 0 the robber is busted. All robbers busted -> police win; the 300 s timer
  // (game+0xfbc = 300.0) running out -> the robbers win. HUD: panel + "Elapsed time m:ss" (FUN_00427790).
  function stepGM(dt) {
    const gm = G.gm; if (gm.over) { if (!gm.shown) { gm.shown = true; showGMEnd(); } return; }   // FUN_00427fc0: game over -> report screen, stays until RESTART / MAIN MENU / EXIT
    if (G.net && G.net.countdown() > 0) return;   // chase starts at the shared start time
    gm.t += dt;
    const all = [G.player, ...G.remotes], cops = all.filter(e => e.team === 'm'), rob = all.filter(e => e.team === 'g');
    const vel = e => e.phys.vel || { x: 0, y: 0, z: 0 }, judge = !G.net || G.net.isHost;   // network: only the host busts and ends the game (FUN_00427fc0 checks DAT_004dd090 for the end; DEVIATION: busts too, so screens cannot disagree over the internet), message 'bust' / 'over'
    for (const r of rob) {
      if (r.busted) continue; let m = gm.meters.has(r) ? gm.meters.get(r) : 1;
      for (const c of cops) {
        if (c.busted) continue;
        const d = Math.hypot(c.phys.pos.x - r.phys.pos.x, c.phys.pos.z - r.phys.pos.z), vr = Math.hypot(vel(c).x - vel(r).x, vel(c).z - vel(r).z);
        if (d >= 7 || vr >= 10) m = Math.min(1, m + dt * 0.01); else m -= dt * 0.1;
      }
      gm.meters.set(r, Math.max(0, m));
      if (m <= 0 && judge) { gmBust(r); if (G.net) G.net.send({ t: 'bust', id: netIdOf(r) }); }
    }
    if (!judge) return;
    if (rob.length && rob.every(r => r.busted)) gm.over = { cops: true, t: 0 };
    else if (gm.t >= 300 && rob.length) gm.over = { cops: false, t: 0 };
    if (gm.over && G.net) G.net.send({ t: 'over', w: gm.over.cops ? 1 : 0 });   // message 0x12: param 1 = MWin, 0 = GWin
  }
  const netIdOf = e => e === G.player ? G.net.id : +String(e.id).slice(1), netEnt = id => G.net && (id === G.net.id ? G.player : G.net.remote.get(id));
  function gmBust(r) { if (!r || r.busted) return; r.busted = true; netMsg((r === G.player ? (G.net && G.net.hello.name) : r.name) + ' ' + state.ui.S('STRINGS', 'Busted', 'BUSTED!').trim(), 0); }   // "%s %s" name + Busted, FUN_00427350(.., 255, 0, 0)
  function drawGM(R, o, UI) {
    const gm = G.gm, sec = Math.floor(Math.max(0, 300 - gm.t));   // FUN_00427790 prints game+0xfbc, the 300 s clock counting DOWN (min = ftol(t/60), s = ftol(t - min*60)), under the label ElapsedTime
    const T = G.net ? G.net.countdown() : 0;   // same 3-2-1-Go countdown as the race (FUN_004285c0), on the shared multiplayer clock
    if (T > -0.8 && T < 4) { const idx = Math.max(0, Math.floor(T)), sz = 0.05 + (Math.max(0, T) - idx) * 0.12, str = idx === 0 ? UI.S('STRINGS', 'Go', 'Go') : String(idx); R.text(UI.fontBig, 0, 0, sz, sz, 0xffffffff, str, 0xb); }
    R.sprite(null, 0.35, -1.0, 0.65, 0.1, 0x9632325a);
    R.text(UI.fontBig, 0.38, -0.98, 0.07, 0.07, 0xffff7d7d >>> 0, UI.S('STRINGS', 'ElapsedTime', 'Elapsed time') + ' ' + Math.floor(sec / 60) + ':' + (sec % 60 < 10 ? '0' : '') + sec % 60, 8);
  }
  function drawOrigHud(phys, car, race, player) {
    const UI = state.ui; if (!UI || !UI.carmat) return false;
    const c = $('hudcanvas'); if (c.width !== innerWidth || c.height !== innerHeight) { c.width = innerWidth; c.height = innerHeight; }
    const g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height);
    const off = G.gaugeCanvas || (G.gaugeCanvas = Object.assign(document.createElement('canvas'), { width: 1024, height: 768 }));
    const o = off.getContext('2d'); o.clearRect(0, 0, 1024, 768);
    const k = Math.min(innerHeight, innerWidth) / 768, kf = Math.min(innerWidth / 1024, innerHeight / 768), fy = (innerHeight - 768 * kf) / 2;   // portrait phones: scale by the width; full 4:3 overlays letterboxed (= old values in landscape)
    if (UI.settings.showTakh) {
      UI.drawGauges(o, { rpm: phys.rpm, maxRpm: car.par.maxRpm, speed: phys.speed, gear: ((race && race.state === 'countdown') || (G.net && G.net.countdown() > 0)) ? 0 : phys.gear });   // real game shows N while the cars are locked on the grid
      const vw = Math.trunc(1024 * 0.3), vh = Math.trunc(768 * 0.2);
      const lift = window.touchMode && innerWidth - 400 < vw * k ? 240 : 0;   // touch pad = 154 px left + 236 px right, 234 px high (index.html #touch): no gap between them (portrait) -> gauges above it
      g.drawImage(off, 1024 - vw, 768 - vh, vw, vh, window.touchMode ? (innerWidth - vw * k) / 2 : innerWidth - vw * k, innerHeight - vh * k - lift, vw * k, vh * k);   // touch devices: gauges move to the bottom centre (d-pad right, STOP left)
      o.clearRect(0, 0, 1024, 768);
    }
    if (race) { // FUN_004278a0: panel + "Your position n/m" and "Laps n/m" (positions/colours read from the disassembly)
      const R = G.hudR || (G.hudR = new YDUI._core.Renderer(o)); R.ctx = o;
      R.sprite(null, 0.35, -1.0, 0.65, 0.1, 0x9632325a);
      const pos = race.place(player), lap = Math.max(1, Math.min(race.laps, player.lap + 1));
      R.text(UI.fontBig, 0.38, -0.98, 0.07, 0.07, 0xffff7d7d >>> 0, UI.S('STRINGS', 'YourPosition', 'Your position') + ' ' + pos + '/' + race.entries.length, 8);
      R.text(UI.fontBig, 0.62, -0.98, 0.07, 0.07, 0xffff7d7d >>> 0, UI.S('STRINGS', 'Laps', 'Laps') + ' ' + lap + '/' + race.laps, 8);
      g.drawImage(off, 680, 0, 344, 48, innerWidth - 344 * k, 0, 344 * k, 48 * k);
      const T = -race.t; // FUN_004285c0: shown while 0 < T < 4: "3","2","1","Go", centred, size 0.05 + frac(T)*0.12
      if (T > 0 && T < 4) {
        o.clearRect(0, 0, 1024, 768);
        const idx = Math.floor(T), sz = 0.05 + (T - idx) * 0.12, str = idx === 0 ? UI.S('STRINGS', 'Go', 'Go') : String(idx);
        R.text(UI.fontBig, 0, 0, sz, sz, 0xffffffff, str, 0xb);
        g.drawImage(off, (innerWidth - 1024 * kf) / 2, fy, 1024 * kf, 768 * kf);
      }
    }
    if (G.gm) {
      const R = G.hudR || (G.hudR = new YDUI._core.Renderer(o)); R.ctx = o; o.clearRect(0, 0, 1024, 768);
      drawGM(R, o, UI); g.drawImage(off, (innerWidth - 1024 * kf) / 2, fy, 1024 * kf, 768 * kf);
    }
    if (G.netMsgs && G.netMsgs.length) {   // message ring FUN_00427410 (left the game / asks to restart / busted / server down): bottom left, newest lowest
      const now = performance.now(); G.netMsgs = G.netMsgs.filter(m => now - m.t < 5000);
      const R = G.hudR || (G.hudR = new YDUI._core.Renderer(o)); R.ctx = o; o.clearRect(0, 0, 1024, 768);
      G.netMsgs.forEach((m, i) => { const life = 5 - (now - m.t) / 1000, a = life < 1 ? Math.max(0, Math.floor(life * 255)) : 255; R.text(UI.fontSmall, -0.95, 0.95 - i * 0.07, 0.05, 0.05, ((a << 24) | m.rgb) >>> 0, m.text, 8); }); g.drawImage(off, (innerWidth - 1024 * kf) / 2, fy, 1024 * kf, 768 * kf);
    }
    return true;
  }
  const clampLap = (l, max) => Math.max(1, Math.min(max, l));

  window.addEventListener('DOMContentLoaded', () => { boot().catch(fail); });
})();
