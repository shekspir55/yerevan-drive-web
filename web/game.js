// Yerevan Drive (web port) – game shell: menu, loading, input, camera, HUD, audio.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const vfs = new YD.VFS();
  const CAR_FOLDERS = ['2110', 'A190', 'bmw', 'CL600', 'G500', 'gazel', 'Honda', 'HUMMER', 'Kamaz', 'mits', 'Nissan', 'niva', 'Peugeot', 'Toyota', 'TT', 'UAZ', 'Vaz 2108'];

  const EXTRA_COLS = [[0.95, 0.95, 0.95], [0.7, 0.72, 0.75], [0.03, 0.03, 0.03], [0.75, 0.05, 0.05], [0.1, 0.25, 0.7], [0.9, 0.75, 0.1]];   // white, silver, black, red, blue, yellow
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
    state.carcol = Object.keys(ini).sort().map(k => [+ini[k].R, +ini[k].G, +ini[k].B]);
    state.carcol.push(...EXTRA_COLS);   // carcol.ini has only 10 colours (5 of them green, no white): add the common real-car colours
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
    state.ui = ui; window.UIOBJ = ui; ui.onGameCommand = gameCommand; ui.onNetwork = (a, d) => netStart(ui, a, d); ui.run(); cv.focus();
    if (Q.has('auto')) { // test aid: skip the menus
      if (Q.has('nopaint')) state.carcol = [];   // the original under Wine finds no carcol.ini palette (relative path) -> cars keep their material colour
      if (Q.has('colrgb')) state.carcol[+(Q.get('col') || 1)] = Q.get('colrgb').split(',').map(Number);
      if (Q.has('net')) return netStart(ui, Q.get('net'), { name: 'Tester' + ((Math.random() * 99) | 0), password: '', session: Q.get('sess') || 'test', maxPlayers: 2, gameType: +(Q.get('gt') || 0), laps: 2 });
      fromUI(ui, { car: { folder: Q.get('car') || 'bmw' }, colorIdx: +(Q.get('col') || 1), plateType: 0, plateText: '', auto: !Q.has('manual'), race: Q.get('mode') === 'gonka', laps: +(Q.get('laps') || 2), opponents: Q.has('opps') ? +Q.get('opps') : 7, traffic: Q.get('traffic') === '0' ? -1 : 1, hardness: +(Q.get('hard') || 1), opponentCars: Q.get('same') ? 1 : 0, track: Q.has('track') ? +Q.get('track') : undefined });
    }
  }
  async function initCarList() {
    const ini = await vfs.ini('Cars/carcol.ini');
    state.carcol = Object.keys(ini).sort((a, b) => +a.replace(/\D/g, '') - +b.replace(/\D/g, '')).map(k => [+ini[k].R, +ini[k].G, +ini[k].B]);
    state.carcol.push(...EXTRA_COLS);   // carcol.ini has only 10 colours (5 of them green, no white): add the common real-car colours
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
    start().catch(e => { state.net = null; console.error(e); ui.show(0x27, true); ui.setMode && ui.setMode('menu'); toast('Multiplayer: ' + (e && e.message || e)); });
  }
  // police siren (two-tone, Web Audio); the original plays a siren sample and flashes the 'migalka' light bar
  // sirens are keyed by owner ('me' or 'n<id>'); remote ones get quieter with distance (see loop)
  const sirens = new Map();
  function setSiren(key, on) {
    const ctx = AU.ctx; if (!ctx) return;
    const cur = sirens.get(key);
    if (!on) { if (cur) { clearInterval(cur.t); cur.o.stop(); sirens.delete(key); } return; }
    if (cur) return;
    if (AU.police) { const o = ctx.createBufferSource(), g = ctx.createGain(); o.buffer = AU.police; o.loop = true; g.gain.value = key === 'me' ? 0.5 : 0.3; o.connect(g); g.connect(ctx.destination); o.start(); sirens.set(key, { o, g, t: 0, base: g.gain.value }); return; }   // police.wav
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'square'; g.gain.value = 0.04; o.connect(g); g.connect(ctx.destination); o.start();
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
      if (e.code === 'Enter') { const t = inp.value.trim(); if (t) { net.sendChat(t); chatLine('me: ' + t); } inp.value = ''; inp.style.display = 'none'; inp.blur(); }
      else if (e.code === 'Escape') { inp.value = ''; inp.style.display = 'none'; inp.blur(); }
    });
    inp.addEventListener('keyup', e => e.stopPropagation());
  }
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
    const show = () => { window.touchMode = true; $('touch').style.display = 'block'; $('help').style.display = 'none'; };
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
      const snd = YD.readBFX(await vfs.bytes('Cars/' + carFolder + '/avto.snd'));
      const eng = snd.get('engine.wav') || [...snd.values()][0];
      const buf = await AU.ctx.decodeAudioData(eng.slice(0));
      const src = AU.ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      AU.engGain = AU.ctx.createGain(); AU.engGain.gain.value = 0.0; src.connect(AU.engGain).connect(AU.ctx.destination); src.start();
      AU.engine = src;
    } catch (e) { console.warn('engine audio', e); }
    try { const cs = YD.readBFX(await vfs.bytes('Cars/carstd.snd')); const h = cs.get('horn' + ((carFolder.length + 1) % 3) + '.wav') || cs.get('horn0.wav'); if (h) AU.horn = await AU.ctx.decodeAudioData(h.slice(0)); const sk = cs.get('skid.wav'); if (sk) { try { AU.skidBuf = await AU.ctx.decodeAudioData(imaToWav(sk)); } catch (e) { console.warn('skid', e); } } try { const po = cs.get('police.wav'); if (po) AU.police = await AU.ctx.decodeAudioData(msToWav(po)); } catch (e) { console.warn('police', e); } try { AU.start = []; for (const n of ['start0.wav', 'start1.wav']) { const b = cs.get(n); if (b) AU.start.push(await AU.ctx.decodeAudioData(b.slice(0))); } } catch (e) { } AU.bum = []; for (let i = 0; i < 5; i++) { const b = cs.get('bum' + i + '.wav'); if (b) AU.bum.push(await AU.ctx.decodeAudioData(b.slice(0))); } } catch (e) { console.warn('horn', e); }
    // music: MP3/*.mp3 (listing from folder picker, or track_NN.mp3 probing)
    AU.songs = [];
    for (let i = 1; i < 30; i++) { const n = 'MP3/track_' + String(i).padStart(2, '0') + '.mp3'; if (await vfs.exists(n)) AU.songs.push(n); else if (i > 12) break; }
    if (vfs.files) for (const k of vfs.files.keys()) if (/^mp3\/.*\.mp3$/.test(k) && !AU.songs.some(s => s.toLowerCase() === k)) AU.songs.push(k);
    if (AU.songs.length) nextSong(true);
  }
  // playlist entries are paths in the game folder, or {name, url} for MP3 files the player dropped onto the page
  async function nextSong(first, step) {
    if (!AU.songs.length || !AU.ctx) return;
    if (AU.music) { AU.music.pause(); if (AU.music.dataset.own !== '1') URL.revokeObjectURL(AU.music.src); }
    const n = AU.songs.length; AU.songIdx = (((step === -1 ? AU.songIdx - 2 : AU.songIdx) % n) + n) % n;
    const e = AU.songs[AU.songIdx++ % n]; let url;
    if (typeof e === 'string') url = URL.createObjectURL(new Blob([await vfs.bytes(e)], { type: 'audio/mpeg' })); else url = e.url;
    const a = new Audio(url); if (typeof e !== 'string') a.dataset.own = '1';
    a.volume = AU.musicVol === undefined ? 0.35 : AU.musicVol; a.onended = () => nextSong(); AU.music = a; if (!AU.mutedByUser) a.play().catch(() => { });
    $('song').textContent = '♪ ' + (typeof e === 'string' ? e : e.name).split('/').pop();
  }
  // drop MP3 files onto the page to add them to the playlist (the original reads any MP3 in its \MP3\ folder)
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', e => {
    e.preventDefault(); const fs = [...(e.dataTransfer && e.dataTransfer.files || [])].filter(f => /\.(mp3|ogg|wav|m4a)$/i.test(f.name)); if (!fs.length) return;
    for (const f of fs) AU.songs.push({ name: f.name, url: URL.createObjectURL(f) });
    AU.songIdx = AU.songs.length - fs.length; nextSong(); toast && toast(fs.length + ' song(s) added');
  });
  function musicVolume(d) { AU.musicVol = Math.max(0, Math.min(1, (AU.musicVol === undefined ? 0.35 : AU.musicVol) + d)); if (AU.music) AU.music.volume = AU.musicVol; $('song').textContent = '♪ volume ' + Math.round(AU.musicVol * 100) + '%'; }
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
    if (!AU.skidG) { const src = AU.ctx.createBufferSource(); src.buffer = AU.skidBuf; src.loop = true; AU.skidG = AU.ctx.createGain(); AU.skidG.gain.value = 0; src.connect(AU.skidG).connect(AU.ctx.destination); src.start(); }
    AU.skidG.gain.value += (Math.min(0.6, level) - AU.skidG.gain.value) * 0.3;
  }
  // collision thud (bum0..4.wav from Cars/carstd.snd): the harder the impact (speed lost in one frame), the heavier the sample
  function crashSound(drop) {
    if (!AU.ctx || !AU.bum || !AU.bum.length || drop < 2.5 || AU.ctx.currentTime < (AU.bumT || 0)) return;
    AU.bumT = AU.ctx.currentTime + 0.25;
    const s = AU.ctx.createBufferSource(), g = AU.ctx.createGain(); s.buffer = AU.bum[Math.min(AU.bum.length - 1, Math.floor(drop / 4))]; g.gain.value = Math.min(1, 0.35 + drop * 0.05);
    s.connect(g).connect(AU.ctx.destination); s.start();
  }
  function horn(on) {   // horn0..2.wav from Cars/carstd.snd, looped only while H is held
    if (!AU.ctx) return;
    if (on && !AU.hornO && AU.horn) { const s = AU.ctx.createBufferSource(); s.buffer = AU.horn; s.loop = true; const g = AU.ctx.createGain(); g.gain.value = 0.7; s.connect(g).connect(AU.ctx.destination); s.start(); AU.hornO = s; }
    if (!on && AU.hornO) { try { AU.hornO.stop(); } catch (e) { } AU.hornO = null; }
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

  let G = null; const Q0 = new URLSearchParams(location.search);
  async function start() {
    const UI = state.ui; if (!UI) $('loading').style.display = 'flex';
    let steps = 0; const msg = t => { if (UI) UI.setMode('loading', Math.min(0.95, 0.09 * (++steps))); else $('lmsg').textContent = t; return new Promise(r => setTimeout(r, 0)); };
    let net = null, welcome = null;
    if (state.net) {   // multiplayer: join/create the session first (room settings decide track, laps and game type)
      const d = state.net.d, create = state.net.action === 'create';
      net = new YDNet({ team: new URLSearchParams(location.search).get('team') || undefined, name: d.name || 'Player', session: create ? undefined : d.session, password: d.password || '', car: state.selected, col: state.color, plate: state.plate || (UI && UI.settings ? { type: UI.settings.plateType, text: UI.settings.plateText } : null), create: create ? { session: d.session, maxPlayers: +d.maxPlayers + 2, gameType: d.gameType, laps: d.laps, password: d.password } : undefined }, {});
      await msg('Connecting…'); welcome = await net.ready;
      state.opts.track = welcome.room.track; state.opts.laps = welcome.room.laps; state.mode = welcome.room.gameType === 1 ? 'gonka' : 'walker'; state.gm = welcome.room.gameType === 2 ? { team: welcome.team } : null;
    }
    await msg('Starting renderer…');
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(innerWidth, innerHeight);
    $('stage').innerHTML = ''; $('stage').appendChild(renderer.domElement);
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
    const player = { phys, car, isPlayer: true, name: 'You' };
    if (shadowOn) player.shadow = YDSim.makeShadow(car, scene);
    phys.pos.copy(world.spawn.pos); phys.yaw = world.spawn.yaw; phys.gy = world.spawn.gy;
    const opts = state.opts, modeRace = state.mode === 'gonka' && world.cit;
    let race = null, route = null; const ais = [];
    const putOn = (e, slot) => { e.phys.pos.copy(slot.pos); e.phys.yaw = slot.yaw; e.phys.gy = slot.pos.y - 0.3; };
    if (modeRace) {
      await msg('Loading track…');
      const trc = YDSim.parseTrc(await vfs.bytes('Tracks/track' + opts.track + '.trc'));
      route = YDSim.buildRoute(world, trc.segs);
      const n = Math.min(7, opts.opponents);
      putOn(player, trc.grid[net ? (net.id - 1) % 8 : n]);
      const folders = CAR_FOLDERS.filter(f => state.carNames[f]);
      for (let i = 0; i < n; i++) {
        await msg('Loading opponent ' + (i + 1) + '…');
        const f = opts.sameCar ? state.selected : folders[(Math.random() * folders.length) | 0];
        const c = await YDCar.loadCar(vfs, f, (Math.random() * state.carcol.length) | 0, state.carcol);
        scene.add(c.obj); if (UI) applyPlate(c, UI, (Math.random() * 10) | 0, randPlate()); if (R && envCube) R.applyEnvironment(c.obj, envCube, R.C.REFLECT_MAX * 0.6);
        const e = { phys: YDCar.makePhysics(c, world), car: c, name: 'Racer ' + (i + 1) + ' (' + c.par.name + ')', ai: new YDSim.AIDriver(route, [[0.45, 0.6], [0.65, 0.8], [0.85, 1.0]][Math.min(2, opts.hardness || 0)].reduce((lo, hi) => lo + Math.random() * (hi - lo))) };
        e.phys.ignoreObjects = true; putOn(e, trc.grid[i]); ais.push(e);
      }
      race = new YDSim.Race(world, route, opts.laps, [player, ...ais], player);
    }
    const remotes = [];
    if (net) {
      if (!modeRace) { phys.pos.x += ((net.id - 1) % 8) * 4; }
      const addRemote = async peer => {
        const c = await YDCar.loadCar(vfs, state.carNames[peer.car] ? peer.car : 'bmw', peer.col, state.carcol);
        scene.add(c.obj); if (UI) applyPlate(c, UI, peer.plate ? peer.plate.type : (Math.random() * 10) | 0, peer.plate && peer.plate.text ? peer.plate.text : randPlate());   // every car carries a plate if (R && envCube) R.applyEnvironment(c.obj, envCube, R.C.REFLECT_MAX * 0.6);
        const e = { team: peer.team, id: 'n' + peer.id, name: peer.name, car: c, phys: { pos: new THREE.Vector3(), yaw: 0, speed: 0, steer: 0, pitch: 0, roll: 0, gy: 0, gear: 1, wheels: [], kin: true, mass: 1300, vel: new THREE.Vector3() }, remote: true };
        if (shadowOn) e.shadow = YDSim.makeShadow(c, scene);
        net.remote.set(peer.id, e); remotes.push(e);
        if (race) { Object.assign(e, { lap: -9, idx: -1, progress: 0, done: false, time: null }); race.entries.push(e); }
      };
      if (state.gm) { player.team = state.gm.team; }
      net.hooks.onJoin = addRemote;
      net.hooks.onSiren = m => setSiren('n' + m.id, m.on);
      net.hooks.onGo = () => { if (G && G.lobby) leaveLobby(); };
      net.hooks.onHost = () => { if (G && G.lobby && G.lobbyChosen) state.ui.lobbyCanGo = true; };
      net.hooks.onCar = async m => {   // another player pressed CHOICE CAR: swap the model of its car
        const e = net.remote.get(m.id); if (!e) return;
        const c = await YDCar.loadCar(vfs, state.carNames[m.car] ? m.car : 'bmw', m.col, state.carcol);
        scene.remove(e.car.obj); if (e.shadow) scene.remove(e.shadow.group);
        scene.add(c.obj); if (UI && m.plate) applyPlate(c, UI, m.plate.type, m.plate.text || randPlate()); if (R && envCube) R.applyEnvironment(c.obj, envCube, R.C.REFLECT_MAX * 0.6);
        e.car = c; if (shadowOn) e.shadow = YDSim.makeShadow(c, scene);
      };
      net.hooks.onChat = m => chatLine(m.name + ': ' + m.text);
      setupChat(net);
      net.hooks.onLeave = id => { const e = net.remote.get(id); if (!e) return; scene.remove(e.car.obj); if (e.shadow) scene.remove(e.shadow.group); net.remote.delete(id); remotes.splice(remotes.indexOf(e), 1); if (race) race.entries.splice(race.entries.indexOf(e), 1); };
      for (const pe of welcome.peers) await addRemote(pe);
    }
    let traffic = null;
    if (opts.traffic && world.pathLines) {
      await msg('Loading traffic…');
      const tpl = [];
      for (const f of ['Vaz 2108', 'niva', 'Peugeot', '2110', 'Honda', 'Nissan', 'gazel']) {
        if (!state.carNames[f]) continue;
        const c = await YDCar.loadCar(vfs, f, 10 + (tpl.length % (state.carcol.length - 10)), state.carcol); if (UI) applyPlate(c, UI, (Math.random() * 10) | 0, randPlate()); const pathTo = (root, node) => { const p = []; for (let n = node; n && n !== root; n = n.parent) p.unshift(n.parent.children.indexOf(n)); return p; };
        tpl.push({ obj: c.obj, radius: c.radius, wheelBase: (c.parOrig ? c.parOrig.frontAxle + c.parOrig.rearAxle : 2.6), wheels: c.wheels.map(w => ({ front: w.front, pivot: pathTo(c.obj, w.pivot), spin: pathTo(c.obj, w.spin) })) });
      }
      if (tpl.length) traffic = new YDSim.Traffic(world, scene, tpl, opts.trafficCount || 14);
      if (traffic && net) { traffic.setRemote(!net.isHost); net.hooks.onTraffic = m => { if (traffic.remoteMode) traffic.applyRemote(m.c); }; const oh = net.hooks.onHost; net.hooks.onHost = () => { traffic.setRemote(false); if (oh) oh(); }; }   // network: only the host simulates the traffic, the others show it
    }
    await msg('Loading sound…'); await initAudio(state.selected);
    const amb = world.emitters && AU.ctx ? new YDSim.Ambience(AU.ctx, world, vfs) : null; if (amb) amb.init().catch(e => console.warn('ambience', e));
    bindTouch(); bindPause();
    let tyreFx = null;
    try { const cts = await YD.TexSet.load(vfs, 'Graph/citstdmat.tex'); tyreFx = new YDSim.TyreFx(scene, await cts.get('tsmoke.tga'), await cts.get('sled.dds')); } catch (e) { console.warn('tyrefx', e); }
    const mini = new YDSim.Minimap($('minimap')); $('minimap').style.display = world.pathLines ? 'block' : 'none';
    G = { renderer, scene, camera, world, car, phys, player, R, envCube, rig, skyObj, sunObj, dynEnv, chase: R ? new R.ChaseCamera() : null, ais, race, route, traffic, amb, mini, tyreFx, net, remotes, gm: state.gm && net ? { t: 0, over: null, msgs: [], meters: new Map() } : null, view: 0, t: 0, last: performance.now(), look: false, hud: { speed: $('speed'), gear: $('gear'), rpm: $('rpmfill') } };
    G.reset = () => {
      const phys = G.phys;
      if (route) { const i = YDSim.nearest(route, phys.pos.x, phys.pos.z, -1, 0); phys.pos.set(route.xs[i], route.ys[i], route.zs[i]); phys.yaw = YDSim.heading(route, i); phys.gy = route.ys[i]; }
      else if (world.pathLines && world.pathLines.length) {   // free drive: back onto the nearest street, facing along it (not the start)
        let best = 1e18, bp = null;
        for (const q of world.pathLines) { const p = q.pts, n = p.length / 3; for (let i = 0; i < n - 1; i++) { const dx = p[i * 3] - phys.pos.x, dz = p[i * 3 + 2] - phys.pos.z, d = dx * dx + dz * dz; if (d < best) { best = d; bp = [p, i]; } } }
        if (bp) { const [p, i] = bp, a = i * 3, b = a + 3; phys.pos.set(p[a], p[a + 1], p[a + 2]); phys.yaw = Math.atan2(p[b] - p[a], p[b + 2] - p[a + 2]); phys.gy = p[a + 1]; }
      } else { phys.pos.copy(world.spawn.pos); phys.yaw = world.spawn.yaw; phys.gy = world.spawn.gy; }
      phys.vel.set(0, 0, 0); phys.yawRate = 0; phys.gear = 1; phys.speed = 0; G.justReset = true;
    };
    state.G = G; window.G = G;
    const atq = new URLSearchParams(location.search).get('at'); // debug: teleport 'x,z,yaw'
    if (atq) { const [ax, az, ay] = atq.split(',').map(Number); phys.pos.set(ax, 0, az); phys.yaw = ay || 0; phys.gy = (world.ground(ax, az, 50) ?? 0); }
    const warp = +(new URLSearchParams(location.search).get('warp') || 0);
    if (warp) { // test aid: fast-forward the simulation (no rendering) with the demo inputs
      for (let t = 0; t < warp; t += 0.02) stepWorld(0.02, readInput());
    }
    if (new URLSearchParams(location.search).has('dbg') && race) console.log('RACE ' + JSON.stringify({ t: race.t.toFixed(1), len: race.route.len.toFixed(0), st: race.standings().map(e => [e.name.slice(0, 10), e.lap, Math.round(e.progress), Math.round(Math.abs(e.phys.speed * 3.6)), e.done, e.phys.pos.x.toFixed(1), e.phys.pos.z.toFixed(1), (e.phys.yaw).toFixed(2), (e.phys.hitTimer || 0).toFixed(2), e.ai ? e.ai.idx : -1]) }));
    if (race) $('race').style.display = 'block';
    $('loading').style.display = 'none'; $('hud').style.display = 'block';
    if (UI) { UI.stop(); $('uicanvas').style.display = 'none'; }
    if (net && UI) enterLobby();   // network games: the world is loaded, now the car choice screen (GMCar) opens over the live city
    setTimeout(() => { if (AU.ctx && AU.start && AU.start.length) { const b = AU.ctx.createBufferSource(), g = AU.ctx.createGain(); b.buffer = AU.start[Math.floor(Math.random() * AU.start.length)]; g.gain.value = 0.6; b.connect(g).connect(AU.ctx.destination); b.start(); } }, 300);   // engine start (start0/1.wav)
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
      if (p) { cv.style.display = 'block'; cv.style.background = 'transparent'; UI.openOverlay(0x31); cv.focus(); }
      else { UI.closeOverlay(); cv.style.display = 'none'; }
    } else { $('pause').style.display = p ? 'flex' : 'none'; $('pMusic').textContent = 'Music: ' + (AU.mutedByUser ? 'off' : 'on'); }
    if (AU.music) { if (p) AU.music.pause(); else if (!AU.mutedByUser) AU.music.play().catch(() => { }); }
  }
  // ---- network lobby (original FUN_0042a6c0: for network game types the world loads first, then screen GMCar 0x38 opens over the live city) ----
  function enterLobby() {
    const UI = state.ui, cv = $('uicanvas'); G.lobby = true; G.lobbyChosen = false; UI.lobbyCanGo = false;
    $('hud').style.display = 'none'; $('minimap').style.display = 'none'; if ($('race')) $('race').style.display = 'none';
    cv.style.display = 'block'; cv.style.background = 'transparent'; UI.openOverlay(0x38); cv.focus();
    if (Q0.has('autogo')) setTimeout(async () => { await swapPlayerCar(); if (G.net.isHost) G.net.sendStart(); }, +Q0.get('autogo') > 100 ? +Q0.get('autogo') : 2500);   // test aid (autogo=ms delay)
  }
  // host: start the game for everybody; other players: wait for the host (the button used to do nothing)
  function mpGoNow() { const n = G.net; if (!n) return; if (n.goAt) { leaveLobby(); return; } if (n.isHost) n.sendStart(); else toast('Waiting for the host to start the game…'); }
  function leaveLobby() {
    const UI = state.ui, cv = $('uicanvas'); G.lobby = false; UI.lobbyCanGo = false; UI.closeOverlay(); cv.style.display = 'none';
    $('hud').style.display = 'block'; if (G.world.pathLines) $('minimap').style.display = 'block'; if (G.race) $('race').style.display = 'block';
  }
  function lobbyFrame(dt) {
    const { player, world, camera, renderer, scene, net, remotes } = G, phys = G.phys;
    net.updateRemote(dt); YDSim.placeCar(player, dt, world); for (const r of remotes) YDSim.placeCar(r, dt, world);
    net.sendState(dt, phys);
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
    return location.pathname + '?' + new URLSearchParams({ auto: 1, mode: state.mode, track: o.track || 0, laps: o.laps || 2, opps: o.opponents === undefined ? 7 : o.opponents, traffic: o.traffic ? 1 : 0, car: state.selected, col: state.color });
  }
  function gameCommand(c) { // from the original in-game menu / report screen
    if (c === 'resume') setPaused(false);
    else if (c === 'restart') location.href = restartUrl();
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
    $('pCam').onclick = () => { G.view = (G.view + 1) % 3; G.camReady = G.camReady2 = false; };
    $('pMusic').onclick = () => { AU.mutedByUser = !AU.mutedByUser; $('pMusic').textContent = 'Music: ' + (AU.mutedByUser ? 'off' : 'on'); };
    $('pReset').onclick = () => { G.reset(); setPaused(false); };
    $('pMenu').onclick = () => { location.href = location.pathname; };
  }
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
  const IDLE = { throttle: 0, brake: 0, steer: 0, handbrake: false, shiftUp: false, shiftDown: false };
  // advance the whole simulation by dt (player, AI, traffic, collisions, race logic)
  function stepWorld(dt, inpRaw) {
    if (!(dt > 1e-5)) return; // a zero-length step would divide by zero in the original physics model
    const { phys, world, ais, race, traffic, player } = G;
    const netWait = G.net && G.net.countdown() > 0;   // multiplayer: everybody waits for the shared start time
    if (netWait && race && race.state === 'countdown') race.t = -G.net.countdown();
    const counting = (race && race.state === 'countdown') || netWait;
    const inp = (counting || (G.gm && player.busted)) ? IDLE : inpRaw;
    for (const a of ais) { a.input = counting ? IDLE : a.ai.drive(a, dt); if (a.needRespawn) a.ai.respawn(a); }
    const steps = Math.max(1, Math.ceil(dt / 0.008)), h = dt / steps;
    for (let i = 0; i < steps; i++) {
      phys.step(h, i === 0 ? inp : (inp.shiftUp || inp.shiftDown ? Object.assign({}, inp, { shiftUp: false, shiftDown: false }) : inp));   // key presses are edges: one shift per frame, not per sub-step
      if (world.collide) world.collide(phys, h);
      for (const a of ais) { a.phys.step(h, a.input); if (world.collide) world.collide(a.phys, h); }
      const bodies = [phys]; for (const a of ais) bodies.push(a.phys); if (traffic) for (const c of traffic.cars) bodies.push(c); if (G && G.remotes) for (const r of G.remotes) bodies.push(r.phys);
      if (bodies.length > 1) YDSim.collideBodies(bodies, h);
    }
    const bad = p => !isFinite(p.pos.x + p.pos.z + p.speed + p.rpm);
    if (bad(phys)) G.reset();
    for (const a of ais) if (bad(a.phys)) { a.needRespawn = true; a.ai.respawn(a); }
    if (traffic) {
      traffic.others = [phys, ...ais.map(a => a.phys), ...(G.remotes || []).map(r => r.phys)]; traffic.players = [phys.pos, ...(G.remotes || []).map(r => r.phys.pos)];
      traffic.update(dt, phys.pos);
      if (G.net && G.net.isHost && (G.trT = (G.trT || 0) + dt) > 0.1) { G.trT = 0; G.net.sendTraffic(traffic.snapshot()); }
    }
    if (race) race.update(dt);
    G.t += dt;
  }
  const fmt = t => { t = Math.max(0, t); const m = Math.floor(t / 60); return m + ':' + (t - m * 60).toFixed(1).padStart(4, '0'); };
  function showResults() {
    const r = G.race, st = r.standings(), UI = state.ui;
    if (UI) { // original report screen (GReport, id 0x35) + my standings text (the original's line layout is not decoded yet)
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
    const raw = (now - G.last) / 1000, dt = Math.max(0, Math.min(0.05, raw)); G.last = now;
    // quality governor: if the average frame takes > 26 ms over ~1.5 s, drop the costliest extras one step at a time (1: rival live reflections, 2: player live reflection, 3: shadows)
    if (raw > 0 && raw < 0.5 && !G.paused && !Q0.has('fixedq')) { G.fpsAcc = (G.fpsAcc || 0) + raw; if ((G.fpsN = (G.fpsN || 0) + 1) >= 90) { const avg = G.fpsAcc / G.fpsN; G.fpsAcc = G.fpsN = 0; if (avg > 0.026 && (G.qLevel || 0) < 3) { G.qLevel = (G.qLevel || 0) + 1; console.warn('quality level', G.qLevel, 'avg frame ms', (avg * 1000).toFixed(1)); if (G.qLevel === 2 && G.dynEnv && G.R) { G.dynEnv = null; G.R.setReflectivity(G.car.obj, G.R.C.REFLECT_MAX, G.envCube); } } } } // never negative: the first RAF timestamp can predate G.last
    const { phys, car, camera, world, renderer, scene, player, ais, race, traffic } = G;
    if (G.lobby) { lobbyFrame(dt); return; }
    if (pressed.has('Escape') && !G.report && !$('results').style.display.includes('flex')) setPaused(!G.paused);
    if (G.paused) {
      if (state.ui && state.ui.overlay) {
        state.ui.overlayFrame(dt);
        if (G.report) { // standings over the report panel
          const UI = state.ui, R = UI.r, rows = G.report.slice(0, 8);
          UI.drawText('big', ((state.ui.S('STRINGS', 'YourPosition', 'Your position')) + ' ' + G.race.place(G.player) + '/' + G.race.entries.length), 0, -0.55, 0.07, 0xffffffff, 9);
          rows.forEach((e, i) => UI.drawText('small', (i + 1) + '. ' + e.name.replace(/[^\x20-\x7e]/g, '') + '   ' + (e.done ? fmt(e.time) : '--'), 0, -0.42 + i * 0.075, 0.05, e.isPlayer ? 0xfff2b705 : 0xffffffff, 9));
        }
      }
      pressed.clear(); if (AU.engGain) AU.engGain.gain.value = 0; horn(false); skidSound(0); if (G.amb) G.amb.stop(); renderer.render(scene, camera); return; }
    const inp = readInput();
    if (pressed.has('KeyC')) { G.view = (G.view + 1) % 3; G.camReady = G.camReady2 = false; }
    if (pressed.has('F3')) G.pressedF3 = true;
    if (pressed.has('KeyN')) nextSong();
    if (pressed.has('KeyP')) nextSong(false, -1);
    if (pressed.has('BracketRight')) musicVolume(0.1);
    if (pressed.has('BracketLeft')) musicVolume(-0.1);
    // original controls (readme): + / - zoom the map, M = siren (only in the Gogh & Milica network game; police team)
    if (G.mini && (pressed.has('Equal') || pressed.has('NumpadAdd'))) G.mini.R = Math.max(60, G.mini.R * 0.8);
    if (G.mini && (pressed.has('Minus') || pressed.has('NumpadSubtract'))) G.mini.R = Math.min(900, G.mini.R * 1.25);
    if (pressed.has('KeyM') && G.gm && G.player.team === 'm') toggleSiren();
    if (pressed.has('KeyU')) { AU.mutedByUser = !AU.mutedByUser; if (AU.music) { AU.mutedByUser ? AU.music.pause() : AU.music.play().catch(() => { }); } }
    if (pressed.has('KeyR')) G.reset();
    horn(keys.has('KeyH')); G.look = keys.has('KeyB');
    pressed.clear();
    stepWorld(dt, inp);
    // place every car on the ground
    YDSim.placeCar(player, dt, world); for (const a of ais) YDSim.placeCar(a, dt, world);
    if (G.gm) stepGM(dt);
    if (G.net) { G.net.sendState(dt, phys); G.net.updateRemote(dt); for (const r of G.remotes) YDSim.placeCar(r, dt, world); updateSirens(); if (G.gm && G.gm.over && sirens.size) stopSirens(); }
    { // planar shadows (original: car mesh projected along the sun direction, alpha 0.3)
      const L = G.rig ? G.rig.sunDir : new THREE.Vector3(-0.1, -0.43, 0.9).normalize();
      for (const e of [player, ...ais, ...(G.remotes || [])]) if (e.shadow) YDSim.updateShadow(e.shadow, e.car.obj, L, e.gy, (e === player || e.car.obj.position.distanceTo(camera.position) < 150) && !(G.qLevel >= 3));
    }
    const gy = player.gy;
    if (G.tyreFx) { player.id = 'p'; ais.forEach((x, i) => x.id = 'a' + i); G.tyreFx.update(dt, [player, ...ais], camera.position); }
    YDSim.updateLamps(car, (inp.brake > 0.1 && phys.gear >= 0) || inp.handbrake, phys.gear < 0);
    for (const a of ais) YDSim.updateLamps(a.car, (a.input && a.input.brake > 0.1 && a.phys.gear >= 0), a.phys.gear < 0);
    // camera (original chase camera FUN_00417ad0/FUN_00417630 when render-orig.js is loaded)
    const fwd = new THREE.Vector3(Math.sin(phys.yaw), 0, Math.cos(phys.yaw));
    const sgn = G.look ? -1 : 1;
    if (G.chase) {
      const q = car.obj.quaternion, cf = new THREE.Vector3(0, 0, 1).applyQuaternion(q), cu = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const ch = G.chase; ch.mode = G.view; ch.lookBehind = G.look;
      if (G.look && G.view < 2) cf.negate();
      ch.update({ pos: car.obj.position, vel: phys.vel, up: cu, fwd: cf, par: { camBytes: car.camBytes } }, dt, camera, {
        collideEye: (eye, rad, tgt) => {
          if (phys.tunnel && world.rayCast && G.view < 2) {   // tight space (metro): sit behind the car along its own axes, pulled in by the walls/ceiling, never lifted above the street
            const L = 5.5, want = car.obj.position.clone().addScaledVector(cf, -L).addScaledVector(cu, 1.5), d = want.clone().sub(tgt), len = d.length() || 1;
            const h = world.rayCast(tgt.x, tgt.y, tgt.z, d.x / len, d.y / len, d.z / len, len + 0.4), t = h ? Math.max(1.6, h.t - 0.4) : len;
            eye.copy(tgt).addScaledVector(d, t / len); return;
          }
          const g = world.ground ? world.ground(eye.x, eye.z, eye.y + 2) : null; if (g !== null && eye.y < g + 0.6) eye.y = g + 0.6; },
      });
      car.obj.visible = G.view < 2;
    } else if (G.view === 0) { // chase (fallback)
      const back = 8 + Math.min(4, Math.abs(phys.speed) * 0.06);
      const want = phys.pos.clone().addScaledVector(fwd, -back * sgn); want.y = gy + 3.0;
      if (!G.camReady) { camPos.copy(want); G.camReady = true; } else camPos.lerp(want, Math.min(1, dt * 6));
      camera.position.copy(camPos); camLook.copy(phys.pos).addScaledVector(fwd, 6 * sgn); camLook.y = gy + 1.2; camera.lookAt(camLook);
      car.obj.visible = true;
    } else if (G.view === 1) {
      const want = phys.pos.clone().addScaledVector(fwd, -16 * sgn); want.y = gy + 7;
      if (!G.camReady2) { camPos.copy(want); G.camReady2 = true; } else camPos.lerp(want, Math.min(1, dt * 4)); camera.position.copy(camPos); camera.lookAt(phys.pos.x, gy + 1, phys.pos.z); car.obj.visible = true;
    } else {
      const p = phys.pos.clone().addScaledVector(fwd, 0.4 * sgn); p.y = gy + 1.25;
      camera.position.copy(p); camera.lookAt(p.x + fwd.x * 10 * sgn, p.y - 0.05, p.z + fwd.z * 10 * sgn); car.obj.visible = false;
    }
    if (Q0.has('tilt') && ((G.tf = (G.tf || 0) + 1) === 3 || G.tf % 90 === 0)) { const q = car.obj.quaternion, u = new THREE.Vector3(0, 1, 0).applyQuaternion(q), f = new THREE.Vector3(0, 0, 1).applyQuaternion(q); console.log('TILT ' + JSON.stringify({ f: G.tf, pos: car.obj.position.toArray().map(v => +v.toFixed(2)), up: u.toArray().map(v => +v.toFixed(2)), fwd: f.toArray().map(v => +v.toFixed(2)), cam: camera.position.toArray().map(v => +v.toFixed(2)), mode: G.chase && G.chase.mode, view: G.view, eye: G.chase && G.chase.eye.toArray().map(v => +v.toFixed(2)), tgt: G.chase && G.chase.target.toArray().map(v => +v.toFixed(2)), look: G.look,  camUp: camera.up.toArray().map(v => +v.toFixed(2)), pitch: +phys.pitch.toFixed(3), roll: +phys.roll.toFixed(3), py: +phys.pos.y.toFixed(2), gy: +(phys.gy || 0).toFixed(2), kmh: +(phys.speed * 3.6).toFixed(0) })); }
    if (G.R) { // original lighting, sky, sun and live reflection cube
      G.R.updateLighting(G.rig, camera, dt, null);
      if (G.skyObj) G.skyObj.update(); if (G.sunObj) G.sunObj.update(camera);
      { const under = !!phys.tunnel && phys.pos.y < -2.5; if (G.skyObj) G.skyObj.object.visible = !under; if (G.sunObj && G.sunObj.object) G.sunObj.object.visible = !under; scene.background.setHex(under ? 0x050505 : 0x9ec3e6); }   // underground: dark, not sky blue, where the tunnel is not drawn
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
    if (world.updateMovers) world.updateMovers(dt, [phys, ...ais.map(a => a.phys), ...(G.remotes || []).map(r => r.phys)]);   // movable objects (metro doors, bins ...)
    if (world.update) world.update(dt, phys, camera);
    if (G.amb) G.amb.update(dt, phys.pos);
    // audio
    if (AU.engine) {
      const r = phys.rpm / car.par.maxRpm;
      AU.engine.playbackRate.value = 0.6 + r * 1.9;
      AU.engGain.gain.value = 0.18 + 0.3 * (inp.throttle) * (0.5 + r * 0.5);
      { const sp0 = Math.abs(phys.speed); crashSound(G.prevSp !== undefined && !G.justReset ? G.prevSp - sp0 : 0); G.prevSp = sp0; G.justReset = false; }
      { const sl = Math.max(phys.slip || 0, inp.handbrake ? 0.8 : 0, inp.brake > 0.5 ? 0.35 : 0), mv = Math.abs(phys.speed) > 4 ? 1 : 0; skidSound(sl > 0.3 ? (sl - 0.2) * mv * 0.8 : 0); }
    }
    // HUD
    const origHud = drawOrigHud(phys, car, race, player); $('dash').style.display = origHud && state.ui.settings.showTakh ? 'none' : '';
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
      if (player.done && !G.resShown && race.t - race.finishedAt > 2.5) { G.resShown = true; showResults(); }
    }
    if (G.mini) { const mk = innerHeight / 768, mc = $('minimap'); mc.style.width = 205 * mk + 'px'; mc.style.height = 205 * mk + 'px'; if (!state.ui || state.ui.settings.showMap) G.mini.draw(world, phys, race, ais, traffic); else mc.style.display = 'none'; }
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
      'GPU ' + (G.gpu || '?') + (sw ? '   << SOFTWARE RENDERING: slow, check browser hardware acceleration' : '') + '\n' + (G.phys.tunnel ? 'underground (tube mode)' : '');
  }
  // original HUD gauges (ui-orig.js drawGauges = FUN_00425af0) drawn on a 1024x768 canvas, blitted bottom-right with uniform scale
  // ---- Gogh & Milica (game type 4; FUN_00428xxx): cops (flag +0x6c) vs robbers; a robber's meter (+0x70, starts 1.0) drains at 0.1/s while a live cop is
  // within 7 m and the relative speed is < 10 m/s, otherwise recovers at 0.01/s; at 0 the robber is busted. All robbers busted -> police win; the 300 s timer
  // (game+0xfbc = 300.0) running out -> the robbers win. HUD: panel + "Elapsed time m:ss" (FUN_00427790).
  function stepGM(dt) {
    const gm = G.gm; if (gm.over) { gm.over.t += dt; if (gm.over.t > 8 && !gm.left) { gm.left = true; gameCommand('menu'); } return; }
    if (G.net && G.net.countdown() > 0) return;   // chase starts at the shared start time
    gm.t += dt;
    const all = [G.player, ...G.remotes], cops = all.filter(e => e.team === 'm'), rob = all.filter(e => e.team === 'g');
    for (const e of gm.msgs) e.age += dt; gm.msgs = gm.msgs.filter(e => e.age < 4);
    const vel = e => e.phys.vel || { x: 0, y: 0, z: 0 };
    for (const r of rob) {
      if (r.busted) continue; let m = gm.meters.has(r) ? gm.meters.get(r) : 1;
      for (const c of cops) {
        if (c.busted) continue;
        const d = Math.hypot(c.phys.pos.x - r.phys.pos.x, c.phys.pos.z - r.phys.pos.z), vr = Math.hypot(vel(c).x - vel(r).x, vel(c).z - vel(r).z);
        if (d >= 7 || vr >= 10) m = Math.min(1, m + dt * 0.01); else m -= dt * 0.1;
      }
      gm.meters.set(r, m);
      if (m <= 0) { r.busted = true; gm.msgs.push({ text: (r === G.player ? (G.net && G.net.hello.name) : r.name) + ' ' + state.ui.S('STRINGS', 'Busted', 'BUSTED!').trim(), age: 0 }); }
    }
    if (rob.length && rob.every(r => r.busted)) gm.over = { cops: true, t: 0 };
    else if (gm.t >= 300 && rob.length) gm.over = { cops: false, t: 0 };
  }
  function drawGM(R, o, UI) {
    const gm = G.gm, sec = Math.floor(gm.t);
    const T = G.net ? G.net.countdown() : 0;   // same 3-2-1-Go countdown as the race (FUN_004285c0), on the shared multiplayer clock
    if (T > -0.8 && T < 4) { const idx = Math.max(0, Math.floor(T)), sz = 0.05 + (Math.max(0, T) - idx) * 0.12, str = idx === 0 ? UI.S('STRINGS', 'Go', 'Go') : String(idx); R.text(UI.fontBig, 0, 0, sz, sz, 0xffffffff, str, 0xb); }
    R.sprite(null, 0.35, -1.0, 0.65, 0.1, 0x9632325a);
    R.text(UI.fontBig, 0.38, -0.98, 0.07, 0.07, 0xffff7d7d >>> 0, UI.S('STRINGS', 'ElapsedTime', 'Elapsed time') + ' ' + Math.floor(sec / 60) + ':' + (sec % 60 < 10 ? '0' : '') + sec % 60, 8);
    gm.msgs.forEach((m, i) => R.text(UI.fontBig, 0, -0.6 + i * 0.08, 0.06, 0.06, 0xffff0000, m.text, 0xb));
    if (gm.over) R.text(UI.fontBig, 0, 0, 0.1, 0.1, 0xffffffff, UI.S('STRINGS', gm.over.cops ? 'MWin' : 'GWin', gm.over.cops ? 'MILICANER WINS!' : 'GOXER WINS!'), 0xb);
  }
  function drawOrigHud(phys, car, race, player) {
    const UI = state.ui; if (!UI || !UI.carmat) return false;
    const c = $('hudcanvas'); if (c.width !== innerWidth || c.height !== innerHeight) { c.width = innerWidth; c.height = innerHeight; }
    const g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height);
    const off = G.gaugeCanvas || (G.gaugeCanvas = Object.assign(document.createElement('canvas'), { width: 1024, height: 768 }));
    const o = off.getContext('2d'); o.clearRect(0, 0, 1024, 768);
    const k = innerHeight / 768;
    if (UI.settings.showTakh) {
      UI.drawGauges(o, { rpm: phys.rpm, maxRpm: car.par.maxRpm, speed: phys.speed, gear: ((race && race.state === 'countdown') || (G.net && G.net.countdown() > 0)) ? 0 : phys.gear });   // real game shows N while the cars are locked on the grid
      const vw = Math.trunc(1024 * 0.3), vh = Math.trunc(768 * 0.2);
      g.drawImage(off, 1024 - vw, 768 - vh, vw, vh, window.touchMode ? (innerWidth - vw * k) / 2 : innerWidth - vw * k, innerHeight - vh * k, vw * k, vh * k);   // touch devices: gauges move to the bottom centre (d-pad right, STOP left)
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
        g.drawImage(off, (innerWidth - 1024 * k) / 2, 0, 1024 * k, 768 * k);
      }
    }
    if (G.gm) {
      const R = G.hudR || (G.hudR = new YDUI._core.Renderer(o)); R.ctx = o; o.clearRect(0, 0, 1024, 768);
      drawGM(R, o, UI); g.drawImage(off, (innerWidth - 1024 * k) / 2, 0, 1024 * k, 768 * k);
    }
    return true;
  }
  const clampLap = (l, max) => Math.max(1, Math.min(max, l));

  window.addEventListener('DOMContentLoaded', () => { boot().catch(fail); });
})();
