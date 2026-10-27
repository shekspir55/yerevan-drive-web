// Car effects from the original draw code: police light bar (Cars/migalka.ref + migred/migblue sprites) and collision sparks (boundparticle).
// Headlight flares: the original has NO such pass. far_alpha/farflare1/2.tga are plain body materials of a few cars (niva, Honda) and are drawn with the
// car mesh (formats.js buildRef); FUN_00410940 is the bound-mesh shadow, and car type +0x300..0x33c are copies of the wheel/axle fields (FUN_0040ed20).
(function (global) {
  'use strict';
  const T = global.THREE;
  // FUN_0040fd20 (x87 constants from the asm): bar at D3DXMatrixTranslation(0, par[0x1bc]*0.01, (int8)par[0x1bd]*0.01) * car world (type +0x3dc/+0x3e0,
  // FUN_0040ed20, 0x4845a0 = 0.01); lights at bar + up*0.15 (0x4845ec) +/- right*0.159/0.276/0.387 (0x4845e8/e4/e0), i < 3 migred else migblue,
  // each moved 0.2 m (0x483300) towards the camera, billboard size (cos(i + time*10) + 3) * 0.12 (0x483314, 0x4845dc, 0x4845d8), unit quad +/-0.5 (FUN_00406a70)
  const BAR = { up: 0.15, side: [0.159, 0.276, 0.387, -0.159, -0.276, -0.387], toCam: 0.2, freq: 10, base: 3, size: 0.12 };
  // sparks FUN_0041a4f0 / FUN_00419e50 / FUN_00419f60 / FUN_0041a150: 50-entry ring, life 0.25 s, 12 streaks at pos + (0.5 - rand)*0.5 per axis,
  // alpha life*4 + 0.2 (0x484834), quad = RotY(a) * RotY(pi/2) * T(0.5,0,0) * Scale(0, 0.05, s) * T(point), s = min(|camVel|*0.05, 1) (0x484620),
  // a from atan(dir.z/dir.x) of dir = normalize(-camVel) taken at spawn (camera object DAT_004b1188 +0x38)
  const SP = { ring: 50, n: 12, life: 0.25, spread: 0.5, aK: 4, a0: 0.2, thick: 0.05, sK: 0.05 };

  class CarFx {
    constructor(scene) { this.scene = scene; this.bars = new Map(); this.parCache = new Map(); this.sparks = []; this.ring = 0; this.time = 0; this.v = new T.Vector3(); this.w = new T.Vector3(); }
    async init(vfs) {
      this.vfs = vfs;
      try {
        const built = await YD.buildRef(YD.parseRef(await vfs.bytes('Cars/migalka.ref')), []);   // own MATLIST: white, grey, red/blue glass (alpha 0.5)
        this.barModel = built.parts.migalka || built.inner;
        const cm = await YD.TexSet.load(vfs, 'Cars/carmat.tex');   // migred = migr.dds, migblue = migb.dds (carmat.ref: unlit, SRCALPHA/INVSRCALPHA, no z-write)
        const mk = async n => { const t = await cm.get(n); return t ? new T.SpriteMaterial({ map: t, transparent: true, depthWrite: false, fog: false }) : null; };
        this.migred = await mk('migr.dds'); this.migblue = await mk('migb.dds');
      } catch (e) { console.warn('migalka', e); }
      try {   // boundparticle (Graph/citstdmat.ref): lit, emissive white, black diffuse, blend, double-sided, no z-write, texture bparticle.tga
        const tex = await (await YD.TexSet.load(vfs, 'Graph/citstdmat.tex')).get('bparticle.tga');
        const q = SP.ring * SP.n, g = new T.BufferGeometry(), idx = [];
        for (let i = 0; i < q; i++) idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3);   // strip v0 v1 v2 v3
        this.sPos = new Float32Array(q * 12); this.sCol = new Float32Array(q * 16); const uv = new Float32Array(q * 8);
        for (let i = 0; i < q; i++) uv.set([0, 1, 0, 0, 1, 1, 1, 0], i * 8);   // unit quad uvs (FUN_00406130 vertex buffer)
        g.setIndex(idx); g.setAttribute('position', new T.BufferAttribute(this.sPos, 3)); g.setAttribute('uv', new T.BufferAttribute(uv, 2)); g.setAttribute('color', new T.BufferAttribute(this.sCol, 4)); g.setDrawRange(0, 0);
        this.sMesh = new T.Mesh(g, new T.MeshBasicMaterial({ map: tex || null, vertexColors: true, transparent: true, depthWrite: false, side: T.DoubleSide, fog: false }));
        this.sMesh.frustumCulled = false; this.sMesh.visible = false; this.scene.add(this.sMesh);
      } catch (e) { console.warn('sparks', e); }
      return this;
    }
    // bar offset from the raw par bytes 0x1bc (unsigned) / 0x1bd (signed), * 0.01 (car.js keeps only 0x1b8..0x1bb)
    _offset(car) {
      const k = car.folder; if (this.parCache.has(k)) return this.parCache.get(k);
      const o = { h: 0, f: 0 }; this.parCache.set(k, o);
      if (this.vfs && k) this.vfs.bytes('Cars/' + k + '/avto.par').then(b => { const u = new Uint8Array(b); o.h = u[0x1bc] * 0.01; o.f = ((u[0x1bd] << 24) >> 24) * 0.01; }).catch(() => { });
      return o;
    }
    _drop(b) { if (b.group.parent) b.group.parent.remove(b.group); for (const s of b.lights) this.scene.remove(s); }
    // ents: [{car, police, siren}] - police = flag ctrl+0x6c (bar drawn), siren = ctrl+0x6d (lights) (FUN_0041ccb0 -> FUN_0040fd20)
    update(dt, ents, camera, camVel) {
      this.time += dt; this.camVel = camVel;
      const seen = new Set();
      if (this.barModel) for (const e of ents) {
        if (!e || !e.police || !e.car || !e.car.wheels || !e.car.wheels[0]) continue;
        let b = this.bars.get(e);
        if (b && b.car !== e.car) { this._drop(b); b = null; }   // car model swapped (CHOICE CAR)
        if (!b) {
          const inner = e.car.wheels[0].pivot.parent;   // built.inner: the car's own D3D frame (same matrix as the body)
          b = { car: e.car, inner, off: this._offset(e.car), group: this.barModel.clone(), lights: [] };
          b.group.matrixAutoUpdate = true; b.group.matrix.identity(); inner.add(b.group);
          if (this.migred && this.migblue) for (let i = 0; i < 6; i++) { const s = new T.Sprite(i < 3 ? this.migred : this.migblue); s.visible = false; this.scene.add(s); b.lights.push(s); }
          this.bars.set(e, b);
        }
        seen.add(e); b.group.position.set(0, b.off.h, b.off.f); b.group.visible = e.car.obj.visible !== false;
        const on = !!e.siren && b.group.visible;
        if (on) { b.inner.updateWorldMatrix(true, false); }
        for (let i = 0; i < b.lights.length; i++) {
          const s = b.lights[i]; s.visible = on; if (!on) continue;
          const p = s.position.set(BAR.side[i], b.off.h + BAR.up, b.off.f).applyMatrix4(b.inner.matrixWorld);
          this.v.copy(camera.position).sub(p); const L = this.v.length(); if (L > 1e-6) p.addScaledVector(this.v, BAR.toCam / L);
          const sz = (Math.cos(i + this.time * BAR.freq) + BAR.base) * BAR.size; s.scale.set(sz, sz, 1);
        }
      }
      for (const [e, b] of this.bars) if (!seen.has(e)) { this._drop(b); this.bars.delete(e); }
      this._sparks(dt);
    }
    // collision sparks at a world point (call where the crash sound starts, FUN_00413480 -> FUN_0041a4f0)
    spawnSparks(pos, camVel) {
      if (!this.sMesh) return;
      const V = camVel || this.camVel || this.w.set(0, 0, 0), dx = -V.x, dz = -V.z, h = Math.hypot(dx, dz);
      const sp = this.sparks[this.ring] || (this.sparks[this.ring] = { pts: new Float32Array(SP.n * 3) });
      this.ring = (this.ring + 1) % SP.ring;
      sp.life = SP.life; sp.k = h > 1e-9 ? dz / h : NaN;   // sin(a + pi/2) with a from FUN_00419f60's atan rule (both branches reduce to dir.z / |dir.xz|)
      for (let j = 0; j < SP.n; j++) { sp.pts[j * 3] = pos.x + (0.5 - Math.random()) * SP.spread; sp.pts[j * 3 + 1] = pos.y + (0.5 - Math.random()) * SP.spread; sp.pts[j * 3 + 2] = pos.z + (0.5 - Math.random()) * SP.spread; }
    }
    _sparks(dt) {
      if (!this.sMesh) return;
      const V = this.camVel, s = V ? Math.min(Math.hypot(V.x, V.y, V.z) * SP.sK, 1) : 0, P = this.sPos, C = this.sCol;
      let q = 0;
      for (const sp of this.sparks) {
        if (!sp || sp.life < 0) continue;
        sp.life -= dt; if (sp.life < 0 || !(sp.k === sp.k)) continue;   // FUN_0041a150; a zero camera velocity gives a NaN (invisible) quad in the original too
        const a = Math.min(1, sp.life * SP.aK + SP.a0), z = s * sp.k;   // quad vertex (x, y, 0) -> (0, 0.05*y, -x*s*sin) (x scale is 0)
        for (let j = 0; j < SP.n; j++, q++) {
          const x = sp.pts[j * 3], y = sp.pts[j * 3 + 1], zz = sp.pts[j * 3 + 2], o = q * 12, t = SP.thick * 0.5;
          P[o] = x; P[o + 1] = y - t; P[o + 2] = zz + 0.5 * z; P[o + 3] = x; P[o + 4] = y + t; P[o + 5] = zz + 0.5 * z;
          P[o + 6] = x; P[o + 7] = y - t; P[o + 8] = zz - 0.5 * z; P[o + 9] = x; P[o + 10] = y + t; P[o + 11] = zz - 0.5 * z;
          for (let v = 0; v < 4; v++) C.set([1, 1, 1, a], q * 16 + v * 4);
        }
      }
      const g = this.sMesh.geometry; this.sMesh.visible = q > 0;
      if (q || this.lastQ) { g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true; g.setDrawRange(0, q * 6); }
      this.lastQ = q;
    }
  }

  let active = null;
  global.YDCarFx = {
    CarFx, BAR, SP,
    async create(vfs, scene) { const fx = await new CarFx(scene).init(vfs); active = fx; return fx; },
    spawnSparks(pos, camVel) { if (active) active.spawnSparks(pos, camVel); },   // for the collision code (spec-collision-camera.md A.4)
  };
})(window);
