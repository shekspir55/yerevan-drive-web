// Yerevan city loader (yerevan.cit) -> three.js world with ground height + wall collision.
// Format: see spec-cit-trc.md. The whole world is mirrored on X at the root (D3D is left-handed);
// all game-space values (positions, yaw) are in the mirrored three.js space: x' = -x, yaw' = -yaw.
(function (global) {
  'use strict';

  class Reader {
    constructor(buf) { this.dv = new DataView(buf); this.buf = buf; this.p = 0; }
    u8() { return this.dv.getUint8(this.p++); }
    u16() { const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
    u32() { const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
    f32() { const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
    skip(n) { this.p += n; }
    f32s(n) { const a = new Float32Array(this.buf.slice(this.p, this.p + 4 * n)); this.p += 4 * n; return a; }
    u16s(n) { const a = new Uint16Array(this.buf.slice(this.p, this.p + 2 * n)); this.p += 2 * n; return a; }
    str16() { const n = this.u16(); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.dv.getUint8(this.p + i)); this.p += n; return s; }
    cstr(n) { let s = ''; for (let i = 0; i < n; i++) { const c = this.dv.getUint8(this.p + i); if (!c) break; s += String.fromCharCode(c); } this.p += n; return s; }
  }

  function readMaterialList(r) {
    r.str16(); const count = r.u32(); r.u32(); const listName = r.cstr(256);
    const mats = [];
    for (let i = 0; i < count; i++) {
      const name = r.str16();
      const f = new Float32Array(r.buf.slice(r.p, r.p + 100)); const flags = r.dv.getUint32(r.p + 4, true);
      const nStages = r.dv.getUint32(r.p + 80, true) & 255, rb = new Uint8Array(r.buf, r.p + 0x4c, 4); r.skip(100);
      let tex = '', addrU = 1, addrV = 1;
      for (let s = 0; s < nStages; s++) { if (!s) { addrU = r.dv.getUint8(r.p + 7); addrV = r.dv.getUint8(r.p + 8); } r.skip(44); const t = r.cstr(16); if (!s) tex = t; }
      mats.push({
        name, tex: tex || name, flags, transparent: !!(flags & 0x10000000),
        diffuse: [f[2], f[3], f[4], f[5]], specular: [f[10], f[11], f[12], f[13]], emissive: [f[14], f[15], f[16], f[17]], power: f[18],
        alphaRef: rb[0], alphaFunc: rb[1], srcBlend: rb[2], dstBlend: rb[3], addrU, addrV,
        w: f[21], h: f[22], px: f[23], py: f[24],   // material+0x88/0x8c: sprite size (type 3); +0x90/0x94: screen size of the zone picture (type 6, FUN_00417040)
      });
    }
    return { listName: listName.toLowerCase().replace(/\\/g, '/'), mats };
  }
  function readSoundDef(r) { const name = r.str16(); const p = []; for (let i = 0; i < 8; i++) p.push(r.u32()); return { name, p }; }
  function readObjDef(r) {
    const name = r.str16(); const p = []; for (let i = 0; i < 7; i++) p.push(r.u32());
    const dv = new DataView(new Uint32Array(p).buffer);
    const sound = readSoundDef(r);
    return { name, kind: p[1], shape: p[2], c1: dv.getFloat32(12, true), c2: dv.getFloat32(16, true), sound };
  }
  function readMObjDef(r) { const name = r.str16(); const f = r.f32s(9); const sound = readSoundDef(r); return { name, sound, kind: 0, shape: 0, c1: 0, c2: 0, mass: f[1], inertia: [f[2], f[3], f[4]] }; }   // FUN_00420360: def+0x14.. = mass, inertia x/y/z (metdur 100, 100/100/100)
  function readMesh(r) {
    r.u32(); const nv = r.u32(), nt = r.u32(), ns = r.u32(); r.skip(24 + 16);
    const vbuf = r.buf.slice(r.p, r.p + 32 * nv); r.skip(32 * nv);
    const vf = new Float32Array(vbuf);
    const idx = r.u16s(nt * 3);
    const subsets = [];
    for (let i = 0; i < ns; i++) subsets.push({ mat: r.u32(), start: r.u32(), count: r.u32(), v0: r.u32(), vn: r.u32() });
    return { nv, nt, vf, idx, subsets };
  }

  function parseCit(buf) {
    const r = new Reader(buf);
    if (r.u32() !== 0x31544943) throw new Error('not CIT1');
    r.p = 0x8c; const nBlocks = r.u32(); r.p = 0x90;
    const lists = [readMaterialList(r), readMaterialList(r), readMaterialList(r)];
    const sounds = []; for (let n = r.u32(), i = 0; i < n; i++) sounds.push(readSoundDef(r));
    const mobjDefs = []; for (let n = r.u32(), i = 0; i < n; i++) mobjDefs.push(readMObjDef(r));
    const objDefs = []; for (let n = r.u32(), i = 0; i < n; i++) objDefs.push(readObjDef(r));
    const plakDefs = []; for (let n = r.u32(), i = 0; i < n; i++) plakDefs.push(readObjDef(r));
    const blocks = [];
    for (let b = 0; b < nBlocks; b++) {
      const f0 = r.u32(); const f = r.f32s(10);
      const nA = r.u16(), nColl = r.u16(), nB = r.u16(), nObj = r.u16(), nPath = r.u16(), nNb = r.u16();
      const blk = { f0, min: f.slice(0, 3), max: f.slice(3, 6), sphere: f.slice(6, 10), meshes: [], objs: [], colls: [], paths: [], dw: [] };
      blk.meshes.push(readMesh(r)); for (let i = 0; i < nA; i++) blk.meshes.push(readMesh(r)); for (let i = 0; i < nB; i++) blk.meshes.push(readMesh(r));
      for (let i = 0; i < nObj; i++) {
        const type = r.u32(); const m = r.f32s(12); const pos = r.f32s(3); r.skip(4); const id = r.u32(), bb = r.u32(); const r0 = r.u8(), r1 = r.u8(); r.skip(6);
        blk.objs.push({ type, m, pos, id, b: bb, r0, r1 });   // r0/r1 (record bytes 0x4c/0x4d): zone trigger / release radius of types 6-8 (FUN_00417140)
      }
      for (let i = 0; i < nColl; i++) {
        const nv = r.u32(), nt = r.u32(); r.skip(24); const verts = r.f32s(nv * 3); const idx = r.u16s(nt * 3);
        blk.colls.push({ verts, idx });
      }
      for (let i = 0; i < nPath; i++) {
        const flags = r.u32() >>> 0; const nPts = r.u16(); r.u16(); const length = r.f32(), width = r.f32(); const nPrev = r.u8(), nNext = r.u8(); r.u16();   // flags: path+0xc in memory (minimap FUN_00428c80 draws 0x20000000 / 0x80000000 paths)
        const pts = r.f32s(nPts * 3); const prev = [], next = [];
        for (let k = 0; k < nPrev; k++) prev.push(r.u32()); for (let k = 0; k < nNext; k++) next.push(r.u32());
        blk.paths.push({ pts, length, width, prev, next, flags });
      }
      for (let i = 0; i < nNb; i++) blk.dw.push(r.u32());
      blocks.push(blk);
    }
    const spawns = []; for (let n = r.u32(), i = 0; i < n; i++) { const block = r.u32(); spawns.push({ block, m: r.f32s(16) }); }
    return { lists, sounds, mobjDefs, objDefs, plakDefs, blocks, spawns, end: r.p };
  }

  // ---------- spatial grids for ground + walls ----------
  const CELL = 12;
  class Grid {
    constructor() { this.m = new Map(); }
    key(cx, cz) { return cx * 4096 + cz; }
    add(item, x0, z0, x1, z1) {
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
        for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
          const k = this.key(cx, cz); let a = this.m.get(k); if (!a) this.m.set(k, a = []); a.push(item);
        }
    }
    at(x, z) { return this.m.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL))); }
  }

  function applyMapToMaterial(mat, tex) { YD.setMap(mat, tex); }   // flag material: colour stays the diffuse (MODULATE), alpha only via its ALPHATEST/BLEND flags

  async function load(vfs, scene, msg, state) {
    await msg('Reading city file…');
    const cit = parseCit(await vfs.bytes('yerevan.cit')); if (vfs.drop) vfs.drop('yerevan.cit');   // parseCit copies what it keeps
    await msg('Preparing textures…');
    const texCity = await YD.TexSet.load(vfs, 'Graph/CITMAT.ATX');
    const texOth = await YD.TexSet.load(vfs, 'Graph/othtex.tex');
    const texPlak = await YD.TexSet.load(vfs, 'Graph/plakats.tex');
    const texObj = await YD.TexSet.load(vfs, 'Graph/objects.tex');
    const texMObj = await YD.TexSet.load(vfs, 'Graph/mobjects.tex');
    const sets = [texCity, texOth, texPlak];
    for (const ts of [texCity, texOth, texPlak, texObj, texMObj]) ts.free = true;   // only the game renderer draws the city: drop CPU copies after upload

    const root = new THREE.Group(); root.scale.x = -1; scene.add(root);
    scene.fog = null; scene.background = new THREE.Color(0xb4cde6);

    // materials (lazy textures)
    const mk = d => YD.flagMaterial(d, null);   // flag word -> D3D states (FUN_00406740): cull, z-write, alpha test/ref, blend, lighting, specular
    const cityMats = cit.lists[0].mats.map(d => { const m = mk(d); Object.assign(m.userData, { d, state: 0 }); return m; });
    const plakMats = cit.lists[2].mats.map(d => { const m = mk(d); Object.assign(m.userData, { d, state: 0 }); return m; });
    function wantTex(mat, set) {
      const u = mat.userData; if (!u || u.state) return; u.state = 1;
      set.get(u.d.tex).then(t => { if (t) applyMapToMaterial(mat, t); });
    }

    // block geometry
    const blockInfo = [];
    cit.blocks.forEach((blk, bi) => {
      const g = new THREE.Group(); g.visible = false; root.add(g);
      const used = new Set();
      for (const m of blk.meshes) {
        const geo = new THREE.BufferGeometry();
        const vb = new THREE.InterleavedBuffer(m.vf, 8);
        geo.setAttribute('position', new THREE.InterleavedBufferAttribute(vb, 3, 0));
        geo.setAttribute('normal', new THREE.InterleavedBufferAttribute(vb, 3, 3));
        geo.setAttribute('uv', new THREE.InterleavedBufferAttribute(vb, 2, 6));
        geo.setIndex(new THREE.BufferAttribute(m.idx, 1));
        const list = [];
        m.subsets.forEach(s => { geo.addGroup(s.start * 3, s.count * 3, list.length); list.push(cityMats[s.mat] || cityMats[0]); used.add(s.mat); });
        const mesh = new THREE.Mesh(geo, list); mesh.frustumCulled = true;
        geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(blk.sphere[0], blk.sphere[1], blk.sphere[2]), blk.sphere[3]);
        g.add(mesh);
      }
      blockInfo.push({ g, used, blk, objs: null });
    });

    // static objects
    const INSTANCING = !/[?&]noinst/.test(location.search);
    await msg('Placing objects…');
    const loadRef = async (path, texset) => { const ref = YD.parseRef(await vfs.bytes(path)); if (vfs.drop) vfs.drop(path); const built = await YD.buildRef(ref, [texset], { doubleSided: false }); return built; };
    const objRef = await loadRef('Graph/objects.ref', texObj);
    const mobjRef = await loadRef('Graph/mobjects.ref', texMObj);
    const plakRef = await loadRef('Graph/plakats.ref', texPlak);
    // Textures for object materials load lazily too: buildRef awaits them. (they are small)
    const findPart = (built, name) => { const k = Object.keys(built.parts).find(n => n.toLowerCase() === name.toLowerCase()); return k ? built.parts[k] : null; };
    const colliders = new Grid();
    const tmpM = new THREE.Matrix4();
    function placement(rec) {
      const a = new Float32Array(16);
      a.set(rec.m.subarray(0, 4), 0); a.set(rec.m.subarray(4, 8), 4); a.set(rec.m.subarray(8, 12), 8);
      a[12] = rec.pos[0]; a[13] = rec.pos[1]; a[14] = rec.pos[2]; a[15] = 1;
      return new THREE.Matrix4().fromArray(a);
    }
    // ---- movable objects (CIT object type 2: metro doors 'metdur', cola machines, ...): FUN_00420360 makes each a free rigid body of the car base class (FUN_0041d0d0,
    // no hinge): mass / inertia from the MObjDef (metdur 100 kg, 100/100/100), box = the '<name>_bound' frame (FUN_00420d60; mobjects.ref has none, so FUN_00420280
    // takes the mesh's own AABB, mesh+0x48/+0x54). Update FUN_00420460: v += (0,-9.8,0) dt, integrate, FUN_0041f900 box vs box against every car near it (the cars'
    // updates test it too), world contact FUN_0041e930(self, 0) = the 8 corner rays (bodyContacts); asleep after 0.5 s with |v|^2, |w|^2 < 0.1 (FUN_00407490), woken
    // by a contact impulse (FUN_0041fdf0). m.p / m.v / m.w (world angular velocity) are D3D space, m.q = the turn applied to the placement R0.
    const movers = [], boxCache = new Map(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _pv = new THREE.Vector3();
    function registerMover(rec, holder, part, pm, def) {
      let bnd = boxCache.get(part); if (!bnd) {
        const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9], o = meshesOf(part)[0], a = o && o.geometry.attributes.position;
        if (a) for (let i = 0; i < a.count; i++) for (let k = 0; k < 3; k++) { const v = a.array[i * a.itemSize + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
        bnd = mx[0] > mn[0] ? { min: mn, max: mx } : { min: [-0.3, 0, -0.3], max: [0.3, 1, 0.3] }; boxCache.set(part, bnd);
      }
      const R0 = pm.clone(); R0.setPosition(0, 0, 0); const ok = v => v > 1 && v < 1e5, mass = ok(def.mass) ? def.mass : 100, I = (def.inertia || []).map(v => ok(v) ? v : 100);
      const b = Object.assign(Object.create(global.YDPhysOrig.OrigCarPhysics.prototype), { pos: new THREE.Vector3(), vel: new THREE.Vector3(), _p: [0, 0, 0], _v: [0, 0, 0], _r: [1, 0, 0], _u: [0, 1, 0], _f: [0, 0, 1], _w: [0, 0, 0], _init: true, par: { mass, inertia: I.length === 3 ? I : [100, 100, 100] }, bnd, mover: true });
      movers.push({ holder, R0, R0n: new THREE.Matrix4().extractRotation(R0), home: [rec.pos[0], rec.pos[1], rec.pos[2]], p: new THREE.Vector3(rec.pos[0], rec.pos[1], rec.pos[2]), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), asleep: true, rest: 0, mass, b, r: Math.max(bnd.max[0] - bnd.min[0], bnd.max[2] - bnd.min[2]) * 0.5 });
    }
    function toBody(m) {   // mover state -> its body (three-space pos / vel as OrigCarPhysics, D3D internals, body-frame angular velocity)
      const b = m.b, p = m.p, v = m.v, w = m.w; b.pos.set(-p.x, p.y, p.z); b._p = [p.x, p.y, p.z]; b.vel.set(-v.x, v.y, v.z); b._v = [v.x, v.y, v.z];
      const e = _m.makeRotationFromQuaternion(m.q).multiply(m.R0n).elements; b._r = [e[0], e[1], e[2]]; b._u = [e[4], e[5], e[6]]; b._f = [e[8], e[9], e[10]];
      b._w = [w.x * e[0] + w.y * e[1] + w.z * e[2], w.x * e[4] + w.y * e[5] + w.z * e[6], w.x * e[8] + w.y * e[9] + w.z * e[10]];
    }
    function fromBody(m) {
      const b = m.b, r = b._r, u = b._u, f = b._f, w = b._w; m.p.set(-b.pos.x, b.pos.y, b.pos.z); m.v.set(-b.vel.x, b.vel.y, b.vel.z);
      m.w.set(w[0] * r[0] + w[1] * u[0] + w[2] * f[0], w[0] * r[1] + w[1] * u[1] + w[2] * f[1], w[0] * r[2] + w[1] * u[2] + w[2] * f[2]);
      _m.set(r[0], u[0], f[0], 0, r[1], u[1], f[1], 0, r[2], u[2], f[2], 0, 0, 0, 0, 1).multiply(_m2.copy(m.R0n).transpose()); m.q.setFromRotationMatrix(_m).normalize();
    }
    const near = (m, c, d) => Math.abs(-c.pos.x - m.p.x) < d && Math.abs(c.pos.z - m.p.z) < d && Math.abs(c.pos.y - m.p.y) < 4;
    function touch(m, c, h) { const O = global.YDPhysOrig; return O.collideCars(m.b, c, h) + O.collideCars(c, m.b, h); }   // FUN_0041f900 from both bodies' updates
    function updateMovers(dt, cars) {
      if (!movers.length || !(dt > 0)) return; dt = Math.min(dt, 0.2); cars = cars.filter(c => c && c.pos);   // 0.2 = game.js frameTime cap (doors keep real time with the cars below 10 fps)
      const n = Math.ceil(dt / 0.02), h = dt / n;   // physics frames of at most 0.02 s (FUN_00436cb0)
      for (const m of movers) {
        if (m.asleep) {   // a sleeping body only reacts to a contact (FUN_0041fdf0 wakes it)
          let J = 0; for (const c of cars) if (near(m, c, 4 + m.r)) { if (!J) toBody(m); J += touch(m, c, dt); }
          if (!J) continue; fromBody(m); m.asleep = false; m.rest = 0;
        }
        toBody(m); const b = m.b, p0 = m.p.clone(), q0 = m.q.clone();
        for (let k = 0; k < n; k++) {
          b.vel.y -= 9.8 * h; b._v = [-b.vel.x, b.vel.y, b.vel.z]; b._rotate(b._w[0] * h, b._w[1] * h, b._w[2] * h); b.pos.addScaledVector(b.vel, h); b._p = [-b.pos.x, b.pos.y, b.pos.z];   // FUN_0041d1b0
          for (const c of cars) if (near(m, c, 4 + m.r)) touch(m, c, h);
          for (const o of movers) if (o !== m && Math.abs(o.p.x - m.p.x) < 3 && Math.abs(o.p.z - m.p.z) < 3 && Math.abs(o.p.y - m.p.y) < 3) { toBody(o); if (touch(o, m.b, h) && o.asleep) { o.asleep = false; o.rest = 0; } fromBody(o); }
          bodyContacts(b, h, false);
        }
        fromBody(m);
        // DEVIATION (sleep): the original tests |v|^2, |w|^2 < 0.1; with its 10 %-per-frame contact impulse a resting body keeps ~0.5-1.6 m/s into the floor (pushed back
        // every frame), so the test here uses the frame's actual motion instead
        const mv = m.p.distanceTo(p0) / dt, tw = 2 * Math.acos(Math.min(1, Math.abs(m.q.dot(q0)))) / dt;
        if (mv * mv < 0.1 && tw * tw < 0.1) { if ((m.rest += dt) > 0.5) { m.asleep = true; m.rest = 0; m.v.set(0, 0, 0); m.w.set(0, 0, 0); } } else m.rest = 0;
        if (!(m.p.y > m.home[1] - 20) || !isFinite(m.p.x + m.p.z)) { m.p.set(m.home[0], m.home[1], m.home[2]); m.q.set(0, 0, 0, 1); m.v.set(0, 0, 0); m.w.set(0, 0, 0); m.asleep = true; }   // never falls forever: back home below the world
        _m.makeRotationFromQuaternion(m.q).multiply(m.R0).setPosition(m.p.x, m.p.y, m.p.z);
        m.holder.matrix.copy(_m); m.holder.matrixWorldNeedsUpdate = true;
      }
    }
    // ---- object LOD (lists 0x74 static/posters, 0x8c movers: FUN_004221f0 -> FUN_00419390 / FUN_004192e0): ratio = min(radius, 12) / |eye - centre|;
    // ratio <= 0.25 S culled, <= 0.35 S LOD 2 (queued for the sorted alpha pass and faded: alpha * min(1, (radius/d - 0.25 S) / (0.1 S)), FUN_00406740
    // forces blending when the fade < 1), <= S LOD 1, else LOD 0. S = 0.125 / 0.09 / 0.068 for ViewDistance 0/1/2 (FUN_00414000, DAT_004a8150..58).
    // LOD meshes = the mesh children of the object mesh (_lo, _lo_lo); a shorter chain keeps its last mesh (FUN_00404a00).
    const LOD_S = [0.125, 0.09, 0.068], fadeCache = new Map(), _lc = new THREE.Vector3();
    const fadeList = (list, inst, q) => list.map(m => { const k = m.uuid + (inst ? 'i' : q); let f = fadeCache.get(k); if (!f) fadeCache.set(k, f = YD.fadeMaterial(m, q / 8, inst)); return f; });
    const meshesOf = part => { const a = []; part.traverse(o => { if (o.isMesh) a.push(o); }); return a; };   // a[0] = the object's own mesh (def+100)
    const lodOf = o => { const L = o.ydLods || [], g1 = L[0] || null, g2 = L[1] || g1; return { g: [o.geometry, g1 ? g1.geo : o.geometry, g2 ? g2.geo : o.geometry], l: [o.material, g1 ? g1.list : o.material, g2 ? g2.list : o.material] }; };
    const pcCache = new Map();
    function partCentre(part) {   // centre (part space) and radius of the object's own mesh (FUN_00419280: obj+0x20 = mesh radius, centre transformed by the placement)
      if (pcCache.has(part)) return pcCache.get(part);
      const o = meshesOf(part)[0], b = o && o.userData.bounds; let res = null;
      if (b) { const saved = part.parent; part.parent = null; part.updateMatrixWorld(true); res = { c: new THREE.Vector3(b[0], b[1], b[2]).applyMatrix4(o.matrixWorld), r: b[3] }; part.parent = saved; part.updateMatrixWorld(true); }
      pcCache.set(part, res); return res;
    }
    function lodLevel(cx, cy, cz, r, ex, ey, ez, S, out) {   // -> -1 culled, 0..2; out[0] = fade
      const d = Math.max(1e-3, Math.hypot(ex - cx, ey - cy, ez - cz)), q = Math.min(r, 12) / d; out[0] = Math.min(1, (r / d - 0.25 * S) / (0.1 * S));
      return q <= 0.25 * S ? -1 : q <= 0.35 * S ? 2 : q <= S ? 1 : 0;
    }
    function updateSet(set, ex, ey, ez, S, out) {   // instanced kind of a block: LOD per instance, re-pack the per-LOD instance lists when one changes
      const cen = set.cen; let changed = false;
      for (let n = 0; n < set.n; n++) { const L = lodLevel(cen[n * 3], cen[n * 3 + 1], cen[n * 3 + 2], set.r, ex, ey, ez, S, out); set.fade[n] = out[0]; if (L !== set.lev[n]) { set.lev[n] = L; changed = true; } }
      if (changed) {
        set.ord2 = []; for (let n = 0; n < set.n; n++) if (set.lev[n] === 2) set.ord2.push(n);
        for (const me of set.meshes) {
          const cnt = [0, 0, 0];
          for (let n = 0; n < set.n; n++) { const L = set.lev[n]; if (L < 0) continue; const t = L === 1 && me.same1 ? 0 : L; me.ims[t].im.instanceMatrix.array.set(me.M.subarray(n * 16, n * 16 + 16), cnt[t]++ * 16); }
          me.ims.forEach((o, t) => { o.im.count = cnt[t]; o.im.visible = cnt[t] > 0; if (cnt[t]) o.im.instanceMatrix.needsUpdate = true; });
        }
      }
      if (set.ord2 && set.ord2.length) for (const me of set.meshes) { const fa = me.ims[2].fa; set.ord2.forEach((n, k) => { fa.array[k] = Math.max(0, set.fade[n]); }); fa.needsUpdate = true; }
    }
    let nObj = 0;
    blockInfo.forEach((bi, i) => {
      const og = new THREE.Group(); bi.g.add(og); const instSets = {}; bi.lodSets = []; bi.lodHolders = [];
      for (const rec of bi.blk.objs) {
        let def, built, kind = 0;
        if (rec.type === 0) { def = cit.objDefs[rec.id]; built = objRef; }
        else if (rec.type === 1) { def = cit.plakDefs[rec.id]; built = plakRef; }
        else if (rec.type === 2) { def = cit.mobjDefs[rec.id]; built = mobjRef; }
        else continue;
        if (!def) continue;
        const part = findPart(built, def.name); if (!part) continue;
        const pm = placement(rec);
        if (rec.type !== 1 && rec.type !== 2 && INSTANCING) { const key = rec.type + ':' + def.name; (instSets[key] = instSets[key] || { part, mats: [] }).mats.push(pm); }   // repeated objects: one InstancedMesh per kind and block
        else {
        const holder = new THREE.Group(); holder.matrixAutoUpdate = false; holder.matrix.copy(pm);
        const inst = part.clone(true);
        if (rec.type === 1) {
          const pm2 = plakMats[rec.b]; // poster face = material 1 (4 triangles); material 0 is the frame/pole
          if (pm2) { wantTex(pm2, texPlak); inst.traverse(o => { if (o.isMesh) o.material = o.material.map((m, k) => k === 1 ? pm2 : m); }); }
        }
        holder.add(inst); og.add(holder);
        if (rec.type === 2) registerMover(rec, holder, part, pm, def);
        { const src = meshesOf(part), dst = meshesOf(inst), pc = partCentre(part);   // LOD / fade entry (centre follows holder.matrix: movers move)
          if (pc) bi.lodHolders.push({ holder, c: pc.c, r: pc.r, lev: 0, q: 8, ms: dst.map((m, k) => ({ m, lod: src[k] && src[k].ydLods ? lodOf(src[k]) : { g: [m.geometry, m.geometry, m.geometry], l: [m.material, m.material, m.material] } })) }); }
        }
        nObj++;
        // collider (round or oriented segment) for static solid objects
        if (rec.type === 0 && def.shape) {
          const x = rec.pos[0], z = rec.pos[2];
          if (def.shape === 1 && def.c1 > 0.05 && def.c1 < 10) colliders.add({ round: true, x, z, r: def.c1, y0: rec.pos[1] }, x - def.c1 - 1.5, z - def.c1 - 1.5, x + def.c1 + 1.5, z + def.c1 + 1.5);
          // shape 2 = oriented box (bus stop 'kangar' 0.2 x 4, phone booths 'telbudka' 1 x 0.4, kiosk 'budka2' 2 x 2): full width c1 along the object's local x, length c2 along its local z, centred on the origin
          else if (def.shape === 2 && def.c1 > 0.01 && def.c2 > 0.01 && def.c1 < 30 && def.c2 < 30) {
            const m = rec.m, sx = Math.hypot(m[0], m[2]) || 1, sz = Math.hypot(m[8], m[10]) || 1, ax = m[0] / sx, az = m[2] / sx, bx = m[8] / sz, bz = m[10] / sz, hw = def.c1 / 2 * sx, hl = def.c2 / 2 * sz, e = Math.hypot(hw, hl) + 1.5;
            colliders.add({ box: true, x, z, ax, az, bx, bz, hw, hl, y0: rec.pos[1], y1: rec.pos[1] + 2.5 }, x - e, z - e, x + e, z + e);
          }
        }
      }
      for (const k in instSets) {   // build the instanced meshes of this block: per mesh one InstancedMesh per LOD (counts/matrices rewritten when the LODs change)
        const { part, mats } = instSets[k], pc = partCentre(part); const saved = part.parent; part.parent = null; part.updateMatrixWorld(true);
        const set = { n: mats.length, r: pc ? pc.r : 1, cen: new Float32Array(mats.length * 3), lev: new Int8Array(mats.length).fill(-2), fade: new Float32Array(mats.length), meshes: [] };
        mats.forEach((pm, n) => { const v = (pc ? _lc.copy(pc.c) : _lc.set(0, 0, 0)).applyMatrix4(pm); set.cen[n * 3] = v.x; set.cen[n * 3 + 1] = v.y; set.cen[n * 3 + 2] = v.z; });
        part.traverse(o => {
          if (!o.isMesh) return;
          // own geometry objects sharing the buffers, so each instanced mesh can carry its own bounding sphere (frustum culling of the whole set)
          const g0 = o.geometry; if (!g0.boundingSphere) g0.computeBoundingSphere();
          const tmp = new THREE.Matrix4(), c = new THREE.Vector3(), pos = [], M = new Float32Array(mats.length * 16);
          mats.forEach((pm, n) => { tmp.multiplyMatrices(pm, o.matrixWorld); tmp.toArray(M, n * 16); pos.push(new THREE.Vector3().setFromMatrixPosition(tmp)); c.add(pos[n]); });
          c.multiplyScalar(1 / mats.length); let r = 0; for (const q of pos) r = Math.max(r, q.distanceTo(c));
          const sc = Math.max(...mats.map(m => m.getMaxScaleOnAxis()), 1), lod = lodOf(o), ims = [];
          for (let L = 0; L < 3; L++) {
            const gs = lod.g[L], g2 = new THREE.BufferGeometry(); g2.index = gs.index; g2.attributes = Object.assign({}, gs.attributes); g2.groups = gs.groups;
            if (!gs.boundingSphere) gs.computeBoundingSphere();
            g2.boundingSphere = new THREE.Sphere(c, r + Math.max(gs.boundingSphere.radius, g0.boundingSphere.radius) * sc * 1.2 + 1);
            let fa = null; if (L === 2) { fa = new THREE.InstancedBufferAttribute(new Float32Array(mats.length).fill(1), 1); fa.setUsage(THREE.DynamicDrawUsage); g2.setAttribute('ydFade', fa); }
            const im = new THREE.InstancedMesh(g2, L === 2 ? fadeList(lod.l[2], true) : lod.l[L], mats.length); im.count = 0; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            im.frustumCulled = true; im.visible = false; og.add(im); ims.push({ im, fa });
          }
          set.meshes.push({ M, ims, same1: lod.g[1] === lod.g[0] && lod.l[1] === lod.l[0] });   // no _lo mesh: LOD 1 instances stay in the LOD 0 draw
        });
        part.parent = saved; part.updateMatrixWorld(true);
        bi.lodSets.push(set);
      }
      bi.og = og;
    });

    // ---- sprites (CIT object type 3: FUN_004197e0, drawn by 0x419840 -> FUN_00406ce0): othtex material rec.id (list DAT_004b0e9c), unit quad (device VB
    // +0x2c68, D3D uvs) scaled w x h (material+0x88/+0x8c), raised h/2 so it stands on its position, turned about Y to face along the view direction (matrix
    // device+0x2b50 = RotationY of the view heading, the same for every sprite). In list 0x74, so the LOD rule above with radius w + h (culled only; the fade
    // 0x419840 computes is passed to FUN_00406ce0, which does not use it)
    const othMats = cit.lists[1].mats.map(d => { const m = mk(d); m.side = THREE.DoubleSide; Object.assign(m.userData, { d, state: 0 }); return m; });
    const quad = new THREE.BufferGeometry();
    quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0]), 3));
    quad.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
    quad.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 1, 1, 0]), 2)); quad.setIndex([0, 2, 1, 1, 2, 3]);
    const sprGroup = new THREE.Group(); scene.add(sprGroup); let nSpr = 0;   // three space (x already mirrored)
    blockInfo.forEach(bi => { bi.sprites = []; for (const rec of bi.blk.objs) {
      const d = rec.type === 3 && cit.lists[1].mats[rec.id]; if (!d || !(d.w > 0 && d.h > 0)) continue;   // tup9 (id 2, 6 records) has size 0: never drawn
      const s = new THREE.Mesh(quad, othMats[rec.id]); s.scale.set(d.w, d.h, 1); s.position.set(-rec.pos[0], rec.pos[1] + d.h * 0.5, rec.pos[2]); s.visible = false; sprGroup.add(s);
      bi.sprites.push({ s, mat: othMats[rec.id], x: rec.pos[0], y: rec.pos[1] + d.h * 0.5, z: rec.pos[2], r: d.w + d.h }); nSpr++;
    } });
    // ---- zones (CIT object types 6/7/8 -> FUN_00416fe0 + FUN_00417140, block list 0xd4): every 4th frame, while no zone is active, the player's car within r0 m
    // (record byte 0x4c) of a zone activates it (FUN_004226f0; slot 4 = 0x4171f0: timer 4 s, plays its sound); it ends when the timer ran out and the car is
    // more than r1 m away (byte 0x4d). A type-6 zone shows its othtex picture at the top right of the screen (0x417040 -> FUN_004078f0: x 1-w..1, y -1..-1+h
    // in screen units of 2, w/h = material+0x90/+0x94), alpha 255 with 0.3 s fades (timer*850). Sounds of types 7/8 are left to the ambience code.
    const zones = []; let zoneOn = null, zoneFrame = 0;
    blockInfo.forEach(bi => bi.blk.objs.forEach(rec => { if (rec.type >= 6 && rec.type <= 8) zones.push({ x: rec.pos[0], y: rec.pos[1], z: rec.pos[2], r0: rec.r0, r1: rec.r1, t: 0, d: rec.type !== 7 ? cit.lists[1].mats[rec.id] || null : null }); }));
    const popMat = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide }), popup = new THREE.Mesh(quad, popMat);
    popup.renderOrder = 10000; popup.frustumCulled = false; popup.visible = false; popup.layers.set(1); scene.add(popup);   // layer 1: main camera only (not the reflection cubes)
    const _pq = new THREE.Vector3();
    function updateZones(dt, phys, camera) {
      zoneFrame++;
      if (zoneOn) { zoneOn.t = Math.max(0, zoneOn.t - dt); if (zoneOn.t <= 0 && phys && Math.hypot(-phys.pos.x - zoneOn.x, phys.pos.y - zoneOn.y, phys.pos.z - zoneOn.z) > zoneOn.r1) zoneOn = null; }
      if (!zoneOn && phys && (zoneFrame & 3) === 0) for (const z of zones) if (Math.hypot(-phys.pos.x - z.x, phys.pos.y - z.y, phys.pos.z - z.z) < z.r0) { zoneOn = z; z.t = 4; break; }
      const z = zoneOn, d = z && z.d; popup.visible = !!(d && z.t > 0 && d.px > 0 && d.py > 0);
      if (!popup.visible) return;
      if (popMat.userData.tex !== d.tex) { popMat.userData.tex = d.tex; popMat.map = null; texOth.get(d.tex).then(t => { if (popMat.userData.tex === d.tex) { popMat.map = t; popMat.needsUpdate = true; } }); popMat.needsUpdate = true; }
      popMat.opacity = (z.t < 0.3 ? z.t * 850 : z.t > 3.7 ? (4 - z.t) * 850 : 255) / 255; popup.visible = !!popMat.map;
      const D = 1.0, hh = D * Math.tan(camera.fov * Math.PI / 360), hw = hh * camera.aspect;   // quad 1 m in front of the eye covering the NDC rectangle
      camera.layers.enable(1); popup.quaternion.copy(camera.quaternion);
      popup.position.copy(camera.position).add(_pq.set((1 - d.px / 2) * hw, (1 - d.py / 2) * hh, -D).applyQuaternion(camera.quaternion));
      popup.scale.set(d.px * hw, d.py * hh, 1);
    }

    // materials used by objects (already loaded by buildRef)
    // ambient sound emitters (types 7 and 10) and road polylines
    const emitters = [];
    blockInfo.forEach(bi => bi.blk.objs.forEach(rec => {
      if (rec.type !== 7 && rec.type !== 10) return;
      const sd = cit.sounds[rec.id]; if (!sd) return;
      const dv = new DataView(new Uint32Array(sd.p).buffer);
      emitters.push({ x: -rec.pos[0], y: rec.pos[1], z: rec.pos[2], name: sd.name.toLowerCase(), min: dv.getFloat32(8, true) || 10, max: dv.getFloat32(12, true) || 100, flags: sd.p[0] >>> 0, count: sd.p[1] || 1, every: dv.getFloat32(16, true) || 0 });   // p[0] flags, p[1] buffers/variants, p[4] repeat interval (sim.js Ambience)
    }));
    const pathLines = [];
    cit.blocks.forEach((blk, b) => blk.paths.forEach((pa, p) => {
      const n = pa.pts.length / 3; const a = new Float32Array(pa.pts.length);
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (let i = 0; i < n; i++) { a[i * 3] = -pa.pts[i * 3]; a[i * 3 + 1] = pa.pts[i * 3 + 1]; a[i * 3 + 2] = pa.pts[i * 3 + 2]; x0 = Math.min(x0, a[i * 3]); x1 = Math.max(x1, a[i * 3]); z0 = Math.min(z0, a[i * 3 + 2]); z1 = Math.max(z1, a[i * 3 + 2]); }
      pathLines.push({ b, p, pts: a, x0, x1, z0, z1, width: pa.width, length: pa.length });
    }));

    // sky dome
    let sky = null;
    if (!window.YDRender) try {
      const skyRef = await loadRef('Graph/sky.ref', await YD.TexSet.load(vfs, 'Graph/sky.tex'));
      sky = skyRef.group; sky.traverse(o => { if (o.isMesh) { o.material.forEach(m => { m.depthWrite = false; m.fog = false; m.side = THREE.DoubleSide; }); o.renderOrder = -10; o.frustumCulled = false; } });
      scene.add(sky);
    } catch (e) { console.warn('sky', e); }

    // spawn
    const sp = cit.spawns[0]; const sm = sp.m;
    const spawn = { pos: new THREE.Vector3(-sm[12], sm[13], sm[14]), yaw: -Math.atan2(sm[8], sm[10]) };
    const grid8 = cit.spawns.map(s => ({ pos: new THREE.Vector3(-s.m[12], s.m[13], s.m[14]), yaw: -Math.atan2(s.m[8], s.m[10]) }));

    // ---------- runtime ----------
    // ---- collision triangle store: every block-mesh triangle (stride 0x20, FUN_00422760) and every block collision-mesh triangle (FUN_004229f0), D3D space,
    // 12 floats each (a, b, c, unit normal of (b-a)x(c-a): floors n.y > 0, ceilings n.y < 0), indexed by one 4 m XZ grid (CSR). FUN_004231c0 collects them for
    // every body with no slope, up/down or underground filter: wheels, body corners, steep edges, movers and the camera all use these triangles (spec-metro.md 5).
    let nT = 0; for (const blk of cit.blocks) { for (const m of blk.meshes) nT += m.nt; for (const c of blk.colls) nT += c.idx.length / 3; }
    const TS = new Float32Array(nT * 12); nT = 0; let gx0 = 1e9, gz0 = 1e9, gx1 = -1e9, gz1 = -1e9;
    const putT = (v, ix, st, n) => { for (let t = 0; t < n; t++) {
      const a = ix[t * 3] * st, b = ix[t * 3 + 1] * st, c = ix[t * 3 + 2] * st, ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2], wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, l = Math.hypot(nx, ny, nz); if (!(l > 1e-9)) continue;
      const o = nT++ * 12; for (let k = 0; k < 3; k++) { TS[o + k] = v[a + k]; TS[o + 3 + k] = v[b + k]; TS[o + 6 + k] = v[c + k]; } TS[o + 9] = nx / l; TS[o + 10] = ny / l; TS[o + 11] = nz / l;
      gx0 = Math.min(gx0, v[a], v[b], v[c]); gx1 = Math.max(gx1, v[a], v[b], v[c]); gz0 = Math.min(gz0, v[a + 2], v[b + 2], v[c + 2]); gz1 = Math.max(gz1, v[a + 2], v[b + 2], v[c + 2]);
    } };
    for (const blk of cit.blocks) { for (const m of blk.meshes) putT(m.vf, m.idx, 8, m.nt); for (const c of blk.colls) putT(c.verts, c.idx, 3, c.idx.length / 3); }
    const GC = 4, GX = Math.floor(gx0 / GC), GZ = Math.floor(gz0 / GC), GW = Math.floor(gx1 / GC) - GX + 1, GH = Math.floor(gz1 / GC) - GZ + 1, cellStart = new Int32Array(GW * GH + 1);
    const triCells = (o, cb) => { const x0 = Math.floor(Math.min(TS[o], TS[o + 3], TS[o + 6]) / GC) - GX, x1 = Math.floor(Math.max(TS[o], TS[o + 3], TS[o + 6]) / GC) - GX, z0 = Math.floor(Math.min(TS[o + 2], TS[o + 5], TS[o + 8]) / GC) - GZ, z1 = Math.floor(Math.max(TS[o + 2], TS[o + 5], TS[o + 8]) / GC) - GZ;
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) cb(z * GW + x); };
    for (let i = 0; i < nT; i++) triCells(i * 12, k => cellStart[k + 1]++);
    for (let k = 0; k < GW * GH; k++) cellStart[k + 1] += cellStart[k];
    const cellTris = new Int32Array(cellStart[GW * GH]); { const fill = cellStart.slice(0, GW * GH); for (let i = 0; i < nT; i++) triCells(i * 12, k => { cellTris[fill[k]++] = i; }); }
    const stamp = new Uint32Array(nT); let qid = 0, CL = new Int32Array(4096);
    function collect(x0, y0, z0, x1, y1, z1) {   // D3D box -> number of triangles (indices in CL) whose AABB overlaps it; no allocation
      if (++qid > 0xfffffff0) { stamp.fill(0); qid = 1; }
      const cx0 = Math.max(0, Math.floor(x0 / GC) - GX), cx1 = Math.min(GW - 1, Math.floor(x1 / GC) - GX), cz0 = Math.max(0, Math.floor(z0 / GC) - GZ), cz1 = Math.min(GH - 1, Math.floor(z1 / GC) - GZ); let n = 0;
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) for (let k = cz * GW + cx, j = cellStart[k], e = cellStart[k + 1]; j < e; j++) {
        const i = cellTris[j]; if (stamp[i] === qid) continue; stamp[i] = qid; const o = i * 12;
        if (Math.max(TS[o], TS[o + 3], TS[o + 6]) < x0 || Math.min(TS[o], TS[o + 3], TS[o + 6]) > x1 || Math.max(TS[o + 1], TS[o + 4], TS[o + 7]) < y0 || Math.min(TS[o + 1], TS[o + 4], TS[o + 7]) > y1 || Math.max(TS[o + 2], TS[o + 5], TS[o + 8]) < z0 || Math.min(TS[o + 2], TS[o + 5], TS[o + 8]) > z1) continue;
        if (n === CL.length) { const g = new Int32Array(n * 2); g.set(CL); CL = g; } CL[n++] = i;
      }
      return n;
    }
    function rayTri(A, o, ox, oy, oz, dx, dy, dz) {   // D3DXIntersectTri (FUN_0043e235, two-sided) on the 9 floats at A[o] -> t >= 0, or -1
      const e1x = A[o + 3] - A[o], e1y = A[o + 4] - A[o + 1], e1z = A[o + 5] - A[o + 2], e2x = A[o + 6] - A[o], e2y = A[o + 7] - A[o + 1], e2z = A[o + 8] - A[o + 2];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x, det = e1x * px + e1y * py + e1z * pz; if (det > -1e-12 && det < 1e-12) return -1;
      const inv = 1 / det, tx = ox - A[o], ty = oy - A[o + 1], tz = oz - A[o + 2], u = (tx * px + ty * py + tz * pz) * inv; if (u < 0 || u > 1) return -1;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x, v = (dx * qx + dy * qy + dz * qz) * inv; if (v < 0 || u + v > 1) return -1;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv; return t >= 0 ? t : -1;
    }
    const RH = { i: -1, n: [0, 1, 0] };   // last rayTris hit: triangle index and its normal turned against the ray (D3D)
    function rayTris(n, ox, oy, oz, dx, dy, dz, maxT) {   // FUN_00423270: nearest of the n collected triangles along a unit ray -> t (maxT and RH.i = -1 when none is nearer)
      let best = maxT, bi = -1;
      for (let j = 0; j < n; j++) { const t = rayTri(TS, CL[j] * 12, ox, oy, oz, dx, dy, dz); if (t >= 0 && t < best) { best = t; bi = CL[j]; } }
      RH.i = bi; if (bi >= 0) { const o = bi * 12, s = TS[o + 9] * dx + TS[o + 10] * dy + TS[o + 11] * dz > 0 ? -1 : 1; RH.n[0] = TS[o + 9] * s; RH.n[1] = TS[o + 10] * s; RH.n[2] = TS[o + 11] * s; }
      return best;
    }
    // body box: 8 corners of b.bnd (raw 'bound' AABB in the body frame, car.js) around the CG (FUN_0041d300; corner bits 1 = +z, 2 = +y, 4 = +x), D3D
    const BND0 = { min: [-0.95, -0.55, -2.2], max: [0.95, 0.9, 2.2] }, OFF = new Float64Array(24), BT = new Float64Array(144), WB = new Float64Array(6);
    const BOXT = [0, 3, 2, 3, 0, 1, 4, 7, 5, 7, 4, 6, 0, 5, 1, 5, 0, 4, 1, 7, 3, 7, 1, 5, 3, 6, 2, 6, 3, 7, 2, 4, 0, 4, 2, 6];   // table 0x49ce00: the box's 12 triangles
    function boxFrame(b) {   // corner offsets (OFF) from the body axes (OrigCarPhysics / mover: _r _u _f; plain bodies: yaw only)
      let r = b._r, u = b._u, f = b._f; if (!u) { const yd = -(b.yaw || 0), s = Math.sin(yd), c = Math.cos(yd); f = [s, 0, c]; r = [c, 0, -s]; u = [0, 1, 0]; }
      const bd = b.bnd || BND0;
      for (let i = 0; i < 8; i++) { const x = i & 4 ? bd.max[0] : bd.min[0], y = i & 2 ? bd.max[1] : bd.min[1], z = i & 1 ? bd.max[2] : bd.min[2]; for (let k = 0; k < 3; k++) OFF[i * 3 + k] = r[k] * x + u[k] * y + f[k] * z; }
    }
    function boxWorld(cx, cy, cz) {   // world AABB (WB) and the 12 box triangles (BT, stride 12) at centre c
      WB[0] = WB[1] = WB[2] = 1e9; WB[3] = WB[4] = WB[5] = -1e9;
      for (let i = 0; i < 8; i++) { const x = cx + OFF[i * 3], y = cy + OFF[i * 3 + 1], z = cz + OFF[i * 3 + 2]; if (x < WB[0]) WB[0] = x; if (x > WB[3]) WB[3] = x; if (y < WB[1]) WB[1] = y; if (y > WB[4]) WB[4] = y; if (z < WB[2]) WB[2] = z; if (z > WB[5]) WB[5] = z; }
      for (let q = 0; q < 12; q++) for (let v = 0; v < 3; v++) { const c = BOXT[q * 3 + v] * 3, o = q * 12 + v * 3; BT[o] = cx + OFF[c]; BT[o + 1] = cy + OFF[c + 1]; BT[o + 2] = cz + OFF[c + 2]; }
    }
    function collectBody(b, cx, cy, cz) { boxFrame(b); boxWorld(cx, cy, cz); return collect(WB[0] - 0.3, WB[1] - 1, WB[2] - 0.3, WB[3] + 0.3, WB[4] + 0.5, WB[5] + 0.3); }   // FUN_004231c0 box: AABB - (0.3, 1, 0.3), + (0.3, 0.5, 0.3)
    // FUN_0041e930 (b) + (c) for a body with three-space pos / vel (OrigCarPhysics or a mover); returns the number of contacts
    function bodyContacts(b, dt, edges) {
      const PH = global.YDPhysOrig, p = b.pos; if (!PH) return 0; const n = collectBody(b, -p.x, p.y, p.z); if (!n) return 0; const opt = { dt: dt || 0.008 }; let hits = 0;
      for (let i = 0; i < 8; i++) {   // (b) ray from the centre to each box corner; a nearer hit moves the body out along the normal by (len - t) * |d.n| * 1.01 and applies the contact impulse at the corner
        const ox = OFF[i * 3], oy = OFF[i * 3 + 1], oz = OFF[i * 3 + 2], len = Math.hypot(ox, oy, oz); if (len < 1e-6) continue;
        const dx = ox / len, dy = oy / len, dz = oz / len, cx = -p.x, cy = p.y, cz = p.z, t = rayTris(n, cx, cy, cz, dx, dy, dz, len); if (RH.i < 0) continue;
        const N = RH.n; PH.resolveContact3D(b, [-N[0], N[1], N[2]], -(len - t) * (dx * N[0] + dy * N[1] + dz * N[2]), [-(cx + ox), cy + oy, cz + oz], opt); hits++;
      }
      if (!edges) return hits;
      let cx = -p.x, cy = p.y, cz = p.z; boxWorld(cx, cy, cz);
      for (let j = 0; j < n; j++) {   // (c) steep triangle edges (|dir.y| >= 0.7, _DAT_00484c10) against the 12 box triangles (FUN_0041d8c0), at most one edge per triangle
        const o = CL[j] * 12;
        for (let e = 0; e < 3; e++) {
          const a = o + e * 3, q = o + (e + 1) % 3 * 3, ax = TS[a], ay = TS[a + 1], az = TS[a + 2], ex = TS[q] - ax, ey = TS[q + 1] - ay, ez = TS[q + 2] - az, L = Math.hypot(ex, ey, ez);
          if (!(L > 1e-6) || Math.abs(ey) < 0.7 * L) continue;
          if (Math.min(ax, ax + ex) > WB[3] || Math.max(ax, ax + ex) < WB[0] || Math.min(ay, ay + ey) > WB[4] || Math.max(ay, ay + ey) < WB[1] || Math.min(az, az + ez) > WB[5] || Math.max(az, az + ez) < WB[2]) continue;
          const dx = ex / L, dy = ey / L, dz = ez / L; let t = L, k = -1;
          for (let bq = 0; bq < 12; bq++) { const tt = rayTri(BT, bq * 12, ax, ay, az, dx, dy, dz); if (tt >= 0 && tt < t) { t = tt; k = bq; } }
          if (k < 0) continue;
          // out along the line from the edge to the centre (FUN_00405540): 0.5 m steps while the edge still crosses that box triangle, then 6 bisections (+-0.25)
          const s0 = (cx - ax) * dx + (cy - ay) * dy + (cz - az) * dz; let nx = cx - ax - dx * s0, ny = cy - ay - dy * s0, nz = cz - az - dz * s0; const nl = Math.hypot(nx, ny, nz); if (nl < 1e-6) continue; nx /= nl; ny /= nl; nz /= nl;
          const inside = s => { const tt = rayTri(BT, k * 12, ax - nx * s, ay - ny * s, az - nz * s, dx, dy, dz); return tt >= 0 && tt < L; };
          let s = 0.5; while (inside(s) && s < 20) s += 0.5;
          for (let st = -0.25, i = 0; i < 6; i++) { s += st; st = Math.abs(st) * (inside(s) ? 0.5 : -0.5); }
          PH.resolveContact3D(b, [-nx, ny, nz], s / 1.01, [-(ax + dx * t), ay + dy * t, az + dz * t], opt); hits++;   // moved by n*s (resolveContact3D adds the 1.01), impulse at the hit point
          cx = -p.x; cy = p.y; cz = p.z; boxWorld(cx, cy, cz); break;
        }
      }
      return hits;
    }
    // (a) static objects (block+0xb0 list: poles, trees, kiosks; FUN_0041d8c0 segment test in the original): round / oriented-box colliders against 3 circles
    // along the car, the same push-out + contact impulse as the world contact (FUN_0041e7a0: 10 % of the normal velocity per frame, friction 0.5)
    function objContacts(phys, dt) {
      const PH = global.YDPhysOrig, R = 1.05, gy = phys.gy === undefined ? phys.pos.y : phys.gy; let hits = 0;
      for (let pass = 0; pass < 2; pass++) {
        const fx = Math.sin(phys.yaw), fz = Math.cos(phys.yaw);
        for (const off of [1.7, 0, -1.7]) {
          const px = phys.pos.x + fx * off, pz = phys.pos.z + fz * off, qx = -px, qz = pz, arr = colliders.at(qx, qz); if (!arr) continue;   // query in D3D space
          let best = 0, bnx = 0, bnz = 0;
          for (const s of arr) {
            let nx, nz, pen; if (s.y0 > gy + 2.2 || (s.y1 !== undefined ? s.y1 < gy + 0.3 : s.y0 < gy - 6)) continue;   // a pole of the street above the metro hall is not in the hall
            if (s.round) {
              const dx = qx - s.x, dz = qz - s.z, dist = Math.hypot(dx, dz); pen = R + s.r - dist; if (pen <= 0 || dist < 1e-6) continue; nx = dx / dist; nz = dz / dist;
            } else {   // oriented box: closest point; centre inside -> out through the nearest face
              const rx = qx - s.x, rz = qz - s.z, lu = rx * s.ax + rz * s.az, lv = rx * s.bx + rz * s.bz, cu = Math.max(-s.hw, Math.min(s.hw, lu)), cv = Math.max(-s.hl, Math.min(s.hl, lv));
              const du = lu - cu, dv = lv - cv, dist = Math.hypot(du, dv);
              if (dist > 1e-6) { pen = R - dist; if (pen <= 0) continue; nx = (du * s.ax + dv * s.bx) / dist; nz = (du * s.az + dv * s.bz) / dist; }
              else if (s.hw - Math.abs(lu) < s.hl - Math.abs(lv)) { const g = lu >= 0 ? 1 : -1; pen = R + s.hw - Math.abs(lu); nx = s.ax * g; nz = s.az * g; }
              else { const g = lv >= 0 ? 1 : -1; pen = R + s.hl - Math.abs(lv); nx = s.bx * g; nz = s.bz * g; }
            }
            if (pen > best) { best = pen; bnx = nx; bnz = nz; }
          }
          if (best > 0) {   // D3D-space normal (bnx, bnz) -> game space (-bnx, bnz)
            const gnx = -bnx, gnz = bnz; hits++;
            if (PH && PH.resolveWorldContact) PH.resolveWorldContact(phys, gnx, gnz, best / 1.01, px - gnx * R, phys.pos.y, pz - gnz * R, { dt }); else { phys.pos.x += gnx * best; phys.pos.z += gnz * best; }
          }
        }
      }
      return hits;
    }
    function ground(x3, z3, refY) {   // up-facing triangles only (n.y > 0.6: a ceiling is never ground): the height at (x, z) nearest to refY + 0.2, at most refY + 1.2
      const x = -x3, z = z3, gx = Math.floor(x / GC) - GX, gz = Math.floor(z / GC) - GZ; if (gx < 0 || gz < 0 || gx >= GW || gz >= GH) return null;
      let best = null, bd = 1e9;
      for (let k = gz * GW + gx, j = cellStart[k], e = cellStart[k + 1]; j < e; j++) {
        const o = cellTris[j] * 12; if (TS[o + 10] <= 0.6) continue;
        const ax = TS[o], ay = TS[o + 1], az = TS[o + 2], bx = TS[o + 3], by = TS[o + 4], bz = TS[o + 5], cx = TS[o + 6], cy = TS[o + 7], cz = TS[o + 8];
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(d) < 1e-9) continue;
        const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, l3 = 1 - l1 - l2;
        if (l1 < -0.001 || l2 < -0.001 || l3 < -0.001) continue;
        const y = l1 * ay + l2 * by + l3 * cy, dd = Math.abs(y - refY - 0.2);   // prefer the surface nearest (slightly above) the car
        if (y <= refY + 1.2 && dd < bd) { bd = dd; best = y; }
      }
      return best;
    }
    function roofAbove(x3, y, z3, maxD) {   // a triangle straight above (x, y, z) within maxD m (underground look: no sky)
      const x = -x3, gx = Math.floor(x / GC) - GX, gz = Math.floor(z3 / GC) - GZ; if (gx < 0 || gz < 0 || gx >= GW || gz >= GH) return false;
      for (let k = gz * GW + gx, j = cellStart[k], e = cellStart[k + 1]; j < e; j++) { const t = rayTri(TS, cellTris[j] * 12, x, y, z3, 0, 1, 0); if (t > 0.05 && t < maxD) return true; }
      return false;
    }
    // ---- camera collision triangles (FUN_00417ad0 -> FUN_00422fb0/FUN_00422f10): the same store (static objects are not in it) ----
    function camTris(x0, y0, z0, x1, y1, z1) {   // three-space box -> triangles [ax,ay,az,bx,by,bz,cx,cy,cz] in three space (x mirrored back)
      const n = collect(-x1, y0, z0, -x0, y1, z1), out = [];
      for (let j = 0; j < n; j++) { const o = CL[j] * 12; out.push([-TS[o], TS[o + 1], TS[o + 2], -TS[o + 3], TS[o + 4], TS[o + 5], -TS[o + 6], TS[o + 7], TS[o + 8]]); }
      return out;
    }
    // wheel rays for OrigCarPhysics (FUN_004111c0): collect once per step around the body at D3D centre c, then rayTris per wheel along -up
    const wheelQuery = { collect: (b, cx, cy, cz) => collectBody(b, cx, cy, cz), ray: (n, ox, oy, oz, dx, dy, dz, maxT) => rayTris(n, ox, oy, oz, dx, dy, dz, maxT), hit: RH };
    const world = {
      camTris, roofAbove, wheelQuery, nTris: nT,
      cit, root, spawn, grid8, ground, sky, blockInfo, emitters, pathLines,
      heightAt(x3, z3, phys) {
        const ref = phys ? (phys.gy === undefined ? spawn.pos.y : phys.gy) : 0;
        let y = ground(x3, z3, ref);
        if (y === null) y = ref; // off-map: keep last height
        if (phys) phys.gy = y;
        return y;
      },
      // FUN_0041e930(self, 1) for every car everywhere: (a) static objects, (b) the 8 body-box corner rays, (c) steep triangle edges against the box
      collide(phys, dt) {
        phys.hitTimer = Math.max(0, (phys.hitTimer || 0) - dt);
        if (objContacts(phys, dt) + bodyContacts(phys, dt, true)) phys.hitTimer = 0.15;
      },
      updateMovers,
      movers,
      update(dt, phys, camera) {
        const cx = -camera.position.x, cy = camera.position.y, cz = camera.position.z;
        const st = state && state.ui && state.ui.settings, vd = Math.max(0, Math.min(2, /[?&]vd=\d/.test(location.search) ? +/[?&]vd=(\d)/.exec(location.search)[1] : st && st.viewDist !== undefined ? st.viewDist | 0 : 1));
        const VD = [300, 550, 850][vd], S = LOD_S[vd], out = [0], cd = _pq.set(0, 0, -1).applyQuaternion(camera.quaternion), yaw = Math.atan2(-cd.x, -cd.z);   // sprite normal = -view heading
        for (const bi of blockInfo) {
          const s = bi.blk.sphere; const d = Math.hypot(cx - s[0], cy - s[1], cz - s[2]) - s[3];   // FUN_00414e40: |sphere centre - eye| - radius <= ViewDistance 300/550/850 m
          const vis = d <= VD; bi.g.visible = vis;
          for (const sp of bi.sprites) { const L = vis ? lodLevel(sp.x, sp.y, sp.z, sp.r, cx, cy, cz, S, out) : -1; sp.s.visible = L >= 0; if (L >= 0) sp.s.rotation.y = yaw; }
          if (vis) {
            if (!bi.loaded) { bi.loaded = true; for (const mi of bi.used) wantTex(cityMats[mi], texCity); for (const sp of bi.sprites) wantTex(sp.mat, texOth); }
            for (const set of bi.lodSets) updateSet(set, cx, cy, cz, S, out);
            for (const h of bi.lodHolders) {
              const e = h.holder.matrix.elements, c = h.c, x = e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12], y = e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13], z = e[2] * c.x + e[6] * c.y + e[10] * c.z + e[14];
              const L = lodLevel(x, y, z, h.r, cx, cy, cz, S, out), q = L === 2 ? Math.max(1, Math.min(8, Math.round(out[0] * 8))) : 8;
              h.holder.visible = L >= 0; if (L < 0 || (L === h.lev && q === h.q)) continue; h.lev = L; h.q = q;
              for (const { m, lod } of h.ms) { m.geometry = lod.g[L]; m.material = q < 8 ? fadeList(lod.l[L], false, q) : lod.l[L]; }
            }
          }
        }
        updateZones(dt, phys, camera);
        if (sky) sky.position.set(camera.position.x, camera.position.y - 20, camera.position.z);
      },
      hud(phys, el) { el.textContent = ''; },
      nearestBlock(phys) {
        const x = -phys.pos.x, z = phys.pos.z; let best = -1, bd = 1e9;
        blockInfo.forEach((bi, i) => { const s = bi.blk.sphere; const d = Math.hypot(x - s[0], z - s[2]) - s[3]; if (d < bd) { bd = d; best = i; } });
        return best;
      },
    };
    window.WORLD = world;
    // pre-load textures for the spawn area so the first frame is not grey
    for (const bi of blockInfo) { const s = bi.blk.sphere; if (Math.hypot(spawn.pos.x * -1 - s[0], spawn.pos.z - s[2]) < 350) { bi.loaded = true; for (const mi of bi.used) wantTex(cityMats[mi], texCity); for (const sp of bi.sprites) wantTex(sp.mat, texOth); } }
    spawn.pos.y = ground(spawn.pos.x, spawn.pos.z, spawn.pos.y + 1) ?? spawn.pos.y;
    spawn.gy = spawn.pos.y;
    console.log('city loaded', cit.blocks.length, 'blocks,', nObj, 'objects,', nSpr, 'sprites,', zones.length, 'zones');
    return world;
  }

  global.YDWorld = { load, parseCit };
})(window);
