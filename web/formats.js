// Yerevan Drive file-format readers (BFX1 archive, REF! scene tree, DDS, TGA) -> three.js objects.
// Formats were reverse engineered from "Yerevan Drive.exe" v1.1; see spec-cit-trc.md for city/track data.
(function (global) {
  'use strict';

  // ---------- virtual file system: fetch() from ./game/ or a user-picked folder ----------
  class VFS {
    constructor() { this.files = null; this.base = 'game/'; this.cache = new Map(); }
    setFolder(fileList) {
      this.files = new Map();
      for (const f of fileList) {
        const rel = f.webkitRelativePath.split('/').slice(1).join('/').toLowerCase();
        this.files.set(rel, f);
      }
    }
    async bytes(path) {
      const key = path.toLowerCase();
      if (this.cache.has(key)) return this.cache.get(key);
      let buf;
      if (this.files) {
        const f = this.files.get(key);
        if (!f) throw new Error('missing file ' + path);
        buf = await f.arrayBuffer();
      } else {
        const r = await fetch(this.base + path.split('/').map(encodeURIComponent).join('/'));
        if (!r.ok) throw new Error('missing file ' + path + ' (' + r.status + ')');
        buf = await r.arrayBuffer();
      }
      this.cache.set(key, buf);
      return buf;
    }
    async exists(path) { try { await this.bytes(path); return true; } catch (e) { return false; } }
    async text(path) { return new TextDecoder('windows-1251').decode(await this.bytes(path)); }
    async ini(path) {
      const out = {}; let sec = null;
      for (const line of (await this.text(path)).split(/\r?\n/)) {
        const m = /^\s*\[(.+?)\]/.exec(line);
        if (m) { sec = out[m[1]] = {}; continue; }
        const kv = /^\s*([^=;]+?)\s*=\s*(.*?)\s*$/.exec(line);
        if (kv && sec) sec[kv[1]] = kv[2];
      }
      return out;
    }
  }

  // ---------- BFX1 archive: 'BFX1', u32 count, count * {char name[16], u32 offset, u32 size} ----------
  function readBFX(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    if (dv.getUint32(0, true) !== 0x31584642) throw new Error('not BFX1');
    const n = dv.getUint32(4, true), out = new Map();
    for (let i = 0; i < n; i++) {
      const o = 8 + 24 * i;
      let name = ''; for (let j = 0; j < 16 && u8[o + j]; j++) name += String.fromCharCode(u8[o + j]);
      const off = dv.getUint32(o + 16, true), size = dv.getUint32(o + 20, true);
      out.set(name.toLowerCase(), buf.slice(off, off + size));
    }
    return out;
  }

  // ---------- DDS (DXT1/3/5 + uncompressed) -> RGBA8 ----------
  function c565(c, o) {
    const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
    o[0] = (r << 3) | (r >> 2); o[1] = (g << 2) | (g >> 4); o[2] = (b << 3) | (b >> 2);
  }
  function decodeDDS(buf) {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x20534444) throw new Error('not DDS');
    const h = dv.getUint32(12, true), w = dv.getUint32(16, true);
    const pfFlags = dv.getUint32(80, true), fourCC = dv.getUint32(84, true);
    const bits = dv.getUint32(88, true);
    const masks = [dv.getUint32(92, true), dv.getUint32(96, true), dv.getUint32(100, true), dv.getUint32(104, true)];
    const out = new Uint8Array(w * h * 4); let alpha = false;
    const fcc = String.fromCharCode(fourCC & 255, (fourCC >> 8) & 255, (fourCC >> 16) & 255, fourCC >>> 24);
    if (pfFlags & 4) { // FOURCC
      const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
      const dxt1 = fcc === 'DXT1', bs = dxt1 ? 8 : 16;
      alpha = !dxt1;
      let p = 128; const col = new Uint8Array(16), a8 = new Uint8Array(16);
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++, p += bs) {
        let q = p + (dxt1 ? 0 : 8);
        const c0 = dv.getUint16(q, true), c1 = dv.getUint16(q + 2, true);
        c565(c0, col.subarray(0, 3)); c565(c1, col.subarray(4, 7));
        col[3] = col[7] = 255;
        if (c0 > c1 || !dxt1) {
          for (let k = 0; k < 3; k++) {
            col[8 + k] = (2 * col[k] + col[4 + k]) / 3 | 0; col[12 + k] = (col[k] + 2 * col[4 + k]) / 3 | 0;
          }
          col[11] = col[15] = 255;
        } else {
          for (let k = 0; k < 3; k++) col[8 + k] = (col[k] + col[4 + k]) >> 1;
          col[11] = 255; col[12] = col[13] = col[14] = col[15] = 0; alpha = true;
        }
        if (fcc === 'DXT3') {
          for (let i = 0; i < 8; i++) { const v = dv.getUint8(p + i); a8[2 * i] = (v & 15) * 17; a8[2 * i + 1] = (v >> 4) * 17; }
        } else if (fcc === 'DXT5') {
          const a0 = dv.getUint8(p), a1 = dv.getUint8(p + 1), al = [a0, a1];
          if (a0 > a1) for (let i = 1; i < 7; i++) al.push(((7 - i) * a0 + i * a1) / 7 | 0);
          else { for (let i = 1; i < 5; i++) al.push(((5 - i) * a0 + i * a1) / 5 | 0); al.push(0, 255); }
          let lo = dv.getUint32(p + 2, true), hi = dv.getUint16(p + 6, true);
          // 48 bits of 3-bit indices
          let bitsv = BigInt(lo) | (BigInt(hi) << 32n);
          for (let i = 0; i < 16; i++) { a8[i] = al[Number(bitsv & 7n)]; bitsv >>= 3n; }
        }
        let idx = dv.getUint32(q + 4, true);
        for (let i = 0; i < 16; i++, idx >>>= 2) {
          const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
          if (x >= w || y >= h) continue;
          const c = (idx & 3) * 4, o = (y * w + x) * 4;
          out[o] = col[c]; out[o + 1] = col[c + 1]; out[o + 2] = col[c + 2];
          out[o + 3] = dxt1 ? col[c + 3] : a8[i];
        }
      }
    } else { // uncompressed
      const bpp = bits >> 3; alpha = !!(pfFlags & 1);
      const sh = m => { if (!m) return [0, 0]; let s = 0; while (!((m >>> s) & 1)) s++; let n = 0; while ((m >>> (s + n)) & 1) n++; return [s, n]; };
      const [rs, rn] = sh(masks[0]), [gs, gn] = sh(masks[1]), [bs2, bn] = sh(masks[2]), [as, an] = sh(masks[3]);
      const sc = (v, n) => n === 8 ? v : n === 0 ? 255 : Math.round(v * 255 / ((1 << n) - 1));
      let p = 128;
      for (let i = 0; i < w * h; i++, p += bpp) {
        let v = 0; for (let k = 0; k < bpp; k++) v |= dv.getUint8(p + k) << (8 * k); v >>>= 0;
        const o = i * 4;
        out[o] = sc((v >>> rs) & ((1 << rn) - 1), rn); out[o + 1] = sc((v >>> gs) & ((1 << gn) - 1), gn);
        out[o + 2] = sc((v >>> bs2) & ((1 << bn) - 1), bn);
        out[o + 3] = an ? sc((v >>> as) & ((1 << an) - 1), an) : 255;
      }
    }
    return { width: w, height: h, data: out, alpha };
  }

  // ---------- TGA ----------
  function decodeTGA(buf) {
    const u8 = new Uint8Array(buf), idl = u8[0], type = u8[2];
    const w = u8[12] | (u8[13] << 8), h = u8[14] | (u8[15] << 8), bpp = u8[16], desc = u8[17], bp = bpp >> 3;
    const out = new Uint8Array(w * h * 4); let p = 18 + idl; const tmp = new Uint8Array(w * h * bp);
    if (type === 2 || type === 3) tmp.set(u8.subarray(p, p + tmp.length));
    else if (type === 10) {
      let o = 0; while (o < tmp.length) {
        const c = u8[p++], n = (c & 127) + 1;
        if (c & 128) { for (let i = 0; i < n; i++) for (let k = 0; k < bp; k++) tmp[o + i * bp + k] = u8[p + k]; p += bp; }
        else { tmp.set(u8.subarray(p, p + n * bp), o); p += n * bp; }
        o += n * bp;
      }
    } else throw new Error('tga type ' + type);
    const topLeft = !!(desc & 32);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = ((topLeft ? y : h - 1 - y) * w + x) * bp, o = (y * w + x) * 4;
      if (bp === 1) { out[o] = out[o + 1] = out[o + 2] = tmp[s]; out[o + 3] = 255; }
      else { out[o] = tmp[s + 2]; out[o + 1] = tmp[s + 1]; out[o + 2] = tmp[s]; out[o + 3] = bp === 4 ? tmp[s + 3] : 255; }
    }
    return { width: w, height: h, data: out, alpha: bp === 4 };
  }

  async function decodeImage(name, buf) {
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    if (ext === 'dds') return decodeDDS(buf);
    if (ext === 'tga') return decodeTGA(buf);
    const bmp = await createImageBitmap(new Blob([buf]), { imageOrientation: 'none', premultiplyAlpha: 'none' });
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const id = g.getImageData(0, 0, bmp.width, bmp.height);
    return { width: bmp.width, height: bmp.height, data: new Uint8Array(id.data.buffer), alpha: ext === 'png' };
  }

  // Texture set from one BFX1 .tex/.atx archive (decoded lazily, cached).
  class TexSet {
    constructor(files) { this.files = files; this.cache = new Map(); }
    static async load(vfs, path) { return new TexSet(readBFX(await vfs.bytes(path))); }
    has(name) { return this.files.has(name.toLowerCase()); }
    async get(name) {
      const k = name.toLowerCase();
      if (!this.files.has(k)) return null;
      if (this.cache.has(k)) return this.cache.get(k);
      const p = decodeImage(k, this.files.get(k)).then(img => {
        const t = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
        t.flipY = false; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
        t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = 4; t.ydAlpha = img.alpha; t.needsUpdate = true;
        return t;
      }).catch(e => { console.warn("texture", k, e); (global.YD_ERR = global.YD_ERR || []).push(k + ": " + e); return null; });
      this.cache.set(k, p);
      return p;
    }
  }

  // ---------- REF! chunk tree ----------
  // node: u32 type, u32 nameLen, u32 dataLen, u32 childCount; name; data; children
  function parseRef(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    let pos = 0;
    function node() {
      const type = dv.getUint32(pos, true), nl = dv.getUint32(pos + 4, true), dl = dv.getUint32(pos + 8, true), nc = dv.getUint32(pos + 12, true);
      pos += 16;
      let name = ''; for (let i = 0; i < nl && u8[pos + i]; i++) name += String.fromCharCode(u8[pos + i]);
      pos += nl;
      const data = buf.slice(pos, pos + dl); pos += dl;
      const kids = []; for (let i = 0; i < nc; i++) kids.push(node());
      return { type, name, data, kids };
    }
    return node();
  }
  const T = { SCENE: 1, MATERIAL: 3, TEXSTAGE: 5, MATLIST: 7, FRAME: 9, MESH: 0xb };

  // Collect material descriptors from a MATLIST node. Index in list == subset material id.
  function readMaterials(matlist) {
    return matlist.kids.map(m => {
      const f = new Float32Array(m.data.slice(0, 100));
      const tex = m.kids.find(k => k.type === T.TEXSTAGE);
      let tname = '';
      if (tex) { const u = new Uint8Array(tex.data); for (let i = 44; i < Math.min(u.length, 60) && u[i]; i++) tname += String.fromCharCode(u[i]); }
      return {
        name: m.name, tex: tname,
        diffuse: [f[2], f[3], f[4], f[5]], ambient: [f[6], f[7], f[8], f[9]],
        specular: [f[10], f[11], f[12], f[13]], emissive: [f[14], f[15], f[16], f[17]], power: f[18],
      };
    });
  }

  // mesh blob: 80-byte header [flags, FVF, stride, vcount, tricount, subsets, cx,cy,cz, radius, min xyz, max xyz]
  // + vertices + u16 triangle indices + subsets {matIndex, startTri, triCount, startVertex, vertexCount}
  function readMeshBlob(buf) {
    const dv = new DataView(buf);
    const flags = dv.getUint32(0, true), fvf = dv.getUint32(4, true), stride = dv.getUint32(8, true);
    const vc = dv.getUint32(12, true), tc = dv.getUint32(16, true), sc = dv.getUint32(20, true);
    const bounds = new Float32Array(buf.slice(24, 80));
    const pos = new Float32Array(vc * 3), nrm = new Float32Array(vc * 3), uv = new Float32Array(vc * 2), uv2 = (fvf & 0x200) ? new Float32Array(vc * 2) : null;
    const hasN = !!(fvf & 0x10), hasT = !!(fvf & 0x100) || !!(fvf & 0x200);
    for (let i = 0; i < vc; i++) {
      const o = 80 + i * stride; let q = 12;
      pos[i * 3] = dv.getFloat32(o, true); pos[i * 3 + 1] = dv.getFloat32(o + 4, true); pos[i * 3 + 2] = dv.getFloat32(o + 8, true);
      if (hasN) { nrm[i * 3] = dv.getFloat32(o + q, true); nrm[i * 3 + 1] = dv.getFloat32(o + q + 4, true); nrm[i * 3 + 2] = dv.getFloat32(o + q + 8, true); q += 12; }
      if (hasT) { uv[i * 2] = dv.getFloat32(o + q, true); uv[i * 2 + 1] = dv.getFloat32(o + q + 4, true); q += 8; }
      if (uv2) { uv2[i * 2] = dv.getFloat32(o + q, true); uv2[i * 2 + 1] = dv.getFloat32(o + q + 4, true); }
    }
    const io = 80 + stride * vc;
    const idx = new Uint16Array(buf.slice(io, io + tc * 6));
    const subsets = [];
    for (let i = 0; i < sc; i++) {
      const o = io + tc * 6 + 20 * i;
      subsets.push({ mat: dv.getUint32(o, true), start: dv.getUint32(o + 4, true), count: dv.getUint32(o + 8, true), v0: dv.getUint32(o + 12, true), vn: dv.getUint32(o + 16, true) });
    }
    return { flags, fvf, pos, nrm, uv, uv2, idx, subsets, bounds, hasN, hasT };
  }

  // Build a three.js material for a descriptor. `texset` may be an array of TexSets (searched in order).
  const matCache = new WeakMap();
  async function makeMaterial(desc, texsets, opts) {
    opts = opts || {};
    let map = null;
    if (desc.tex) for (const ts of texsets) { if (ts && ts.has(desc.tex)) { map = await ts.get(desc.tex); break; } }
    const d = desc.diffuse, e = desc.emissive;
    const m = new THREE.MeshLambertMaterial({
      color: map ? 0xffffff : new THREE.Color(d[0], d[1], d[2]),
      map: map || null,
      emissive: new THREE.Color(e[0], e[1], e[2]).multiplyScalar(0.8),
      side: opts.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    });
    const hasA = (map && map.ydAlpha) || d[3] < 0.98;
    if (hasA) {
      if (map && map.ydAlpha && d[3] >= 0.98) { m.alphaTest = 0.4; m.transparent = false; }
      else { m.transparent = true; m.opacity = d[3]; m.depthWrite = false; }
    }
    if (desc.name && /glass|stekl/i.test(desc.name)) { m.transparent = true; }
    return m;
  }

  // Convert a REF scene into a THREE.Group. D3D is left-handed (+Z fwd): we mirror X on the root.
  // returns {group, parts:{name:Group}, materials}
  async function buildRef(root, texsets, opts) {
    opts = opts || {};
    const scene = root.kids[0];
    const matlist = scene.kids.find(k => k.type === T.MATLIST);
    const descs = matlist ? readMaterials(matlist) : [];
    const mats = [];
    for (const d of descs) mats.push(await makeMaterial(d, texsets, opts));
    const parts = {};
    const group = new THREE.Group();
    function frame(n, parent) {
      const g = new THREE.Group(); g.name = n.name;
      if (n.data.byteLength >= 64) { g.matrixAutoUpdate = false; g.matrix.fromArray(new Float32Array(n.data.slice(0, 64))); }
      if (n.name) parts[n.name] = g;
      parent.add(g);
      for (const k of n.kids) {
        if (k.type === T.FRAME) frame(k, g);
        else if (k.type === T.MESH) g.add(meshObj(k));
      }
    }
    function meshObj(k) {
      const m = readMeshBlob(k.data);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
      if (m.hasN) geo.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 3)); else geo.computeVertexNormals();
      if (m.hasT) geo.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
      geo.setIndex(new THREE.BufferAttribute(m.idx, 1));
      const list = [];
      m.subsets.forEach(s => { geo.addGroup(s.start * 3, s.count * 3, list.length); list.push(mats[s.mat] || mats[0] || new THREE.MeshLambertMaterial()); });
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, list);
      mesh.name = k.name || '';
      mesh.userData.bounds = m.bounds;
      return mesh;
    }
    for (const k of scene.kids) if (k.type === T.FRAME) frame(k, group);
    const wrap = new THREE.Group(); wrap.scale.x = -1; wrap.add(group);
    return { group: wrap, inner: group, parts, materials: mats, descs };
  }

  global.YD = { VFS, readBFX, decodeDDS, decodeTGA, TexSet, parseRef, readMeshBlob, readMaterials, buildRef, makeMaterial, T };
})(window);
