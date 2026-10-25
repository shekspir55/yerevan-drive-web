// Yerevan Drive – original 2D UI layer (menus, widgets, HUD) ported from the decompiled game code.
// See spec-ui.md for the function addresses each part was derived from.
//
// Coordinates: the original UI works in "NDC" space, x and y both in -1..1 with +y DOWN, mapped to the
// 1024x768 back buffer:  px = (x+1)/2*1024,  py = (y+1)/2*768.   (FUN_004078f0, the sprite primitive)
// Text strings are raw bytes (ArmSCII-8 for the Armenian glyphs of the bitmap font "Arial Armenian").
(function (global) {
  'use strict';
  const W = 1024, H = 768;
  const DIK = { ESC: 1, ENTER: 0x1c, TAB: 0x0f, LEFT: 0xcb, RIGHT: 0xcd, UP: 200, DOWN: 0xd0, HOME: 199, END: 0xcf, DEL: 0xd3, BACK: 0x0e };
  const ARGB = (a, r, g, b) => (((a & 255) << 24) | ((r & 255) << 16) | ((g & 255) << 8) | (b & 255)) >>> 0;
  const frac = t => t - Math.trunc(t);

  // ------------------------------------------------------------------------------------------------
  // Resources: REF material sets (FUN_004046c0 loads the .ref, FUN_00403990 the matching .tex archive)
  // A material's single texture stage holds the base file name + a texture count (stage u32 @0x18);
  // frame i of a multi-texture material is "<base><i>.<ext>" (FUN_00403160).
  // ------------------------------------------------------------------------------------------------
  const canvasCache = new Map();
  async function decodeToCanvas(name, buf) {
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    let img;
    if (ext === 'dds') img = YD.decodeDDS(buf);
    else if (ext === 'tga') img = YD.decodeTGA(buf);
    else {
      const bmp = await createImageBitmap(new Blob([buf]));
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0); return c;
    }
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); const id = g.createImageData(img.width, img.height); id.data.set(img.data); g.putImageData(id, 0, 0);
    return c;
  }
  class MaterialSet {
    constructor() { this.m = new Map(); }
    static async load(vfs, refPath, texPaths) {
      const set = new MaterialSet();
      const archives = [];
      for (const tp of [].concat(texPaths)) archives.push(YD.readBFX(await vfs.bytes(tp)));
      const root = YD.parseRef(await vfs.bytes(refPath));
      const list = root.kids[0];
      for (const mat of list.kids) {
        if (mat.type !== YD.T.MATERIAL) continue;
        const f = new Float32Array(mat.data.slice(0, 100));
        const stage = mat.kids.find(k => k.type === YD.T.TEXSTAGE);
        const m = { name: mat.name, diffuse: [f[2], f[3], f[4], f[5]], frames: [], count: 0 };
        if (stage) {
          const u = new Uint8Array(stage.data); let nm = '';
          for (let i = 44; i < 60 && u[i]; i++) nm += String.fromCharCode(u[i]);
          const cnt = new DataView(stage.data).getUint32(0x18, true) || 1;
          m.count = cnt;
          if (nm) {
            for (let i = 0; i < cnt; i++) {
              let fn = nm;
              if (cnt > 1) { const d = nm.lastIndexOf('.'); fn = d < 0 ? nm + i : nm.slice(0, d) + i + nm.slice(d); }
              const key = fn.toLowerCase(); let buf = null;
              for (const a of archives) if (a.has(key)) { buf = a.get(key); break; }
              if (buf) { const ck = refPath + '|' + key; if (!canvasCache.has(ck)) canvasCache.set(ck, await decodeToCanvas(key, buf)); m.frames.push(canvasCache.get(ck)); } else m.frames.push(null);
            }
          }
        }
        set.m.set(mat.name.toLowerCase(), m);
      }
      return set;
    }
    get(name) { return this.m.get(name.toLowerCase()) || null; }
  }

  // ------------------------------------------------------------------------------------------------
  // Renderer: the sprite primitive (FUN_004078f0) and the bitmap-font primitive (FUN_004023a0)
  // ------------------------------------------------------------------------------------------------
  const tintCache = new WeakMap();
  function tinted(img, r, g, b) {
    if (r === 255 && g === 255 && b === 255) return img;
    let byImg = tintCache.get(img); if (!byImg) { byImg = new Map(); tintCache.set(img, byImg); }
    const k = (r << 16) | (g << 8) | b; let c = byImg.get(k);
    if (!c) {
      c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      x.globalCompositeOperation = 'multiply'; x.fillStyle = `rgb(${r},${g},${b})`; x.fillRect(0, 0, c.width, c.height);
      x.globalCompositeOperation = 'destination-in'; x.drawImage(img, 0, 0);
      byImg.set(k, c);
    }
    return c;
  }
  class Font {
    constructor(atlas, header, glyphs) { this.atlas = atlas; this.h = header; this.g = glyphs; this.pad = header[2]; this.texW = atlas.width; this.texH = atlas.height; this.cellH = (glyphs[3] - glyphs[1]) * atlas.height; }
    static async load(vfs, path) {
      const root = YD.parseRef(await vfs.bytes(path)); const node = root.kids[0];
      const dv = new DataView(node.data); const header = [dv.getInt32(0, true), dv.getInt32(4, true), dv.getInt32(8, true)];
      const glyphs = new Float32Array(node.data.slice(12, 12 + 224 * 16));
      const tex = node.kids.find(k => k.type === 0x21);
      const atlas = await decodeToCanvas('f.dds', tex.data);
      return new Font(atlas, header, glyphs);
    }
    // FUN_00402270: width of a string in atlas pixels at scale 1 (advance = glyph rect width - 2*pad)
    measure(bytes) {
      let w = 0, best = 0;
      for (let i = 0; i < bytes.length; i++) {
        const c = bytes.charCodeAt(i); if (c === 10) { best = Math.max(best, w); w = 0; continue; }
        if (c < 32) continue; const o = (c - 32) * 4; w += (this.g[o + 2] - this.g[o]) * this.texW - 2 * this.pad;
      }
      return Math.max(best, w);
    }
  }
  class Renderer {
    constructor(ctx) { this.ctx = ctx; this.time = 0; }
    // FUN_004078f0(tex, x, y, w, h, u0, v0, u1, v1, color): NDC rect -> back buffer pixels
    sprite(img, x, y, w, h, color, u0 = 0, v0 = 0, u1 = 1, v1 = 1) {
      const a = (color >>> 24) & 255; if (a === 0) return;
      const sh = (global.YDUI && global.YDUI.spriteShift) || [0.5, 0.5];   // D3D9 has no half-pixel correction for these quads
      const px = (x + 1) * W / 2 + sh[0], py = (y + 1) * H / 2 + sh[1], pw = w * W / 2, ph = h * H / 2, ctx = this.ctx;
      ctx.globalAlpha = a / 255; ctx.imageSmoothingEnabled = true;
      if (!img) { ctx.fillStyle = `rgb(${(color >> 16) & 255},${(color >> 8) & 255},${color & 255})`; ctx.fillRect(px, py, pw, ph); ctx.globalAlpha = 1; return; }
      const t = tinted(img, (color >> 16) & 255, (color >> 8) & 255, color & 255);
      ctx.drawImage(t, u0 * img.width, v0 * img.height, (u1 - u0) * img.width, (v1 - v0) * img.height, px, py, pw, ph);
      ctx.globalAlpha = 1;
    }
    // FUN_004023a0(font; x, y, z, a4, a5, color, text, flags)
    //   flags: 1 = centre on x, 0x10 = right-align (x is the right edge), 2 = centre on y (y is the middle of a line of
    //   height a5), 8 = bilinear filtering.   a4/a5 are glyph heights in NDC (so scale = H*a/2 / cellHeight).
    text(font, x, y, a4, a5, color, text, flags) {
      const ctx = this.ctx, g = font.g, sx = H * a4 / 2 / font.cellH, sy = H * a5 / 2 / font.cellH, pad = font.pad;
      let x0 = x;
      if (flags & 0x11) {
        let w = 0; for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c === 10) break; if (c >= 32) { const o = (c - 32) * 4; w += ((g[o + 2] - g[o]) * font.texW - 2 * pad) * sx; } }
        const wn = w / W; x0 = x - wn; if (flags & 0x10) x0 -= wn;
      }
      const yTop = (flags & 2) ? y - a5 * 0.5 : y;
      const penX0 = (x0 + 1) * W / 2 - pad * sx;
      let penX = penX0, penY = (yTop + 1) * H / 2;
      const a = (color >>> 24) & 255, atl = tinted(font.atlas, (color >> 16) & 255, (color >> 8) & 255, color & 255);
      ctx.globalAlpha = a / 255; ctx.imageSmoothingEnabled = !!(flags & 8);
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c === 10) { penX = penX0; penY += H * a5; continue; }
        if (c < 32) continue;
        const o = (c - 32) * 4, u0 = g[o], v0 = g[o + 1], u1 = g[o + 2], v1 = g[o + 3];
        const wq = (u1 - u0) * font.texW * sx, hq = (v1 - v0) * font.texH * sy;
        if (c !== 32) ctx.drawImage(atl, u0 * font.texW, v0 * font.texH, (u1 - u0) * font.texW, (v1 - v0) * font.texH, penX, penY, wq, hq);
        penX += wq - 2 * pad * sx;
      }
      ctx.globalAlpha = 1;
    }
  }

  // ------------------------------------------------------------------------------------------------
  // UI element tree (FUN_0042bf10 and friends). flags: 0x80000000 = disabled, 0x40000000 = visible/active.
  // ------------------------------------------------------------------------------------------------
  class Item {
    constructor(ui, id, flags, x, y, w, h, name) {
      this.ui = ui; this.id = id; this.flags = flags >>> 0; this.x = x; this.y = y; this.w = w; this.h = h; this.name = name || '';
      this.parent = null; this.kids = []; this.hover = false; this.snd = null;
    }
    get disabled() { return (this.flags & 0x80000000) !== 0; }
    get active() { return (this.flags & 0x40000000) !== 0; }
    setEnabled(on) { this.flags = on ? (this.flags & 0x7fffffff) >>> 0 : (this.flags | 0x80000000) >>> 0; }   // FUN_0042c020
    setVisible(on) { this.flags = on ? (this.flags | 0x40000000) >>> 0 : (this.flags & 0xbfffffff) >>> 0; }   // FUN_0042c050
    add(child) { child.parent = this; this.kids.push(child); return child; }                                  // FUN_00401650
    find(id) { if (this.id === id) return this; for (const k of this.kids) { const r = k.find(id); if (r) return r; } return null; }
    clearHover() { this.hover = false; for (const k of this.kids) k.clearHover(); }                           // FUN_0042c0f0
    // FUN_0042c140: first enabled+active child containing the point; marks it hovered
    hit(px, py, out) {
      for (const k of this.kids) {
        if (k.disabled || !k.active) continue;
        if (!(k.x < px && px <= k.x + k.w && k.y < py && py <= k.y + k.h)) continue;
        k.hover = true; if (out) out.top = k;
        return k.hit(px, py, null) || k;
      }
      return null;
    }
    render(xo, yo) { if (this.active) this.draw(xo, yo); for (const k of this.kids) k.render(xo, yo); }       // FUN_0042c080
    update(dt) { this.tick(dt); for (const k of this.kids) if (!k.disabled) k.update(dt); }                   // FUN_0042c0c0
    draw() { } tick() { }
    onEvent(type, p2, p3) { return this.parent ? this.parent.onEvent(type, p2, p3) : 0; }                     // FUN_0042c1d0 (bubble)
    play() { if (this.snd) this.ui.playSound(this.snd); }
  }
  class Screen extends Item {                         // FUN_0042c1f0: covers NDC [-1,1]
    constructor(ui, id, name) { super(ui, id, 0x42000000, -1, -1, 2, 2, name); this.focus = null; this.focusTop = null; this.modal = null; }
    render(xo, yo) { super.render(xo, yo); if (this.modal) this.modal.render(xo, yo); }                       // FUN_0042c260
    update(dt) { super.update(dt); if (this.modal) this.modal.update(dt); }
    selectable(it) { return !it.disabled && it.active; }
    focusNext() {                                                                                          // FUN_0042c2b0
      if (!this.focusTop) { const f = this.kids[0]; this.focusTop = this.focus = f; if (f) f.hover = true; return; }
      let i = this.kids.indexOf(this.focusTop) + 1;
      while (i < this.kids.length && !this.selectable(this.kids[i])) i++;
      if (i >= this.kids.length) return;
      this.focusTop.clearHover(); this.focusTop = this.focus = this.kids[i]; this.focus.hover = true; this.ui.playSound(this.ui.sndHover);
    }
    focusPrev() {                                                                                          // FUN_0042c310
      if (!this.focusTop) { const f = this.kids[this.kids.length - 1]; this.focusTop = this.focus = f; if (f) f.hover = true; return; }
      let i = this.kids.indexOf(this.focusTop) - 1;
      while (i >= 0 && !this.selectable(this.kids[i])) i--;
      if (i < 0) return;
      this.focusTop.clearHover(); this.focusTop = this.focus = this.kids[i]; this.focus.hover = true; this.ui.playSound(this.ui.sndHover);
    }
  }

  // text button (FUN_0042c370 / draw FUN_0042c3e0 / update FUN_0042c720 / events FUN_0042c530)
  class TextButton extends Item {
    constructor(ui, id, flags, font, cx, cy, w, h, text, snd) {
      super(ui, id, flags, cx - w * 0.5, cy - h * 0.5, w, h, text); this.font = font; this.snd = snd; this.grow = 0;
    }
    tick(dt) {
      if (!this.hover) { this.grow -= dt; if (this.grow < 0) this.grow = 0; }
      else { this.grow += dt * 3.0; if (this.grow > 0.25) this.grow = 0.25; }
    }
    draw(xo, yo) {
      const R = this.ui.r, e = this.grow * -0.013, cx = this.w * 0.5 + this.x + xo, cy = this.h * 0.5 + this.y + yo;
      if (this.hover) {                                    // pulsing halo copy, driven by the fractional game time
        const f = frac(this.ui.t), a = Math.trunc(200 * (1 - f));
        R.text(this.font, cx, cy, this.h + f * 0.012 * 4.5, this.h + f * 0.012 * 4.5, ((a << 24) | 0xc8c8c8) >>> 0, this.name, 0xb);
      }
      R.text(this.font, cx, cy, this.h + e, this.h + e, this.disabled ? 0xff969696 : 0xffffffff, this.name, 0xb);
    }
    onEvent(type, p2, p3) {
      if (type === 5 || type === 1) { this.play(); return this.parent.onEvent(0xe, 0, 0); }
      return super.onEvent(type, p2, p3);
    }
  }
  // screen title (FUN_0042c800/FUN_0042c840): centred text, fixed height 0.09
  class TitleLabel extends Item {
    constructor(ui, font, x, y, w, h, text) { super(ui, 0, 0xc0000000, x, y, w, h, text); this.font = font; }
    draw(xo, yo) { this.h = 0.09; this.ui.r.text(this.font, this.w * 0.5 + this.x + xo, this.h * 0.5 + this.y + yo, 0.09, 0.09, 0xffffffff, this.name, 0xb); }
  }
  // small label (FUN_0042c8a0/FUN_0042c8e0): x is the text centre, y the top
  class Label extends Item {
    constructor(ui, font, x, y, h, text, color) { super(ui, 0, 0xc0000000, x, y, h, h, text); this.font = font; this.color = color; }
    draw(xo, yo) { this.ui.r.text(this.font, this.x + xo, this.y + yo, this.h, this.h, this.color, this.name, 9); }
  }
  // textured/solid rectangle (FUN_0042e7b0 / draw FUN_0042e800)
  class Panel extends Item {
    constructor(ui, mat, x, y, w, h, color) { super(ui, 0, 0xc0000000, x, y, w, h, ''); this.mat = mat; this.color = color >>> 0; }
    draw(xo, yo) { this.ui.r.sprite(this.mat && this.mat.frames[0], this.x + xo, this.y + yo, this.w, this.h, this.color); }
  }
  // list of open network sessions (the original fills this box from the DirectPlay session enumeration; here: GET /sessions, polled every 2 s)
  class SessionList extends Item {
    constructor(ui, id, x, y, w, h) { super(ui, id, 0xc0000000 & 0x7fffffff | 0x40000000, x, y, w, h, ''); this.items = []; this.selIdx = -1; this.timer = 99; this.font = ui.fontSmall; }
    get sel() { return this.items[this.selIdx] || null; }
    tick(dt) {
      this.timer += dt; if (this.timer < 2) return; this.timer = 0;
      fetch('/sessions').then(r => r.json()).then(list => {
        const cur = this.sel && this.sel.name; this.items = list; this.selIdx = list.findIndex(x => x.name === cur);
        if (this.selIdx < 0 && this.parent) this.parent.onEvent(0x31, 0, 0);   // selected session vanished -> disable Join
      }).catch(() => { });
    }
    draw(xo, yo) {
      const R = this.ui.r, rh = 0.055;
      this.items.forEach((it, i) => {
        const ty = this.y + yo + 0.012 + i * rh; if (ty + rh > this.y + yo + this.h) return;
        if (i === this.selIdx) R.sprite(null, this.x + xo + 0.01, ty, this.w - 0.02, rh, 0x66ffffff);
        const col = i === this.selIdx ? 0xffffffff : 0xffc8c8ff;
        R.text(this.font, this.x + xo + 0.03, ty + rh * 0.5, 0.05, 0.05, col, (it.password ? '* ' : '') + it.name, 0x0a);
        R.text(this.font, this.x + xo + this.w - 0.05, ty + rh * 0.5, 0.05, 0.05, col, it.players + '/' + it.max, 0x1a);
      });
    }
    onEvent(type, p2, p3) {
      if (type === 1) { const row = Math.floor((this.ui.my - this.y - 0.012) / 0.055); if (row >= 0 && row < this.items.length) { this.selIdx = row; this.play(); this.parent.onEvent(0x30, row, 0); } return 0; }
      return super.onEvent(type, p2, p3);
    }
  }
  // plain sprite button with hover glow (FUN_0042c580 ctor / FUN_0042c5d0 draw / FUN_0042c720 update)
  class SpriteButton extends Item {
    constructor(ui, id, flags, mat, x, y, w, h) { super(ui, id, flags, x, y, w, h, ''); this.mat = mat; this.grow = 0; this.tint = 0xffffffff; this.frameIdx = 0; this.snd = null; }
    tick(dt) { TextButton.prototype.tick.call(this, dt); }
    img() { return this.mat && this.mat.frames[this.frameIdx]; }
    draw(xo, yo) {
      const R = this.ui.r;
      if (this.hover) {                                    // glow: a bigger tinted copy that fades with frac(t)
        const f = frac(this.ui.t), dw = f * this.w * 0.5, dh = f * this.h * 0.5, a = Math.trunc(150 * (1 - f));
        R.sprite(this.img(), this.x + xo - dw * 0.5, this.y + yo - dh * 0.5, this.w + dw, this.h + dh, ((a << 24) | 0xc8c8c8) >>> 0);
      }
      const dw = this.w * this.grow * -0.5, dh = this.h * this.grow * -0.5;
      R.sprite(this.img(), this.x + xo - dw * 0.5, this.y + yo - dh * 0.5, this.w + dw, this.h + dh, this.disabled ? 0xff969696 : this.tint);
    }
  }

  // ------------------------------------------------------------------------------------------------
  // Selector: label (right-aligned at the centre x) + current value (left-aligned) – FUN_0042c930,
  // draw FUN_0042ca40, events FUN_0042cd40, next/prev FUN_0042cca0/FUN_0042ccf0.
  // Events sent to the parent: (0xd, index, 0) for next, (0xc, index, 0) for previous.
  // ------------------------------------------------------------------------------------------------
  class Selector extends Item {
    constructor(ui, id, flags, cx, cy, w, label) { super(ui, id, flags, cx - w * 0.5, cy - 0.03, w, 0.06, label); this.items = []; this.idx = 0; this.snd = ui.sndSel; this.font = ui.fontSmall; }
    add(text, value) { this.items.push({ text, value }); }                            // FUN_0042cb80
    set(i) { if (this.items.length && i < this.items.length) this.idx = i; }           // FUN_0042cc30
    get value() { return this.items.length ? this.items[this.idx].value : 0; }         // FUN_0042cc70
    tick(dt) { }
    draw(xo, yo) {
      const R = this.ui.r; let col = this.hover ? 0xffffffff : 0xffc8c8ff; if (this.disabled) col = 0xff969696;
      const cy = this.h * 0.5 + this.y + yo, cx = this.w * 0.5 + this.x + xo;
      R.text(this.font, cx, cy, this.h, this.h, col, this.name, 0x1a);
      const it = this.items[this.idx];
      if (it) R.text(this.font, cx + this.h, cy, this.h, this.h, col, it.text, 0x0a);
    }
    step(dir) {
      const n = this.items.length; if (!n) return;
      if (dir > 0) { this.idx++; if (this.idx >= n) this.idx = 0; } else { this.idx--; if (this.idx < 0) this.idx = n - 1; }
      this.play(); this.parent.onEvent(dir > 0 ? 0xd : 0xc, this.idx, 0);
    }
    onEvent(type, p2, p3) {
      if (type === 7) { if (p2 === DIK.LEFT) return this.step(-1); if (p2 !== DIK.RIGHT) return super.onEvent(type, p2, p3); return this.step(1); }
      if (type === 1) return this.step(1);
      if (type === 2) return this.step(-1);
      if (type === 4) { if (p2 > 0) return this.step(1); return this.step(-1); }
      return super.onEvent(type, p2, p3);
    }
  }
  // Slider 0..100 (FUN_0042cda0, draw FUN_0042cde0, events FUN_0042d070, mouse FUN_0042d000). Sends (0xf, value, 0)
  class Slider extends Item {
    constructor(ui, id, flags, x, y, label) { super(ui, id, flags, x, y, 0.3, 0.06, label); this.value = 0; this.font = ui.fontBig; }
    set(v) { this.value = Math.min(100, v); }                                          // FUN_0042cfe0
    draw(xo, yo) {
      const R = this.ui.r, m = this.ui.mat;
      if (this.hover) {                                                                // hover halo of the bar
        const f = frac(this.ui.t), a = Math.trunc(200 * (1 - f));
        R.sprite(m.sliderbg.frames[0], this.x + xo - 0.03 - f * this.w * 0.2 * 0.5, this.y + yo - f * this.h * 0.5, this.w + 0.06 + f * this.w * 0.2, this.h + f * this.h, ((a << 24) | 0xdcdcdc) >>> 0);
      }
      const col = this.hover ? 0xffffffff : 0xffc8c8ff;
      R.text(this.font, this.x + xo - 0.05, this.h * 0.5 + this.y + yo, this.h, this.h, col, this.name, 0x1a);
      R.sprite(m.sliderbg.frames[0], this.x + xo - 0.03, this.y + yo, this.w + 0.06, this.h, 0xffffffff);
      R.sprite(m.slider.frames[0], this.x + xo - 0.015 + this.value * 0.003, this.y + yo, 0.03, this.h, 0xffffffff);
    }
    change(v) { v = Math.max(0, Math.min(100, v)); if (v !== this.value) { this.value = v; this.parent.onEvent(0xf, v, 0); return true; } return false; }
    onEvent(type, p2, p3) {
      let v = this.value;
      if (type === 7 && (p2 === DIK.LEFT)) v = v < 6 ? 0 : v - 5;
      else if ((type === 7 && p2 === DIK.RIGHT) || (type === 4 && p2 >= 1)) v = Math.min(100, v + 5);
      else if (type === 4 && p2 < 1) v = v < 6 ? 0 : v - 5;
      else if (type === 1 || (type === 3 && (p2 & 1))) {                               // mouse set: value = (mouseX - x0)/0.003
        const mx = this.ui.mx; v = mx <= this.x ? 0 : Math.min(100, Math.trunc((mx - this.x) * 333.3333));
      } else return super.onEvent(type, p2, p3);
      this.change(v); return 0;
    }
  }
  // Text field (FUN_0042d100, draw FUN_0042d1a0, keys FUN_0042d4c0). Text is a byte string (ArmSCII-8 for Armenian).
  class TextField extends Item {
    constructor(ui, id, flags, font, x, y, label) { super(ui, id, flags, x, y, 0.3, 0.06, label); this.font = font; this.text = ''; this.cur = 0; this.snd = ui.sndSel; }
    setText(t) { this.text = t || ''; this.cur = 0; }                                  // FUN_0042d160
    draw(xo, yo) {
      const R = this.ui.r, x0 = this.x + xo, y0 = this.y + yo, w = this.w, h = this.h, t = 0.003;
      R.sprite(null, x0, y0, w, h, 0xdc283246);                                        // fill (DAT_0049cfe8)
      R.sprite(null, x0 - t, y0 - t, w + 0.006, t, 0xffdcdcdc); R.sprite(null, x0 - t, y0 + h, w + 0.006, t, 0xffdcdcdc);
      R.sprite(null, x0 - t, y0, t, h, 0xffdcdcdc); R.sprite(null, x0 + w, y0, t, h, 0xffdcdcdc);
      const col = this.hover ? 0xffffffff : 0xffc8c8ff;
      if (this.name) R.text(this.font, x0 - 0.02, y0, h, h, col, this.name, 0x18);
      R.text(this.font, x0, y0, h, h, col, this.text, 0x08);
      if (this.hover && (Math.trunc(this.ui.t * 3.0) & 1)) {                           // blinking caret
        const upto = this.text.slice(0, this.cur), cw = this.font.measure(upto) * h * 0.75 / this.font.cellH;
        R.sprite(null, x0 + cw + 0.0025, y0 + 0.0025, 0.0025, h - 0.005, 0xffffffff);
      }
    }
    changed() { this.play(); return this.parent.onEvent(0x10, 0, 0); }                // FUN_0042d490
    onEvent(type, p2, p3) {
      if (type !== 7) return 0;
      const len = this.text.length;
      switch (p2) {
        case DIK.BACK: if (this.cur) { this.text = this.text.slice(0, this.cur - 1) + this.text.slice(this.cur); this.cur--; return this.changed(); } break;
        case DIK.HOME: this.cur = 0; break;
        case DIK.LEFT: if (this.cur) this.cur--; break;
        case DIK.RIGHT: if (this.cur < len) this.cur++; break;
        case DIK.END: this.cur = len; break;
        case DIK.DEL: if (this.cur < len) { this.text = this.text.slice(0, this.cur) + this.text.slice(this.cur + 1); return this.changed(); } break;
        default: {
          const ch = this.ui.keyToChar(p2); if (!ch) break;
          const cand = this.text.slice(0, this.cur) + ch + this.text.slice(this.cur);
          if (this.font.measure(cand) * this.h * 0.75 / this.font.cellH < this.w) { this.text = cand; this.cur++; return this.changed(); }
        }
      }
      return 0;
    }
  }
  // Arrow pickers (FUN_0042e0f0): prev arrow | content | next arrow. Events to the parent: 10 = previous, 0xb = next
  class ArrowPicker extends Item {
    constructor(ui, id, flags, cx, cy, w) { super(ui, id, flags, cx - w * 0.5, cy - 0.04, w, 0.08, ''); this.leftHot = true; this.region = 0; this.snd = ui.sndPN; }
    drawArrows(xo, yo) {                                                               // FUN_0042e160
      const R = this.ui.r, pn = this.ui.mat.prevnext, x = xo + this.x, y = yo + this.y, aw = 0.08;
      const glow = (img, gx, gy) => {
        const f = frac(this.ui.t), d = f * this.h * 0.8, s = 0.08 + d, a = Math.trunc(255 * (1 - f) * 0.0 + 160 * (1 - f));
        R.sprite(img, gx - d * 0.5, gy - d * 0.5, s, s, ((a << 24) | 0xc8c8c8) >>> 0);
      };
      if (this.hover && this.leftHot) glow(pn.frames[0], x, y);
      R.sprite(pn.frames[0], x, y, aw, aw, 0xffffffff);
      if (this.hover && !this.leftHot) glow(pn.frames[1], x + this.w - aw, y);
      R.sprite(pn.frames[1], x + this.w - aw, y, aw, aw, 0xffffffff);
    }
    fire(next) { this.leftHot = !next; this.play(); this.parent.onEvent(next ? 0xb : 10, 0, 0); }
    onEvent(type, p2, p3) {
      if (type === 7) { if (p2 === DIK.LEFT) return this.fire(false); if (p2 === DIK.RIGHT) return this.fire(true); return super.onEvent(type, p2, p3); }
      if (type === 4) { if (p2 > 0) return this.fire(true); return this.fire(false); }
      if (type === 1) { return this.fire(this.region === 1); }
      if (type === 2) { if (this.region === 2) return this.fire(true); return super.onEvent(type, p2, p3); }
      if (type === 3) {                                                                // FUN_0042e3d0: which part is under the mouse
        const mx = this.ui.mx;
        this.region = mx <= this.x + 0.08 ? 0 : (mx < this.x + this.w - 0.08 ? 2 : 1);
        if (this.region === 0) this.leftHot = true; else if (this.region === 1) this.leftHot = false;
        return super.onEvent(type, p2, p3);
      }
      return super.onEvent(type, p2, p3);
    }
  }
  class CarPicker extends ArrowPicker {                                               // FUN_00431ac0 (w 0.75), draw FUN_0042e530
    constructor(ui, cx, cy) { super(ui, 0x14, 0x40000000, cx, cy, 0.75); }
    draw(xo, yo) {
      this.drawArrows(xo, yo);
      const col = this.hover ? 0xffffffff : 0xffc8c8ff, car = this.ui.settings.car();
      this.ui.r.text(this.ui.fontBig, this.w * 0.5 + this.x + xo, this.y + yo, this.h, this.h, col, car ? car.name : '', 9);
    }
  }
  class ColorPicker extends ArrowPicker {                                             // FUN_00431b00 (w 0.5), draw FUN_0042e5b0
    constructor(ui, cx, cy) { super(ui, 0x15, 0x40000000, cx, cy, 0.5); }
    draw(xo, yo) {
      this.drawArrows(xo, yo);
      const R = this.ui.r, S = this.ui.settings, cx = this.w * 0.5 * 1 + this.x + xo, cy = this.h * 0.5 + this.y + yo;
      R.sprite(null, cx - 0.035, cy - 0.035, 0.07, 0.07, S.colorARGB(0));
      const s = this.h * 0.7;
      R.sprite(null, cx - 0.12 - s * 0.5, cy - s * 0.5, s, s, S.colorARGB(-1));
      R.sprite(null, cx + 0.12 - s * 0.5, cy - s * 0.5, s, s, S.colorARGB(1));
    }
  }
  class PlatePicker extends ArrowPicker {                                             // FUN_00431b30 (w 0.6), draw FUN_0042e700
    constructor(ui, cx, cy) { super(ui, 0x16, 0x40000000, cx, cy, 0.6); }
    draw(xo, yo) {
      this.drawArrows(xo, yo);
      this.ui.drawPlate(this.w * 0.5 + this.x + xo - 0.2, this.h * 0.5 + this.y + yo - 0.05, 0.4, 0.1);
    }
  }
  // language flag (FUN_004319c0): toggles DAT_0049cfd4 between the two flag frames
  class LangFlag extends SpriteButton {
    constructor(ui) { super(ui, 0x30, 0x40000000, ui.mat.lang, 0.85, -0.95, 0.1, 0.1); this.snd = ui.sndSel; }
    draw(xo, yo) { this.frameIdx = this.ui.lang; super.draw(xo, yo); }                // FUN_0042c770
    onEvent(type, p2, p3) {                                                           // FUN_0042c7a0
      if ((type === 7 && (p2 === DIK.LEFT || p2 === DIK.RIGHT)) || type === 1 || type === 2) { this.ui.lang = this.ui.lang ? 0 : 1; this.play(); return 0; }
      return super.onEvent(type, p2, p3);
    }
  }
  // slot for the 3D car preview (FUN_0042e850 ctor, draw FUN_0042e890): viewport = the item's rectangle
  class PreviewSlot extends Item {
    constructor(ui, x, y) { super(ui, 0x13, 0xc0000000, x, y, 0.8, 0.8, ''); }
    draw(xo, yo) { this.ui.drawPreview((this.x + xo + 1) * W / 2, (this.y + yo + 1) * H / 2, this.w * W / 2, this.h * H / 2); }
  }

  // ------------------------------------------------------------------------------------------------
  // INI helpers (raw bytes as latin1 so Armenian strings keep their ArmSCII-8 codes)
  // ------------------------------------------------------------------------------------------------
  function parseIni(buf) {
    const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    const out = new Map(); let sec = null;
    for (const line of s.split(/\r?\n/)) {
      const m = /^\s*\[(.+?)\]/.exec(line);
      if (m) { sec = new Map(); out.set(m[1].toLowerCase(), sec); continue; }
      const eq = line.indexOf('=');
      if (eq > 0 && sec) sec.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).replace(/\s+$/, ''));
    }
    return { get(sec, key, def) { const s2 = out.get(sec.toLowerCase()); const v = s2 && s2.get(key.toLowerCase()); return v === undefined ? def : v; } };       // FUN_00423cd0 / FUN_00423c60
  }
  const geti = (ini, sec, key, def) => { const v = parseInt(ini.get(sec, key, ''), 10); return Number.isNaN(v) ? def : v; };

  // ------------------------------------------------------------------------------------------------
  // Game settings object (DAT_004dbaf8; FUN_00426100 reads config.ini, FUN_00412b30 the car list)
  // ------------------------------------------------------------------------------------------------
  const DEFAULT_CARS = ['2110', 'A190', 'bmw', 'CL600', 'G500', 'gazel', 'Honda', 'HUMMER', 'Kamaz', 'mits', 'Nissan', 'niva', 'Peugeot', 'Toyota', 'TT', 'UAZ', 'Vaz 2108'];
  class Settings {
    static async load(vfs, opts) {
      const s = new Settings(); opts = opts || {};
      const cfg = parseIni(await vfs.bytes('config.ini'));
      s.cfg = cfg; s.registered = opts.registered !== false;
      s.width = geti(cfg, 'DISPLAY', 'Width', 800); s.height = geti(cfg, 'DISPLAY', 'Height', 600); s.bpp = geti(cfg, 'DISPLAY', 'BPP', 16);
      s.texLOD = geti(cfg, 'DISPLAY', 'TextureLOD', 0); if (s.texLOD > 1) s.texLOD = 0;
      s.viewDist = geti(cfg, 'DISPLAY', 'ViewDistance', 1); if (s.viewDist > 2) s.viewDist = 1;
      s.showMap = geti(cfg, 'DISPLAY', 'ShowMap', 0) !== 0; s.showTakh = geti(cfg, 'DISPLAY', 'ShowTakhometr', 0) !== 0;
      s.sound = geti(cfg, 'VOLUME', 'Sound', 50); s.music = geti(cfg, 'VOLUME', 'Music', 50);
      s.carId = geti(cfg, 'MYCAR', 'CarID', 0); s.colorIdx = geti(cfg, 'MYCAR', 'Color', 0); s.plateType = geti(cfg, 'MYCAR', 'Hamar', 0);
      s.plateText = cfg.get('MYCAR', 'HamarName', ''); s.myName = cfg.get('MYCAR', 'MyName', ''); s.auto = geti(cfg, 'MYCAR', 'Transmission', 1) !== 0;
      s.single = { gameType: geti(cfg, 'SINGLE', 'GameType', 0), opponents: geti(cfg, 'SINGLE', 'NumOpponents', 7), opponentCars: geti(cfg, 'SINGLE', 'OpponentCars', 0), laps: geti(cfg, 'SINGLE', 'Laps', 2), traffic: geti(cfg, 'SINGLE', 'Traffic', 1), hardness: geti(cfg, 'SINGLE', 'Hardness', 1) };
      s.multi = { playerName: cfg.get('MULTI', 'PlayerName', ''), sessionName: cfg.get('MULTI', 'SessionName', ''), maxPlayers: geti(cfg, 'MULTI', 'MaxPlayers', 2), laps: geti(cfg, 'MULTI', 'Laps', 2), gameType: geti(cfg, 'MULTI', 'GameType', 0) };
      // paint colours: Cars/carcol.ini COLOR0..COLORn with R,G,B floats (stops at the first missing entry; max 25)
      s.colors = [];
      try {
        const cc = parseIni(await vfs.bytes('Cars/carcol.ini'));
        for (let i = 0; i < 25; i++) { const r = parseFloat(cc.get('COLOR' + i, 'R', '-1')), g = parseFloat(cc.get('COLOR' + i, 'G', '-1')), b = parseFloat(cc.get('COLOR' + i, 'B', '-1')); if (r < 0 || g < 0 || b < 0) break; s.colors.push([r, g, b]); }
      } catch (e) { /* no colour table */ }
      if (opts.colors) s.colors = opts.colors;
      if (s.colors.length === 10) s.colors.push([0.95, 0.95, 0.95], [0.7, 0.72, 0.75], [0.03, 0.03, 0.03], [0.75, 0.05, 0.05], [0.1, 0.25, 0.7], [0.9, 0.75, 0.1]);   // the original palette has only these 10 colours (no white): web port adds white, silver, black, red, blue, yellow (same list in game.js EXTRA_COLS)
      // car list: every Cars/<dir> that has avto.ref + avto.tex + avto.par, kept sorted by the CarID stored in the .par (@0x84)
      let folders = DEFAULT_CARS;
      if (vfs.files) { const set = new Set(); for (const k of vfs.files.keys()) { const m = /^cars\/([^/]+)\/avto\.par$/.exec(k); if (m) set.add(m[1]); } if (set.size) folders = [...set]; }
      s.cars = [];
      for (const f of (opts.carFolders || folders)) {
        try {
          const b = await vfs.bytes('Cars/' + f + '/avto.par'); const dv = new DataView(b); if (dv.getUint32(0, true) !== 0x21524143) continue;
          let nm = ''; for (let i = 4; i < 0x20 && dv.getUint8(i); i++) nm += String.fromCharCode(dv.getUint8(i));
          s.cars.push({ folder: f, name: nm, id: dv.getUint32(0x84, true) });
        } catch (e) { /* missing car */ }
      }
      s.cars.sort((a, b) => a.id - b.id);
      if (!s.registered) s.cars.length = Math.min(1, s.cars.length);
      s.carIdx = Math.max(0, s.cars.findIndex(c => c.id === s.carId));
      return s;
    }
    car() { return this.cars[this.carIdx]; }
    nextCar() { this.carIdx = (this.carIdx + 1) % this.cars.length; }                      // FUN_00427040
    prevCar() { this.carIdx = this.carIdx === 0 ? this.cars.length - 1 : this.carIdx - 1; } // FUN_00427090
    nextColor() { this.colorIdx = (this.colorIdx + 1) % this.colors.length; }               // FUN_00427160
    prevColor() { this.colorIdx = this.colorIdx === 0 ? this.colors.length - 1 : this.colorIdx - 1; } // FUN_00427210
    colorARGB(off) {                                                                        // FUN_004270d0/FUN_00427160/FUN_00427210
      const n = this.colors.length; if (!n) return 0xff808080;
      const c = this.colors[(((this.colorIdx + off) % n) + n) % n];
      return ARGB(255, Math.trunc(c[0] * 255), Math.trunc(c[1] * 255), Math.trunc(c[2] * 255));
    }
    nextPlate(n) { this.plateType = (this.plateType + 1) % n; }                              // FUN_0042a610
    prevPlate(n) { this.plateType = this.plateType === 0 ? n - 1 : this.plateType - 1; }     // FUN_0042a650
    toJSON() { return { sound: this.sound, music: this.music, colorIdx: this.colorIdx, plateType: this.plateType, plateText: this.plateText, myName: this.myName, auto: this.auto, carId: this.car() && this.car().id, showMap: this.showMap, showTakh: this.showTakh, texLOD: this.texLOD, viewDist: this.viewDist, bpp: this.bpp, single: this.single }; }
  }

  // US-layout DIK scancode -> character bytes; Armenian (ArmSCII-8) phonetic layout for lang 1.
  // The original fills its scancode table (DAT_004dd538) at run time; this phonetic layout is a close approximation.
  const DIK_LETTERS = { 0x10: 'q', 0x11: 'w', 0x12: 'e', 0x13: 'r', 0x14: 't', 0x15: 'y', 0x16: 'u', 0x17: 'i', 0x18: 'o', 0x19: 'p', 0x1e: 'a', 0x1f: 's', 0x20: 'd', 0x21: 'f', 0x22: 'g', 0x23: 'h', 0x24: 'j', 0x25: 'k', 0x26: 'l', 0x2c: 'z', 0x2d: 'x', 0x2e: 'c', 0x2f: 'v', 0x30: 'b', 0x31: 'n', 0x32: 'm' };
  const DIK_DIGITS = { 2: '1', 3: '2', 4: '3', 5: '4', 6: '5', 7: '6', 8: '7', 9: '8', 10: '9', 11: '0' };
  const PHON = { a: 0, b: 1, g: 2, d: 3, e: 4, z: 5, t: 30, i: 10, l: 11, x: 12, k: 14, h: 15, m: 19, y: 20, n: 21, o: 36, p: 25, j: 26, s: 28, v: 29, r: 31, c: 32, w: 33, q: 35, f: 37, u: 23 };
  function keyChar(dik, shift, lang) {
    if (dik === 0x39) return ' ';
    const l = DIK_LETTERS[dik], dg = DIK_DIGITS[dik];
    if (lang === 1 && l) { const k = PHON[l]; return String.fromCharCode(0xb2 + 2 * k + (shift ? 0 : 1)); }
    if (l) return shift ? l.toUpperCase() : l;
    if (dg) return dg;
    return '';
  }
  const KEYCODE_TO_DIK = (() => {
    const m = { Escape: 1, Enter: 0x1c, NumpadEnter: 0x1c, Tab: 0x0f, ArrowLeft: 0xcb, ArrowRight: 0xcd, ArrowUp: 200, ArrowDown: 0xd0, Home: 199, End: 0xcf, Delete: 0xd3, Backspace: 0x0e, Space: 0x39 };
    for (const [d, c] of Object.entries(DIK_LETTERS)) m['Key' + c.toUpperCase()] = +d;
    for (const [d, c] of Object.entries(DIK_DIGITS)) m['Digit' + c] = +d;
    return m;
  })();

  // ------------------------------------------------------------------------------------------------
  // The UI manager (DAT_004ddb40): owns the screens, the transition animation (FUN_00430f80 / FUN_00435320),
  // the per-frame draw (FUN_00430c70) and the input dispatcher (FUN_004315f0).
  // ------------------------------------------------------------------------------------------------
  class GameUI {
    constructor(opts) {
      this.canvas = opts.canvas; this.vfs = opts.vfs; this.opts = opts; this.onStartGame = opts.onStartGame || (() => { }); this.onQuit = opts.onQuit || (() => { });
      this.canvas.width = W; this.canvas.height = H; this.ctx = this.canvas.getContext('2d'); this.r = new Renderer(this.ctx);
      this.t = 0; this.mx = 0; this.my = 0; this.lang = 1; this.screens = new Map(); this.cur = null; this.next = null;
      this.anim = null; this.animT = 0; this.dir = 0; this.flyDir = [0, 0]; this.sounds = new Map(); this.audio = null; this.previewImpl = opts.preview || null;
    }
    async init() {
      const v = this.vfs;
      this.mat = {};
      const menu = await MaterialSet.load(v, 'Menu/menu.ref', 'Menu/menu.tex'), std = await MaterialSet.load(v, 'Menu/Std.ref', 'Menu/menu.tex');
      Object.assign(this.mat, { bg: menu.get('bg'), fl: menu.get('fl'), envmap: menu.get('envmap'), cursor: std.get('cursor'), slider: std.get('slider'), sliderbg: std.get('sliderbg'), prevnext: std.get('prevnext'), wnd: std.get('wnd'), stdalpha: std.get('stdalpha'), lang: std.get('lang') });
      const carmat = await MaterialSet.load(v, 'Cars/carmat.ref', 'Cars/carmat.tex'); this.carmat = carmat;
      const st = await MaterialSet.load(v, 'Graph/start.ref', 'Graph/start.tex'), ld = await MaterialSet.load(v, 'Graph/loading.ref', 'Graph/loading.tex');
      this.mat.start = st.get('start'); this.mat.loadbg = ld.get('loadbg');
      this.fontBig = await Font.load(v, 'Menu/fontbig.ref'); this.fontSmall = await Font.load(v, 'Menu/fontsmall.ref');
      this.settings = await Settings.load(v, this.opts.settings);
      this.ini = parseIni(await v.bytes('Menu/menuam.ini'));
      // sounds (Menu/Menu.snd): hover = select3, transition = select1, button = button, go = gotocity, pn = arrows, sel = selitem
      this.sndHover = 'select3.wav'; this.sndTrans = 'select1.wav'; this.sndBack = 'back.wav'; this.sndGo = 'gotocity.wav'; this.sndButton = 'button.wav'; this.sndPN = 'pn.wav'; this.sndSel = 'selitem.wav';
      try { this.snd = YD.readBFX(await v.bytes('Menu/Menu.snd')); } catch (e) { this.snd = new Map(); }
      this.buildScreens();
      this.keys = new Set();
      return this;
    }
    S(sec, key, def) { return this.ini.get(sec, key, def); }                                 // FUN_00423cd0
    ensureAudio() {
      if (this.audio || !(global.AudioContext || global.webkitAudioContext)) return;
      this.audio = new (global.AudioContext || global.webkitAudioContext)(); this.gain = this.audio.createGain(); this.gain.gain.value = this.settings.sound / 100; this.gain.connect(this.audio.destination);
      if (!this.menuMusic && !this.stopped && this.vfs) this.vfs.bytes('Menu/menu.mp3').then(b => { if (this.stopped || this.menuMusic) return; const m = new Audio(URL.createObjectURL(new Blob([b], { type: 'audio/mpeg' }))); m.loop = true; m.volume = Math.min(1, (this.settings.music === undefined ? 50 : this.settings.music) / 100); this.menuMusic = m; m.play().catch(() => { }); }).catch(() => { });   // Menu/menu.mp3 plays while the menus are open
    }
    async playSound(name) {
      if (!name || !this.snd || !this.snd.has(name)) return; this.ensureAudio(); if (!this.audio) return;
      try {
        let b = this.sounds.get(name); if (!b) { b = this.audio.decodeAudioData(this.snd.get(name).slice(0)); this.sounds.set(name, b); }
        const src = this.audio.createBufferSource(); src.buffer = await b; src.connect(this.gain); src.start();
      } catch (e) { /* ignore audio errors */ }
    }
    keyToChar(dik) { if (dik === 0xfe) { const c = this.injectChar || ''; this.injectChar = ''; return c; } return keyChar(dik, this.shiftDown, this.lang); }
    drawPlate(x, y, w, h) {                                                                  // plate = hamar<type> texture + the plate text
      const m = this.carmat.get('stdhamar'), S = this.settings; const img = m && m.frames[S.plateType % Math.max(1, m.frames.length)];
      this.r.sprite(img, x, y, w, h, 0xffffffff);
      if (S.plateText) this.r.text(this.fontBig, x + w * 0.5, y + h * 0.5, h * 0.6, h * 0.6, 0xff000000, S.plateText, 0xb);
    }
    drawPreview(px, py, pw, ph) { if (this.previewImpl) this.previewImpl.draw(this.ctx, px, py, pw, ph, this.t, this.settings); }

    // ---- screen registry / transitions ----
    addScreen(sc) { this.screens.set(sc.id, sc); sc.parent = null; return sc; }
    show(id, animate) {                                                                      // FUN_00430f80
      const target = this.screens.get(id); const cur = this.cur;
      if (cur && cur.id === id) { cur.modal = null; return cur; }
      if (animate) {
        if (!cur) this.dir = 0; else { this.dir = 1; cur.onEvent(9, 0, 0); this.anim = cur.kids[cur.kids.length - 1] || null; }
        this.next = target || null;
        if (target) {
          target.modal = null; target.onEvent(8, 0, 0);
          if (!this.anim) this.anim = target.kids[0] || null;
          if (!cur) { this.cur = target; this.next = null; }
        }
        this.animT = 0;
        if (this.anim) {                                                                     // direction the leaving item flies away in
          let cx = this.anim.w * 0.5 + this.anim.x, cy = this.anim.h * 0.5 + this.anim.y; if (cx === 0 && cy === 0) cx = 1;
          const l = Math.hypot(cx, cy); this.flyDir = [cx / l, cy / l]; this.playSound(this.sndTrans);
        }
        return this.next;
      }
      if (cur) cur.onEvent(9, 0, 0);
      this.cur = target || null; if (this.cur) { this.cur.modal = null; this.cur.onEvent(8, 0, 0); }
      this.anim = null; return this.cur;
    }
    modal(id) {                                                                              // FUN_00431230
      const t = this.screens.get(id); if (t && this.cur) { t.returnTo = this.cur.id; this.cur.modal = t; }
    }
    top() { let s = this.cur; while (s && s.modal) s = s.modal; return s; }
    // ---- per frame ----
    update(dt) {                                                                             // FUN_00435320
      this.t += dt;
      if (!this.cur) return;
      if (this.anim) {
        this.animT += dt * 24.0;
        if (this.animT > 2.0) {
          this.animT = 0;
          const sibs = (this.dir === 0 ? this.cur : this.cur).kids; const i = sibs.indexOf(this.anim);
          this.anim = this.dir === 0 ? (sibs[i + 1] || null) : (sibs[i - 1] || null);
          if (!this.anim && this.dir === 1) {
            this.cur = this.next; this.next = null; this.anim = this.cur ? this.cur.kids[0] || null : null; this.dir = 0;
          }
          if (this.anim) this.playSound(this.dir === 0 ? this.sndHover : this.sndTrans);
        }
      }
      this.cur && this.cur.update(dt);
    }
    draw() {                                                                                 // FUN_00430c70
      const r = this.r, ctx = this.ctx; if (!this.cur) return;
      if (this.overlay) ctx.clearRect(0, 0, W, H);                                            // in-game: items only, over the 3D scene
      else {
        ctx.fillStyle = '#646464'; ctx.fillRect(0, 0, W, H);                                 // clear colour 0xff646464
        const t = this.t, fl = this.mat.fl && this.mat.fl.frames[0];                        // two drifting glow sprites behind the bg
        r.sprite(fl, Math.sin(t * 0.75), Math.cos(t * 0.75) * 0.125 + 0.7, 0.5, 0.5, 0xffffffff);
        r.sprite(fl, Math.sin(t * 0.7) * 1.08, Math.cos(t * 0.7) * 0.75 - 0.4, 0.6, 0.6, 0xffffffff);
        r.sprite(this.mat.bg && this.mat.bg.frames[0], -1, -1, 2, 2, 0xffffffff);
      }
      const cur = this.cur;
      if (!this.anim) cur.render(0, 0);
      else {
        const f6 = 1 - this.animT * 0.5; let ox, oy;
        const idx = cur.kids.indexOf(this.anim);
        for (let i = 0; i < idx; i++) cur.kids[i].render(0, 0);
        if (this.dir === 0) { ox = Math.sin(f6) * f6 * 2; oy = Math.cos(f6) * f6; }
        else { ox = this.animT * 0.5 * this.flyDir[0] * 2; oy = this.animT * 0.5 * this.flyDir[1] * 2; }
        this.anim.render(ox, oy);
      }
      r.sprite(this.mat.cursor.frames[0], this.mx, this.my, 0.05, 0.0666667, 0xffffffff);    // cursor
    }
    // ---- input (FUN_004315f0) ----
    dispatch(type, p2, p3) {
      const sc = this.top(); if (!sc) return;
      if (this.anim) return;                                                                  // input is ignored while items are flying
      const out = {};
      switch (type) {
        case 1: case 2: {
          const hit = sc.hit(this.mx, this.my, out);
          if (!hit && sc.focus) { sc.focusTop && sc.focusTop.clearHover(); sc.focus = sc.focusTop = null; }
          if (sc.focus) sc.focus.onEvent(type, p2, p3); break;
        }
        case 3: {
          const hit = sc.hit(this.mx, this.my, out);
          if (hit && hit !== sc.focus) {
            if (sc.focusTop) sc.focusTop.clearHover(); sc.focus = hit; sc.focusTop = out.top; hit.hover = true; out.top && (out.top.hover = true);
            this.playSound(this.sndHover);
          }
          if (sc.focus) sc.focus.onEvent(type, p2, p3); break;
        }
        case 4: case 5: if (sc.focus) sc.focus.onEvent(type, p2, p3); break;
        case 7:
          if (sc.focus) sc.focus.onEvent(type, p2, p3);
          if (!sc.focus || !(sc.focus.flags & 0x10000000)) {
            if (p2 === 200) { sc.focusPrev(); break; }
            if (p2 === 0xd0) { sc.focusNext(); break; }
          }
          if (p2 === 0xf) { if (sc.focusTop && sc.focusTop === sc.kids[sc.kids.length - 1]) { sc.focusTop.clearHover(); sc.focusTop = sc.focus = null; } sc.focusNext(); }
      }
      if (!sc.focus) sc.onEvent(type, p2, p3);
    }
    // browser glue
    pointer(clientX, clientY) { const b = this.canvas.getBoundingClientRect(); this.mx = (clientX - b.left) / b.width * 2 - 1; this.my = (clientY - b.top) / b.height * 2 - 1; }
    attach() {
      const c = this.canvas;
      this._h = {
        mm: e => { this.pointer(e.clientX, e.clientY); this.dispatch(3, e.buttons & 1, 0); },
        md: e => { this.ensureAudio(); this.pointer(e.clientX, e.clientY); this.dispatch(e.button === 2 ? 2 : 1, 0, 0); e.preventDefault(); },
        wh: e => { this.dispatch(4, e.deltaY < 0 ? 1 : -1, 0); e.preventDefault(); },
        kd: e => {
          this.shiftDown = e.shiftKey !== e.getModifierState('CapsLock');
          // an Armenian letter typed with an Armenian keyboard layout (any browser): Unicode U+0531.. (upper) / U+0561.. (lower) -> ArmSCII-8 byte used by the game font
          const cp = e.key && e.key.length === 1 ? e.key.codePointAt(0) : 0;
          const arm = cp >= 0x531 && cp <= 0x556 ? String.fromCharCode(0xb2 + 2 * (cp - 0x531)) : cp >= 0x561 && cp <= 0x586 ? String.fromCharCode(0xb3 + 2 * (cp - 0x561)) : '';
          if (arm) { this.injectChar = arm; this.ensureAudio(); this.dispatch(7, 0xfe, 0); e.preventDefault(); return; }
          const d = KEYCODE_TO_DIK[e.code]; if (d === undefined) return; this.ensureAudio(); if (d === 0x1c) this.dispatch(5, 0, 0); else this.dispatch(7, d, 0); e.preventDefault(); },
        cm: e => e.preventDefault(),
      };
      c.addEventListener('mousemove', this._h.mm); c.addEventListener('mousedown', this._h.md); c.addEventListener('wheel', this._h.wh, { passive: false }); c.addEventListener('contextmenu', this._h.cm);
      global.addEventListener('keydown', this._h.kd);
    }
    detach() { const c = this.canvas; c.removeEventListener('mousemove', this._h.mm); c.removeEventListener('mousedown', this._h.md); c.removeEventListener('wheel', this._h.wh); c.removeEventListener('contextmenu', this._h.cm); global.removeEventListener('keydown', this._h.kd); }
  }

  // ------------------------------------------------------------------------------------------------
  // Screens (constructors: Main FUN_0042ee10, Options FUN_0042f300, Credits FUN_0042f840,
  // SinglePlayer FUN_00431c50, dialog FUN_00431780).  Handlers are the matching vtable[6] methods.
  // ------------------------------------------------------------------------------------------------
  GameUI.prototype.buildScreens = function () {
    const ui = this, S = (a, b, c) => ui.S(a, b, c), big = this.fontBig, small = this.fontSmall, M = this.mat, st = this.settings;
    const panel = (sc, x, y, w, h, color) => sc.add(new Panel(ui, M.wnd, x, y, w, h, color));

    // ---- Main (id 5) ----
    const main = this.addScreen(new Screen(this, 5, 'Main'));
    const mk = (id, cx, cy, text) => main.add(new TextButton(ui, id, 0x40000000, big, cx, cy, 0.4, 0.064, text, ui.sndButton));
    mk(6, -0.55, 0.05, S('MAIN', 'SinglePlayer', 'Single Player')); mk(7, -0.45, 0.14, S('MAIN', 'MultyPlayer', 'Multy Player'));
    mk(8, -0.35, 0.23, S('MAIN', 'Options', 'Options')); mk(9, -0.25, 0.32, S('MAIN', 'Credits', 'Credits')); mk(1, -0.15, 0.41, S('ALL', 'ExitWindows', 'Exit'));
    main.onEvent = function (type, p2) {                                                  // FUN_00431b80
      const f = this.focus;
      if (f) {
        const go = { 6: 10, 7: 0x27, 8: 0x18, 9: 0x25 }[f.id];
        if (go && type === 0xe) { ui.show(go, true); return 0; }
        if (f.id === 1 && type === 0xe) { ui.modal(0x3a); return 0; }
      }
      if (type === 7 && p2 === 1) ui.modal(0x3a);
      return 0;
    };

    // ---- Options (id 0x18) ----
    const opt = this.addScreen(new Screen(this, 0x18, 'Options'));
    opt.add(new TitleLabel(ui, big, 0, -0.95, 0, 0.065, S('OPTIONS', 'Name', 'OPTIONS')));
    panel(opt, -0.7, -0.6, 1.4, 1.3, 0xd2414b5a);
    const res = opt.add(new Selector(ui, 0x1e, 0x40000000, 0, -0.3, 0.6, S('OPTIONS', 'Resolution', 'Resolution')));
    res.add(st.width + ' x ' + st.height, 0); res.set(0);
    const bpp = opt.add(new Selector(ui, 0x1d, 0x40000000, 0, -0.2, 0.6, S('OPTIONS', 'BPP', 'Color bits'))); bpp.add('16', 16); bpp.add('32', 32); bpp.set(st.bpp === 32 ? 1 : 0);
    const lod = opt.add(new Selector(ui, 0x22, 0x40000000, 0, -0.1, 0.6, S('OPTIONS', 'TextureLOD', 'Texture LOD'))); lod.add(S('OPTIONS', 'Hi', 'Hi'), 0); lod.add(S('OPTIONS', 'Low', 'Low'), 1); lod.set(st.texLOD);
    const vd = opt.add(new Selector(ui, 0x1f, 0x40000000, 0, 0, 0.6, S('OPTIONS', 'ViewDistance', 'View distance'))); vd.add(S('ALL', 'Close', 'Close'), 0); vd.add(S('ALL', 'Near', 'Near'), 1); vd.add(S('ALL', 'Far', 'Far'), 2); vd.set(st.viewDist);
    const snd = opt.add(new Slider(ui, 0x20, 0x40000000, 0, 0.2, S('OPTIONS', 'Sound', 'Sound'))); const mus = opt.add(new Slider(ui, 0x21, 0x40000000, 0, 0.3, S('OPTIONS', 'Music', 'Music')));
    opt.add(new TextButton(ui, 2, 0x40000000, big, -0.45, 0.9, 0.2, 0.064, S('ALL', 'Back', 'BACK'), ui.sndButton));
    opt.onEvent = function (type, p2) {                                                   // FUN_00433330
      if (type === 8) { snd.set(st.sound); mus.set(st.music); }
      const f = this.focus;
      if (f) switch (f.id) {
        case 2: if (type === 0xe) { ui.show(5, true); return 0; } break;
        case 0x1d: st.bpp = f.value; break; case 0x22: st.texLOD = f.idx; break; case 0x1f: st.viewDist = f.idx; break;
        case 0x20: if (type === 0xf) { st.sound = p2; if (ui.gain) ui.gain.gain.value = p2 / 100; ui.onSettings && ui.onSettings(st); return 0; } break;
        case 0x21: if (type === 0xf) { st.music = p2; ui.onSettings && ui.onSettings(st); return 0; } break;
      }
      if (type === 7 && p2 === 1) ui.show(5, true);
      return 0;
    };

    // ---- Credits (id 0x25) ----
    const cr = this.addScreen(new Screen(this, 0x25, 'Credits'));
    cr.add(new TitleLabel(ui, big, 0, -0.95, 0, 0.065, S('CREDITS', 'Name', 'CREDITS')));
    panel(cr, -0.5, -0.84, 1.0, 1.7, 0xd2414b5a);
    let y = -0.79;
    for (let i = 0; i < 3; i++) { cr.add(new Label(ui, small, -0.25, y, 0.0449, S('CREDITS', 'Arsh' + i, ''), 0xffc8dcdc)); y += 0.0496; }
    y += 0.0124; cr.add(new Label(ui, small, -0.25, y, 0.05, S('CREDITS', 'Arsh3', ''), 0xffffffff));
    y -= 0.07; cr.add(new Label(ui, small, 0.25, y, 0.05, S('CREDITS', 'Art0', ''), 0xffc8dcdc));
    y += 0.062; cr.add(new Label(ui, small, 0.25, y, 0.05, S('CREDITS', 'Art1', ''), 0xffffffff));
    y += 0.08; cr.add(new Label(ui, small, 0, y, 0.0575, S('CREDITS', 'Music', ''), 0xffc8dcdc));
    y += 0.0806;
    for (let i = 20; i < 23; i++) { const t = S('CREDITS', 'C' + i, ''); if (!t) break; cr.add(new Label(ui, small, 0, y, 0.05, t, 0xffffffff)); y += 0.062; }
    cr.add(new Label(ui, small, 0, y, 0.0575, S('CREDITS', 'Merci', ''), 0xffc8dcdc)); y += 0.0806;
    for (let i = 0; i < 20; i++) { const t = S('CREDITS', 'C' + i, ''); if (!t) break; cr.add(new Label(ui, small, 0, y, 0.05, t, 0xffffffff)); y += 0.062; }
    cr.add(new TextButton(ui, 2, 0x40000000, big, -0.45, 0.9, 0.2, 0.064, S('ALL', 'Back', 'BACK'), ui.sndButton));
    cr.onEvent = function (type, p2) {                                                    // FUN_00433460
      if ((this.focus && this.focus.id === 2 && type === 0xe) || (type === 7 && p2 === 1)) ui.show(5, true);
      return 0;
    };

    // ---- Single player setup (id 10) ----
    const sp = this.addScreen(new Screen(this, 10, 'SinglePlayer')); this.single = sp;
    sp.add(new LangFlag(ui));
    sp.add(new TitleLabel(ui, big, 0, -0.95, 0, 0.065, S('SINGLEPLAYER', 'Name', 'SINGLE PLAYER GAME')));
    panel(sp, -0.86, -0.2, 0.96, 0.8, 0xd2414b5a);
    const gt = sp.add(new Selector(ui, 0xb, 0x40000000, -0.27, -0.12, 0.6, S('SINGLEPLAYER', 'GameType', 'Game type'))); gt.add(S('SINGLEPLAYER', 'Walker', 'Walk on city'), 0); if (st.registered) gt.add(S('SINGLEPLAYER', 'Gonka', 'Championat'), 1);
    const opp = sp.add(new Selector(ui, 0xe, 0xc0000000, -0.27, -0.02, 0.6, S('SINGLEPLAYER', 'Opponents', 'Opponents'))); for (let i = 1; i <= 7; i++) opp.add(String(i), i);
    const oc = sp.add(new Selector(ui, 0x10, 0xc0000000, -0.27, 0.08, 0.6, S('SINGLEPLAYER', 'OpponentCar', 'Opponent cars'))); oc.add(S('SINGLEPLAYER', 'Tarber', 'Tarber'), 0); oc.add(S('SINGLEPLAYER', 'YourCar', 'Your car'), 1);
    const hd = sp.add(new Selector(ui, 0xf, 0xc0000000, -0.27, 0.18, 0.6, S('SINGLEPLAYER', 'Hardness', 'Hardness'))); hd.add(S('SINGLEPLAYER', 'Child', 'Child'), 0); hd.add(S('SINGLEPLAYER', 'Young', 'Young'), 1); hd.add(S('SINGLEPLAYER', 'Usta', 'Usta'), 2);
    const lp = sp.add(new Selector(ui, 0xc, 0xc0000000, -0.27, 0.28, 0.6, S('SINGLEPLAYER', 'Laps', 'Laps number'))); for (let i = 2; i <= 5; i++) lp.add(String(i), i);
    const tr = sp.add(new Selector(ui, 0xd, 0x40000000, -0.27, 0.38, 0.6, S('SINGLEPLAYER', 'Traffic', 'Traffic'))); tr.add(S('ALL', 'Fiew', 'Fiew'), 0); tr.add(S('ALL', 'Normal', 'Normal'), 1); tr.add(S('ALL', 'Many', 'Many'), 2);
    if (!st.registered) tr.setEnabled(false);
    panel(sp, 0.1, -0.8, 0.8, 1.55, 0xd2414b5a);
    const nameF = sp.add(new TextField(ui, 0x28, 0x40000000, big, 0.5, -0.7, S('ALL', 'YourName', 'Your name')));
    sp.add(new CarPicker(ui, 0.5, -0.52)); sp.add(new ColorPicker(ui, 0.5, -0.38)); sp.add(new PlatePicker(ui, 0.5, -0.24));
    const plateF = sp.add(new TextField(ui, 0x17, 0x40000000, big, 0.5, -0.1, S('ALL', 'Hamar', 'Hamar')));
    const trans = sp.add(new Selector(ui, 0x12, 0x40000000, 0.5, 0.04, 0.6, S('TRANSMISSION', 'Transmission', 'Transmisiion'))); trans.add(S('TRANSMISSION', 'Hand', 'Hand'), 0); trans.add(S('TRANSMISSION', 'Auto', 'Auto'), 1);
    sp.add(new PreviewSlot(ui, 0.1, 0.1));
    sp.add(new TextButton(ui, 2, 0x40000000, big, -0.45, 0.9, 0.2, 0.064, S('ALL', 'Back', 'BACK'), ui.sndButton));
    sp.add(new TextButton(ui, 0x11, 0x40000000, big, 0.6, 0.9, 0.2, 0.064, S('GMCHOICECAR', 'GoToCity', 'GO TO CITY'), ui.sndGo));
    const raceRows = [opp, oc, lp, hd];
    sp.applySettings = () => {                                                            // what FUN_00426100 does to the selectors
      const c = st.single; gt.set(c.gameType ? Math.min(c.gameType, gt.items.length - 1) : 0); opp.set(Math.max(0, Math.min(6, c.opponents - 1))); oc.set(c.opponentCars ? 1 : 0);
      hd.set(Math.max(0, Math.min(2, c.hardness))); lp.set(Math.max(0, Math.min(3, c.laps - 2))); tr.set(Math.max(0, Math.min(2, c.traffic)));
      for (const r of raceRows) r.setEnabled(gt.idx !== 0);
    };
    sp.applySettings();
    sp.onEvent = function (type, p2, p3) {                                                // FUN_00432730
      if (type === 8) { trans.set(st.auto ? 1 : 0); plateF.setText(st.plateText); nameF.setText(st.myName); }
      const f = this.focus;
      if (f) switch (f.id) {
        case 2: if (type === 0xe) { ui.show(5, true); return 0; } break;
        case 0xb: if (type === 0xc || type === 0xd) for (const r of raceRows) r.setEnabled(p2 !== 0); break;
        case 0x11: if (type === 0xe) {
          ui.show(0, true);
          ui.onStartGame({ car: st.car(), colorIdx: st.colorIdx, color: st.colorARGB(0), plateType: st.plateType, plateText: st.plateText, name: st.myName, auto: st.auto, race: gt.idx !== 0 || gt.value !== 0, gameTypeIndex: gt.idx, opponents: opp.idx + 1, opponentCars: oc.idx, hardness: hd.idx, laps: lp.idx + 2, traffic: tr.idx, settings: st });
          return 0;
        } break;
        case 0x12: st.auto = trans.idx !== 0; break;
        case 0x14: if (type === 10) st.prevCar(); else if (type === 0xb) st.nextCar(); if (type === 10 || type === 0xb) return 0; break;
        case 0x15: if (type === 10) st.prevColor(); else if (type === 0xb) st.nextColor(); if (type === 10 || type === 0xb) return 0; break;
        case 0x16: { const n = (ui.carmat.get('stdhamar') || { frames: [1] }).frames.length; if (type === 10) st.prevPlate(n); else if (type === 0xb) st.nextPlate(n); if (type === 10 || type === 0xb) return 0; break; }
        case 0x17: if (type === 0x10) { st.plateText = plateF.text; return 0; } break;
        case 0x28: if (type === 0x10) { st.myName = nameF.text; return 0; } break;
      }
      if (type === 7 && p2 === 1) ui.show(5, true);
      return 0;
    };

    // ---- exit confirmation (dialog id 0x3a, built by FUN_00431780; w 0.88 h 0.6) ----
    const dlg = this.addScreen(new Screen(this, 0x3a, 'ExitDialog')); dlg.flags = 0x42000000;
    const dw = 0.88, dh = 0.6; dlg.x = -dw / 2; dlg.y = -dh / 2; dlg.w = dw; dlg.h = dh;
    dlg.add(new Panel(ui, M.wnd, -dw * 0.5, -dh * 0.5, dw, dh, 0xd246553c));
    dlg.add(new Label(ui, small, 0, 0.08 - dh * 0.5, 0.06, S('STRINGS', 'ExitWindows', 'Exit?'), 0xffffffff));
    const by = dh * 0.5 - 0.12;
    dlg.add(new TextButton(ui, 3, 0x40000000, big, -0.175, by, 0.25, 0.064, S('STRINGS', 'OK', 'OK'), ui.sndButton));
    dlg.add(new TextButton(ui, 4, 0x40000000, big, 0.175, by, 0.25, 0.064, S('STRINGS', 'Cancel', 'Cancel'), ui.sndButton));
    dlg.onEvent = function (type, p2) {
      const f = this.focus;
      if (f && type === 0xe) { if (f.id === 3) ui.onQuit(); else if (f.id === 4) ui.screens.get(5).modal = null; return 0; }
      if (type === 7 && p2 === 1) ui.screens.get(5).modal = null;
      return 0;
    };
    dlg.hit = function (px, py, out) {                                                    // modal: buttons are tested against the whole screen
      for (const k of this.kids) { if (k.disabled || !k.active) continue; if (k.x < px && px <= k.x + k.w && k.y < py && py <= k.y + k.h) { k.hover = true; if (out) out.top = k; return k; } }
      return null;
    };
    // the dialog is a child of the screen below: its coordinates are absolute NDC, so give it full-screen bounds for rendering
    dlg.x = -1; dlg.y = -1; dlg.w = 2; dlg.h = 2;
    // ---- MultiPlayer (id 0x27, built by FUN_00433bc0-ish at yd.c:35399) ----
    const mp = this.addScreen(new Screen(this, 0x27, 'MultiPlayer'));
    mp.add(new TitleLabel(ui, big, 0, -0.95, 0, 0.065, S('MULTIPLAYER', 'Name', 'MULTIPLAYER GAME')));
    mp.add(new LangFlag(ui));
    panel(mp, -0.7, -0.6, 1.4, 1.3, 0xd2414b5a);
    const mpName = mp.add(new TextField(ui, 0x28, 0x40000000, big, -0.3, -0.52, S('ALL', 'YourName', 'Your name')));
    const mpPass = mp.add(new TextField(ui, 0x2a, 0x40000000, big, 0.3, -0.52, S('MULTIPLAYER', 'Password', 'Password')));
    const mpSess = mp.add(new TextField(ui, 0x29, 0x40000000, big, 0, -0.37, S('MULTIPLAYER', 'SessionName', 'Session name')));
    const mpMax = mp.add(new Selector(ui, 0x2e, 0x40000000, 0, -0.22, 0.6, S('MULTIPLAYER', 'MaxPlayers', 'Max. players'))); for (let i = 2; i <= 8; i++) mpMax.add(String(i), i);
    const mpType = mp.add(new Selector(ui, 0xb, 0x40000000, 0, -0.12, 0.6, S('MULTIPLAYER', 'GameType', 'Game type')));
    mpType.add(S('MULTIPLAYER', 'Walker', 'Walk on city'), 0); mpType.add(S('MULTIPLAYER', 'Gonka', 'Championat'), 1); mpType.add(S('MULTIPLAYER', 'GM', '"Gox & Milica"'), 2);
    const mpLaps = mp.add(new Selector(ui, 0xc, 0xc0000000, 0, -0.02, 0.6, S('SINGLEPLAYER', 'Laps', 'Laps number'))); for (let i = 2; i <= 5; i++) mpLaps.add(String(i), i);
    mp.add(new TextButton(ui, 0x2d, 0x40000000, big, 0.4, 0.08, 0.3, 0.064, S('MULTIPLAYER', 'Create', 'Create session'), ui.sndButton));
    // session list box (FUN_00431a50): dark filled box with a light border
    mp.add(new Panel(ui, null, -0.6, 0.28, 1.2, 0.25, 0xdc283246));
    for (const [x, y, w, h] of [[-0.603, 0.277, 1.206, 0.003], [-0.603, 0.53, 1.206, 0.003], [-0.603, 0.277, 0.003, 0.256], [0.6, 0.277, 0.003, 0.256]]) mp.add(new Panel(ui, null, x, y, w, h, 0xffdcdcdc));
    const mpList = mp.add(new SessionList(ui, 0x2f, -0.6, 0.28, 1.2, 0.25));
    const mpJoin = mp.add(new TextButton(ui, 0x2c, 0xc0000000, big, 0.4, 0.6, 0.3, 0.064, S('MULTIPLAYER', 'Join', 'Join to game'), ui.sndButton));
    mp.add(new TextButton(ui, 2, 0x40000000, big, -0.45, 0.9, 0.2, 0.064, S('ALL', 'Back', 'BACK'), ui.sndButton));
    mp.onEvent = function (type, p2) {
      if (type === 8) { mpName.setText(st.myName); mpSess.setText(st.multi.sessionName); mpMax.set(Math.max(0, (st.multi.maxPlayers || 2) - 2)); mpType.set(2); mpLaps.setEnabled(false); mpJoin.setEnabled(false); mpList.items = []; mpList.selIdx = -1; mpList.timer = 99; }
      if (type === 0x31) mpJoin.setEnabled(false);   // the chosen session is gone
      if (type === 0x30) mpJoin.setEnabled(true);    // a session row was selected
      const f = this.focus;
      if (f) switch (f.id) {
        case 0xb: if (type === 0xc || type === 0xd) mpLaps.setEnabled(mpType.idx === 1); break;
        case 0x2d: if (type === 0xe) { ui.onNetwork && ui.onNetwork('create', { name: mpName.text, password: mpPass.text, session: mpSess.text, maxPlayers: mpMax.value, gameType: mpType.idx, laps: mpLaps.value }); return 0; } break;
        case 0x2c: if (type === 0xe) { ui.onNetwork && ui.onNetwork('join', { name: mpName.text, password: mpPass.text, session: mpList.sel && mpList.sel.name }); return 0; } break;
        case 2: if (type === 0xe) { ui.show(5, true); return 0; } break;
      }
      if (type === 7 && p2 === 1) ui.show(5, true);
      return 0;
    };

    // ---- multiplayer car choice (id 0x38 'GMCar', built by FUN_004338d0): car / colour / plate / transmission, then GO TO CITY ----
    const gc = this.addScreen(new Screen(this, 0x38, 'GMCar'));
    gc.add(new Panel(ui, M.wnd, -0.45, -0.9, 0.9, 1.8, 0xd2414b5a));
    gc.add(new LangFlag(ui));
    gc.add(new CarPicker(ui, 0, -0.65)); gc.add(new ColorPicker(ui, 0, -0.53)); gc.add(new PlatePicker(ui, 0, -0.41));
    const gTrans = gc.add(new Selector(ui, 0x12, 0x40000000, 0, -0.29, 0.6, S('TRANSMISSION', 'Transmission', 'Transmisiion'))); gTrans.add(S('TRANSMISSION', 'Hand', 'Hand'), 0); gTrans.add(S('TRANSMISSION', 'Auto', 'Auto'), 1);
    const gPlate = gc.add(new TextField(ui, 0x17, 0x40000000, big, 0, -0.19, S('ALL', 'Hamar', 'Hamar')));
    gc.add(new PreviewSlot(ui, -0.4, -0.19));
    gc.add(new TextButton(ui, 0x39, 0x40000000, big, -0.15, 0.41, 0.3, 0.064, S('GMCHOICECAR', 'ChoiceCar', 'CHOICE CAR'), ui.sndButton));
    const goBtn = gc.add(new TextButton(ui, 0x11, 0x40000000, big, 0.2, 0.41, 0.3, 0.064, S('GMCHOICECAR', 'GoToCity', 'GO TO CITY'), ui.sndGo)); goBtn.setEnabled(false);
    gc.add(new TextButton(ui, 8, 0x40000000, big, 0, 0.51, 0.3, 0.064, S('OPTIONS', 'Name', 'OPTIONS'), ui.sndButton));
    gc.add(new TextButton(ui, 0x34, 0x40000000, big, 0, 0.61, 0.3, 0.064, S('ALL', 'MainMenu', 'MAIN MENU'), ui.sndButton));
    gc.add(new TextButton(ui, 1, 0x40000000, big, 0, 0.71, 0.3, 0.064, S('ALL', 'ExitWindows', 'EXIT WINDOWS'), ui.sndButton));
    gc.onEvent = function (type, p2, p3) {
      if (type === 8) { gTrans.set(st.auto ? 1 : 0); gPlate.setText(st.plateText); goBtn.setEnabled(true); }   // GO TO CITY starts disabled (FUN_0042a6c0); the game enables it
      const f = this.focus;
      if (f) switch (f.id) {
        case 0x11: if (type === 0xe) { cmd('mpgo'); return 0; } break;       // GO TO CITY (FUN_00426e80: host sends the start message)
        case 0x39: if (type === 0xe) { cmd('mpchoice'); return 0; } break;   // CHOICE CAR (FUN_00429420: broadcast car, colour and plate)
        case 8: if (type === 0xe) { ui.screens.get(0x26).returnId = 0x38; ui.show(0x26, false); return 0; } break;
        case 0x34: if (type === 0xe) { cmd('menu'); return 0; } break;
        case 1: if (type === 0xe) { cmd('exit'); return 0; } break;
        case 0x12: st.auto = gTrans.idx !== 0; break;
        case 0x14: if (type === 10) st.prevCar(); else if (type === 0xb) st.nextCar(); if (type === 10 || type === 0xb) return 0; break;
        case 0x15: if (type === 10) st.prevColor(); else if (type === 0xb) st.nextColor(); if (type === 10 || type === 0xb) return 0; break;
        case 0x16: { const n = (ui.carmat.get('stdhamar') || { frames: [1] }).frames.length; if (type === 10) st.prevPlate(n); else if (type === 0xb) st.nextPlate(n); if (type === 10 || type === 0xb) return 0; break; }
        case 0x17: if (type === 0x10) { st.plateText = gPlate.text; return 0; } break;
      }
      return 0;
    };

    // ---- in-game screens (built by FUN_00430210 GSMain 0x31, FUN_00430440-ish GOptions 0x26, FUN_004304e0 GReport 0x35) ----
    const PANEL = 0xd2414b5a   /* DAT_0049cfd8 */, cmd = c => { if (ui.onGameCommand) ui.onGameCommand(c); };
    const gm = this.addScreen(new Screen(this, 0x31, 'GSMain'));
    gm.add(new Panel(ui, null, -0.35, -0.5, 0.7, 1.0, PANEL));
    gm.add(new TextButton(ui, 8, 0x40000000, big, 0, -0.15, 0.6, 0.064, S('OPTIONS', 'Name', 'OPTIONS'), ui.sndButton));
    gm.add(new TextButton(ui, 0x32, 0x40000000, big, 0, -0.05, 0.6, 0.064, S('ALL', 'RestartGame', 'RESTART GAME'), ui.sndButton));
    gm.add(new TextButton(ui, 0x34, 0x40000000, big, 0, 0.05, 0.6, 0.064, S('ALL', 'MainMenu', 'MAIN MENU'), ui.sndButton));
    gm.add(new TextButton(ui, 1, 0x40000000, big, 0, 0.15, 0.6, 0.064, S('ALL', 'ExitWindows', 'EXIT WINDOWS'), ui.sndButton));
    gm.onEvent = function (type, p2) {
      const f = this.focus;
      if (f && type === 0xe) { if (f.id === 8) ui.show(0x26, false); else if (f.id === 0x32) cmd('restart'); else if (f.id === 0x34) cmd('menu'); else if (f.id === 1) cmd('exit'); return 0; }
      if (type === 7 && p2 === 1) cmd('resume');
      return 0;
    };
    const go = this.addScreen(new Screen(this, 0x26, 'GOptions'));
    go.add(new Panel(ui, M.wnd, -0.37, -0.5, 0.74, 1.0, PANEL));
    const gsnd = go.add(new Slider(ui, 0x20, 0x40000000, 0, -0.28, S('OPTIONS', 'Sound', 'Sound')));
    const gmus = go.add(new Slider(ui, 0x21, 0x40000000, 0, -0.16, S('OPTIONS', 'Music', 'Music')));
    const gmap = go.add(new Selector(ui, 0x23, 0x40000000, 0, -0.04, 0.3, S('OPTIONS', 'Map', 'Map'))); gmap.add(S('ALL', 'Off', 'Off'), 0); gmap.add(S('ALL', 'On', 'On'), 1);
    const gtak = go.add(new Selector(ui, 0x24, 0x40000000, 0, 0.08, 0.3, S('OPTIONS', 'Takhometr', 'Takhometr'))); gtak.add(S('ALL', 'Off', 'Off'), 0); gtak.add(S('ALL', 'On', 'On'), 1);
    go.add(new TextButton(ui, 3, 0x40000000, big, 0, 0.25, 0.3, 0.064, S('ALL', 'Back', 'BACK'), ui.sndButton));
    go.onEvent = function (type, p2) {
      if (type === 8) { gsnd.set(st.sound); gmus.set(st.music); gmap.set(st.showMap ? 1 : 0); gtak.set(st.showTakh ? 1 : 0); }
      const f = this.focus;
      if (f) switch (f.id) {
        case 3: if (type === 0xe) { ui.show(this.returnId || 0x31, false); this.returnId = 0x31; return 0; } break;
        case 0x20: if (type === 0xf) { st.sound = p2; if (ui.gain) ui.gain.gain.value = p2 / 100; ui.onSettings && ui.onSettings(st); return 0; } break;
        case 0x21: if (type === 0xf) { st.music = p2; ui.onSettings && ui.onSettings(st); return 0; } break;
        case 0x23: st.showMap = f.idx !== 0; break; case 0x24: st.showTakh = f.idx !== 0; break;
      }
      if (type === 7 && p2 === 1) { ui.show(this.returnId || 0x31, false); this.returnId = 0x31; }
      return 0;
    };
    const gr = this.addScreen(new Screen(this, 0x35, 'GReport'));
    gr.add(new Panel(ui, M.wnd, -0.4, -0.6, 0.8, 1.2, PANEL));
    gr.add(new TextButton(ui, 0x32, 0x40000000, big, 0, 0.31, 0.6, 0.064, S('ALL', 'RestartGame', 'RESTART GAME'), ui.sndButton));
    gr.add(new TextButton(ui, 0x34, 0x40000000, big, 0, 0.4, 0.6, 0.064, S('ALL', 'MainMenu', 'MAIN MENU'), ui.sndButton));
    gr.add(new TextButton(ui, 1, 0x40000000, big, 0, 0.49, 0.6, 0.064, S('ALL', 'ExitWindows', 'EXIT WINDOWS'), ui.sndButton));
    gr.onEvent = function (type) {
      const f = this.focus;
      if (f && type === 0xe) { if (f.id === 0x32) cmd('restart'); else if (f.id === 0x34) cmd('menu'); else if (f.id === 1) cmd('exit'); return 0; }
      return 0;
    };
    this.start = () => { this.show(5, true); };
  };

  // ------------------------------------------------------------------------------------------------
  // Boot splash (FUN_00436de0: timer 0..7 s, brightness byte = 255*1.25*t for t<0.8, 255 until 6.2 s,
  // 255*1.25*(7-t) after; drawn as the full-screen "start" sprite with colour 0xffbbbbbb) and the loading screen
  // (FUN_004286d0: "loadbg" full screen + a red bar of width progress*10 at y=0.98, height 0.02).
  // ------------------------------------------------------------------------------------------------
  GameUI.prototype.splashBrightness = function (t) {
    if (t < 0 || t >= 7.0) return 0;
    if (t < 0.8) return Math.trunc(t * 1.25 * 255);
    if (t > 6.2) return Math.trunc((7.0 - t) * 1.25 * 255);
    return 255;
  };
  GameUI.prototype.drawSplash = function (t) {
    const ctx = this.ctx; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const b = this.splashBrightness(t);
    this.r.sprite(this.mat.start && this.mat.start.frames[0], -1, -1, 2, 2, ARGB(255, b, b, b));
  };
  GameUI.prototype.drawLoading = function (progress) {                                      // progress 0..0.2 maps to the full bar
    const ctx = this.ctx; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    this.r.sprite(this.mat.loadbg && this.mat.loadbg.frames[0], -1, -1, 2, 2, 0xffffffff);
    this.r.sprite(null, -1, 0.98, progress * 10.0, 0.02, 0xffff0000);
  };

  // ------------------------------------------------------------------------------------------------
  // In-game gauges (FUN_00425af0).  A viewport in the bottom-right corner (w = 0.3*W, h = 0.2*H) with an orthographic
  // 2x1 view; the unit quad is the dual dial (takhmain), two needles (takhslak) and the gear glyph (takhskor frame = gear).
  //   needle quad: translate(0,0.5) * scale(0.025,0.4) * rotZ(theta) * translate(+-0.53,-0.02)
  //   rpm needle  theta = 1.92 - rpm/maxRpm*3.8      speed needle theta = 2.355 - |v|(m/s)*0.057214
  //   gear glyph: scale 0.15, centred at (0,0.35); frame 0 = R, 1 = N, 2..7 = gears 1..6
  // ------------------------------------------------------------------------------------------------
  GameUI.prototype.drawGauges = function (ctx, st) {
    const cm = this.carmat; if (!cm) return;
    const vw = Math.trunc(W * 0.3), vh = Math.trunc(H * 0.2), vx = W - vw, vy = H - vh;
    const face = cm.get('takhmain'), needle = cm.get('takhslak'), gear = cm.get('takhskor');
    const U = (ux, uy) => [vx + vw / 2 + ux * vw / 2, vy + vh / 2 - uy * vh];            // unit -> pixels (ortho 2 x 1)
    ctx.save(); ctx.beginPath(); ctx.rect(vx, vy, vw, vh); ctx.clip(); ctx.imageSmoothingEnabled = true;
    if (face && face.frames[0]) ctx.drawImage(face.frames[0], vx, vy, vw, vh);
    const drawNeedle = (cx, cy, theta) => {
      if (!needle || !needle.frames[0]) return;
      const [px, py] = U(cx, cy); ctx.save(); ctx.translate(px, py); ctx.rotate(-theta);   // +theta = counter-clockwise on screen
      const lw = 0.025 * vw / 2, lh = 0.4 * vh;                                            // 0.025 x 0.4 units, pivot at the bottom centre
      ctx.drawImage(needle.frames[0], -lw / 2, -lh, lw, lh); ctx.restore();
    };
    drawNeedle(-0.53, -0.02, 1.92 - (st.rpm / st.maxRpm) * 3.8);
    drawNeedle(0.53, -0.02, 2.355 - Math.abs(st.speed) * 0.057214);
    if (gear && gear.frames.length) {
      const gi = st.gear < 0 ? 0 : st.gear === 0 ? 1 : Math.min(gear.frames.length - 1, st.gear + 1);
      const gimg = gear.frames[gi]; if (gimg) { const [gx, gy] = U(0, 0.35), gs = 0.15; ctx.drawImage(gimg, gx - gs * vw / 4, gy - gs * vh / 2, gs * vw / 2, gs * vh); }
    }
    ctx.restore();
  };
  // text helpers for the game code (HUD strings use the same bitmap fonts)
  GameUI.prototype.drawText = function (font, str, x, y, a, color, flags) { this.r.text(font === 'small' ? this.fontSmall : this.fontBig, x, y, a, a, color >>> 0, str, flags); };

  // ------------------------------------------------------------------------------------------------
  // 3D car preview for the single-player screen (FUN_0042e890): perspective fov 30deg, aspect 4/3, near 0.3, far 16,
  // eye (0,3,-10) looking at the origin, model spinning at 0.5 rad/s about Y, one white directional light
  // dir (0.1,-0.5,0.5), ambient 0xff646464, plus the 6-face cube map of Menu/menu.tex (cubemap.dds) as environment.
  // ------------------------------------------------------------------------------------------------
  class ThreePreview {
    constructor(vfs, ui) { this.vfs = vfs; this.ui = ui; this.key = ''; this.ready = false; }
    async init() {
      const THREE = global.THREE; if (!THREE || !global.YDCar) return this;
      const c = this.canvas = document.createElement('canvas'); c.width = 410; c.height = 307;
      this.renderer = new THREE.WebGLRenderer({ canvas: c, alpha: true, antialias: true, preserveDrawingBuffer: true });
      this.renderer.setClearColor(0x000000, 0); this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(30, 4 / 3, 0.3, 16); this.camera.position.set(0, 3, -10); this.camera.lookAt(0, 0, 0);
      this.scene.add(new THREE.AmbientLight(0x646464, 1.0));
      const dl = new THREE.DirectionalLight(0xffffff, 1.0); const d = new THREE.Vector3(-0.1, -0.5, 0.5).normalize(); dl.position.copy(d).multiplyScalar(-10); this.scene.add(dl);
      // cube map: 128x128x6 faces, D3D order +X -X +Y -Y +Z -Z (x mirrored in this engine)
      const m = await this.vfs.bytes('Menu/menu.tex'); const files = YD.readBFX(m); const dds = files.get('cubemap.dds');
      if (dds) {
        const dv = new DataView(dds), w = dv.getUint32(16, true), h = dv.getUint32(12, true), bytes = dv.getUint32(88, true) / 8, face = w * h * bytes, faces = [];
        const masks = [dv.getUint32(92, true), dv.getUint32(96, true), dv.getUint32(100, true)];
        for (let f = 0; f < 6; f++) {
          const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d'), id = g.createImageData(w, h); const o = 128 + f * face;
          for (let i = 0; i < w * h; i++) { let v = 0; for (let k = 0; k < bytes; k++) v |= dv.getUint8(o + i * bytes + k) << (8 * k); v >>>= 0; id.data[i * 4] = (v & masks[0]) >>> shift(masks[0]); id.data[i * 4 + 1] = (v & masks[1]) >>> shift(masks[1]); id.data[i * 4 + 2] = (v & masks[2]) >>> shift(masks[2]); id.data[i * 4 + 3] = 255; }
          g.putImageData(id, 0, 0); faces.push(cv);
        }
        this.cube = new THREE.CubeTexture([faces[1], faces[0], faces[2], faces[3], faces[4], faces[5]]); this.cube.needsUpdate = true;
      }
      this.ready = true; return this;
    }
    async setCar(car, argb) {
      const key = car.folder + '|' + argb; if (key === this.key) return; this.key = key;
      const THREE = global.THREE, cc = [[((argb >> 16) & 255) / 255, ((argb >> 8) & 255) / 255, (argb & 255) / 255]];
      const loaded = await YDCar.loadCar(this.vfs, car.folder, 0, cc); if (key !== this.key) return;
      if (this.pivot) this.scene.remove(this.pivot);   // the old model lives inside the old pivot group: remove the group, not just the car object
      this.model = loaded; loaded.obj.rotation.set(0, 0, 0); this.pivot = new THREE.Group(); this.pivot.add(loaded.obj);
      loaded.obj.position.y = loaded.radius;                                              // wheel centre height above the ground
      const box = new THREE.Box3().setFromObject(loaded.obj), sz = box.getSize(new THREE.Vector3()), s = 5.2 / Math.max(sz.x, sz.z); this.pivot.scale.setScalar(s);
      this.scene.add(this.pivot);
      if (this.cube) loaded.obj.traverse(o => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach(mt => { if (mt && mt.transparent) { mt.transparent = false; mt.opacity = 1; mt.color.set(0x000000); mt.emissive && mt.emissive.set(0x000000); mt.depthWrite = true; mt.needsUpdate = true; } else if (mt && mt.userData.paint) { mt.envMap = this.cube; mt.combine = THREE.MixOperation; mt.reflectivity = 0.5; if (global.YDRender && YDRender.normalEnv) YDRender.normalEnv(mt); mt.needsUpdate = true; } }); });
    }
    draw(ctx, px, py, pw, ph, t, settings) {
      if (!this.ready) return; const car = settings.car(); if (!car) return;
      this.setCar(car, settings.colorARGB(0)).catch(e => console.error("preview", e && e.stack || e));
      if (!this.model) return;
      const w = Math.round(pw), h = Math.round(ph); if (this.canvas.width !== w || this.canvas.height !== h) { this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
      this.pivot.rotation.y = -t * 0.5; this.renderer.render(this.scene, this.camera);
      ctx.drawImage(this.canvas, px, py, pw, ph);
    }
  }
  function shift(mask) { let s = 0; while (mask && !((mask >>> s) & 1)) s++; const bits = (() => { let n = 0; while ((mask >>> (s + n)) & 1) n++; return n; })(); return s + Math.max(0, bits - 8); }

  // ------------------------------------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------------------------------------
  GameUI.prototype.run = function () {
    this.attach(); this.stopped = false; this.splashT = this.opts.skipSplash ? 99 : -0.0; this.last = performance.now();
    if (this.opts.skipSplash && !this.cur) this.show(5, false);
    const loop = now => {
      if (this.stopped) return; const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
      if (this.splashT < 7.0) { this.splashT += dt; this.t += dt; this.drawSplash(this.splashT); if (this.splashT >= 7.0) this.show(5, true); }
      else if (this.mode === 'loading') this.drawLoading(this.progress || 0);
      else if (this.mode === 'hidden') { /* the game owns the canvas */ }
      else { this.update(dt); this.draw(); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop); return this;
  };

  // in-game overlay: show a screen (0x31 pause menu, 0x35 report) over the 3D scene; the game calls overlayFrame(dt) each frame
  GameUI.prototype.openOverlay = function (id) { this.overlay = true; this.stopped = true; this.cur = null; this.anim = null; this.show(id, false); this.attach(); };
  GameUI.prototype.closeOverlay = function () { this.overlay = false; this.detach(); this.cur = null; this.ctx.clearRect(0, 0, W, H); };
  GameUI.prototype.overlayFrame = function (dt) { this.update(dt); this.draw(); };
  GameUI.prototype.stop = function () { this.stopped = true; this.detach(); if (this.menuMusic) { this.menuMusic.pause(); this.menuMusic = null; } };
  GameUI.prototype.setMode = function (m, progress) { this.mode = m; if (progress !== undefined) this.progress = progress; };
  GameUI.prototype.showMenu = function () { this.mode = 'menu'; this.show(5, true); };
  // render one frame of a named screen without animation (used by ui-test.html and for screenshots)
  GameUI.prototype.renderStatic = function (name, o) {
    o = o || {}; const ids = { main: 5, single: 10, options: 0x18, credits: 0x25, network: 0x27, gmcar: 0x38, gmain: 0x31, goptions: 0x26, greport: 0x35 }; this.t = o.t === undefined ? 5.3 : o.t; this.mx = o.mx === undefined ? 2 : o.mx; this.my = o.my === undefined ? 2 : o.my;
    if (name === 'boot') { this.drawSplash(o.splash === undefined ? 3 : o.splash); return; }
    if (name === 'loading') { this.drawLoading(o.progress === undefined ? 0.1 : o.progress); return; }
    if (name === 'hud') {
      const ctx = this.ctx; ctx.fillStyle = '#58708c'; ctx.fillRect(0, 0, W, H); this.drawGauges(ctx, { rpm: o.rpm === undefined ? 3200 : o.rpm, maxRpm: 7500, speed: o.speed === undefined ? 25 : o.speed, gear: o.gear === undefined ? 3 : o.gear }); return;
    }
    this.show(ids[name] || 5, false); this.anim = null; if (name === 'dialog') this.modal(0x3a);
    this.cur.update(0.016); this.draw();
  };
  const api = {
    create: async function (opts) { const ui = new GameUI(opts); await ui.init(); if (opts.preview === true || (opts.preview === undefined && global.THREE && global.YDCar)) { ui.previewImpl = await new ThreePreview(opts.vfs, ui).init(); } ui.mode = 'menu'; api.hud = { draw: (ctx, st) => ui.drawGauges(ctx, st) }; api.last = ui; return ui; },
    GameUI, Settings, ThreePreview, parseIni, keyChar, KEYCODE_TO_DIK,
  };
  global.YDUI = Object.assign(global.YDUI || {}, api);
  global.YDUI._core = { W, H, DIK, ARGB, frac, MaterialSet, Font, Renderer, Item, Screen, TextButton, TitleLabel, Label, Panel, SpriteButton, Selector, Slider, TextField, ArrowPicker, decodeToCanvas };
})(window);
