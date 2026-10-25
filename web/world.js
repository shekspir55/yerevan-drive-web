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
      const nStages = r.dv.getUint32(r.p + 80, true) & 255; r.skip(100);
      let tex = '';
      for (let s = 0; s < nStages; s++) { r.skip(44); const t = r.cstr(16); if (!s) tex = t; }
      mats.push({
        name, tex: tex || name, flags, transparent: !!(flags & 0x10000000),
        diffuse: [f[2], f[3], f[4], f[5]], emissive: [f[14], f[15], f[16], f[17]], w: f[21], h: f[22],
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
  function readMObjDef(r) { const name = r.str16(); r.skip(36); const sound = readSoundDef(r); return { name, sound, kind: 0, shape: 0, c1: 0, c2: 0 }; }
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
        const type = r.u32(); const m = r.f32s(12); const pos = r.f32s(3); r.skip(4); const id = r.u32(), bb = r.u32(); r.skip(8);
        blk.objs.push({ type, m, pos, id, b: bb });
      }
      for (let i = 0; i < nColl; i++) {
        const nv = r.u32(), nt = r.u32(); r.skip(24); const verts = r.f32s(nv * 3); const idx = r.u16s(nt * 3);
        blk.colls.push({ verts, idx });
      }
      for (let i = 0; i < nPath; i++) {
        r.u32(); const nPts = r.u16(); r.u16(); const length = r.f32(), width = r.f32(); const nPrev = r.u8(), nNext = r.u8(); r.u16();
        const pts = r.f32s(nPts * 3); const prev = [], next = [];
        for (let k = 0; k < nPrev; k++) prev.push(r.u32()); for (let k = 0; k < nNext; k++) next.push(r.u32());
        blk.paths.push({ pts, length, width, prev, next });
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

  function applyMapToMaterial(mat, tex) {
    mat.map = tex; mat.color.set(0xffffff);
    if (tex.ydAlpha && !mat.transparent) { mat.alphaTest = 0.4; }
    mat.needsUpdate = true;
  }

  async function load(vfs, scene, msg, state) {
    await msg('Reading city file…');
    const cit = parseCit(await vfs.bytes('yerevan.cit'));
    await msg('Preparing textures…');
    const texCity = await YD.TexSet.load(vfs, 'Graph/CITMAT.ATX');
    const texOth = await YD.TexSet.load(vfs, 'Graph/othtex.tex');
    const texPlak = await YD.TexSet.load(vfs, 'Graph/plakats.tex');
    const texObj = await YD.TexSet.load(vfs, 'Graph/objects.tex');
    const texMObj = await YD.TexSet.load(vfs, 'Graph/mobjects.tex');
    const sets = [texCity, texOth, texPlak];

    const root = new THREE.Group(); root.scale.x = -1; scene.add(root);
    scene.fog = null; scene.background = new THREE.Color(0xb4cde6);

    // materials (lazy textures)
    const mk = (d, side) => {
      const m = new THREE.MeshLambertMaterial({ color: new THREE.Color(d.diffuse[0], d.diffuse[1], d.diffuse[2]), side: side || THREE.FrontSide });
      if (d.transparent) { m.transparent = true; m.depthWrite = false; m.opacity = Math.min(1, Math.max(0.15, d.diffuse[3])); }
      m.emissive = new THREE.Color(d.emissive[0], d.emissive[1], d.emissive[2]).multiplyScalar(0.5);
      return m;
    };
    const cityMats = cit.lists[0].mats.map(d => { const m = mk(d); m.userData = { d, state: 0 }; return m; });
    const plakMats = cit.lists[2].mats.map(d => { const m = mk(d, THREE.DoubleSide); m.userData = { d, state: 0 }; return m; });
    function wantTex(mat, set) {
      const u = mat.userData; if (!u || u.state) return; u.state = 1;
      set.get(u.d.tex).then(t => { if (t) applyMapToMaterial(mat, t); });
    }

    // block geometry
    const groundTris = new Grid(); const walls = new Grid(); const tunGrid = new Grid();   // tunGrid: every triangle (any slope) of the underground blocks, for the ray casts of the metro
    const blockInfo = [];
    const tmpV = new THREE.Vector3();
    cit.blocks.forEach((blk, bi) => {
      const g = new THREE.Group(); g.visible = false; root.add(g);
      const used = new Set();
      let bmin = 1e9; for (const m of blk.meshes) { const v = m.vf; for (let i = 1; i < v.length; i += 8) if (v[i] < bmin) bmin = v[i]; }
      const isTun = bmin < -3.4;   // underground block (metro tunnels, stations, entrance halls)
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
        // ground triangles: upward facing
        const v = m.vf, ix = m.idx;
        for (let t = 0; t < m.nt; t++) {
          const a = ix[t * 3] * 8, b = ix[t * 3 + 1] * 8, c = ix[t * 3 + 2] * 8;
          const ax = v[a], ay = v[a + 1], az = v[a + 2], bx = v[b], by = v[b + 1], bz = v[b + 2], cx = v[c], cy = v[c + 1], cz = v[c + 2];
          const ux = bx - ax, uy = by - ay, uz = bz - az, wx = cx - ax, wy = cy - ay, wz = cz - az;
          let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx; const len = Math.hypot(nx, ny, nz) || 1;
          // D3D is clockwise-front: up-facing triangles have a negative cross-product y with this order
          const ny1 = Math.abs(ny / len);
          if (isTun) tunGrid.add([ax, ay, az, bx, by, bz, cx, cy, cz], Math.min(ax, bx, cx), Math.min(az, bz, cz), Math.max(ax, bx, cx), Math.max(az, bz, cz));
          if (ny1 < 0.35 && Math.max(ay, by, cy) - Math.min(ay, by, cy) > 0.6) {
            const P3 = [[ax, ay, az], [bx, by, bz], [cx, cy, cz]], y0 = Math.min(ay, by, cy), y1 = Math.max(ay, by, cy);
            for (let e = 0; e < 3; e++) {
              const p0 = P3[e], q0 = P3[(e + 1) % 3];
              if (Math.hypot(q0[0] - p0[0], q0[2] - p0[2]) < 0.2) continue;
              walls.add({ x0: p0[0], z0: p0[2], x1: q0[0], z1: q0[2], y0, y1 }, Math.min(p0[0], q0[0]) - 1.5, Math.min(p0[2], q0[2]) - 1.5, Math.max(p0[0], q0[0]) + 1.5, Math.max(p0[2], q0[2]) + 1.5);
            }
          }
          if (ny1 > 0.6) groundTris.add([ax, ay, az, bx, by, bz, cx, cy, cz], Math.min(ax, bx, cx), Math.min(az, bz, cz), Math.max(ax, bx, cx), Math.max(az, bz, cz));
        }
      }
      // collision meshes -> wall segments (steep triangles)
      for (const c of blk.colls) {
        const v = c.verts, ix = c.idx;
        for (let t = 0; t < ix.length / 3; t++) {
          const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, cc = ix[t * 3 + 2] * 3;
          const P = [[v[a], v[a + 1], v[a + 2]], [v[b], v[b + 1], v[b + 2]], [v[cc], v[cc + 1], v[cc + 2]]];
          const ux = P[1][0] - P[0][0], uy = P[1][1] - P[0][1], uz = P[1][2] - P[0][2], wx = P[2][0] - P[0][0], wy = P[2][1] - P[0][1], wz = P[2][2] - P[0][2];
          const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx; const len = Math.hypot(nx, ny, nz) || 1;
          if (Math.abs(ny / len) < 0.5) {
            for (let e = 0; e < 3; e++) {
              const p = P[e], q = P[(e + 1) % 3];
              if (Math.hypot(q[0] - p[0], q[2] - p[2]) < 0.05) continue;
              const seg = { x0: p[0], z0: p[2], x1: q[0], z1: q[2], y0: Math.min(p[1], q[1], P[(e + 2) % 3][1]), y1: Math.max(p[1], q[1], P[(e + 2) % 3][1]) };
              walls.add(seg, Math.min(p[0], q[0]) - 1.5, Math.min(p[2], q[2]) - 1.5, Math.max(p[0], q[0]) + 1.5, Math.max(p[2], q[2]) + 1.5);
            }
          }
        }
      }
      blockInfo.push({ g, used, blk, objs: null });
    });

    // static objects
    const INSTANCING = !/[?&]noinst/.test(location.search);
    await msg('Placing objects…');
    const loadRef = async (path, texset) => { const ref = YD.parseRef(await vfs.bytes(path)); const built = await YD.buildRef(ref, [texset], { doubleSided: false }); return built; };
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
    // ---- movable objects (CIT object type 2: doors of the metro, bins, cola machines ...): dynamic bodies in the original (list DAT_004da548, car contact
    // FUN_0041d8c0 -> impulse). They stand still until a car touches them, then fly with the car's momentum, tumble and settle.
    const movers = [], boxCache = new Map();
    function registerMover(rec, holder, part, pm) {
      let half = boxCache.get(part); if (!half) { const sz = new THREE.Box3().setFromObject(part).getSize(new THREE.Vector3()); half = Math.min(2, Math.max(0.25, Math.max(sz.x, sz.z) * 0.5)); boxCache.set(part, half); }
      const R0 = pm.clone(); R0.setPosition(0, 0, 0);
      movers.push({ holder, R0, p: new THREE.Vector3(rec.pos[0], rec.pos[1], rec.pos[2]), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), r: half * (pm.getMaxScaleOnAxis() || 1), asleep: true, rest: 0, settle: 0, mass: 40 });
    }
    const _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _a = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
    function updateMovers(dt, cars) {
      if (!movers.length) return;
      dt = Math.min(dt, 0.05);
      for (const m of movers) {
        let near = false;
        for (const c of cars) { if (Math.abs(-c.pos.x - m.p.x) < 150 && Math.abs(c.pos.z - m.p.z) < 150) { near = true; break; } }
        if (!near) continue;
        // car contact: two circles along the car (D3D space: x mirrored)
        for (const c of cars) {
          const cx = -c.pos.x, cz = c.pos.z, fx = -Math.sin(c.yaw), fz = Math.cos(c.yaw);
          if (Math.abs(c.pos.y - m.p.y) > 3.2) continue;
          for (const off of [1.5, -1.5]) {
            const px = cx + fx * off, pz = cz + fz * off, dx = m.p.x - px, dz = m.p.z - pz, dist = Math.hypot(dx, dz), lim = 1.1 + m.r;
            if (dist >= lim) continue;
            const nx = dist > 1e-4 ? dx / dist : fx, nz = dist > 1e-4 ? dz / dist : fz;
            const vx = -c.vel.x, vz = c.vel.z, rel = Math.hypot(vx, vz), along = vx * nx + vz * nz;   // car velocity (D3D), speed component into the object
            m.p.x += nx * (lim - dist); m.p.z += nz * (lim - dist);
            if (along > 0.3) {
              const k = 1.1 + 0.1 * Math.random();
              m.v.set(vx * k + nx * 1.5, 1.5 + rel * 0.14 + Math.random(), vz * k + nz * 1.5);
              m.w.set(-nz * rel * 0.35 + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * rel * 0.2, nx * rel * 0.35 + (Math.random() - 0.5) * 2);
              m.asleep = false; m.rest = 0; m.settle = 0;
            } else if (m.asleep && rel < 0.3) { /* parked car: just pushed out */ }
          }
        }
        if (m.asleep) continue;
        // dynamics
        m.v.y -= 9.81 * dt; m.p.addScaledVector(m.v, dt);
        const g = ground(-m.p.x, m.p.z, m.p.y + 0.6); const gy = g === null || g === undefined ? m.p.y - 5 : g;
        let onGround = false;
        if (m.p.y <= gy) { m.p.y = gy; if (m.v.y < 0) m.v.y = -m.v.y * 0.22; onGround = true; const f = Math.max(0, 1 - 3.5 * dt); m.v.x *= f; m.v.z *= f; m.w.multiplyScalar(Math.max(0, 1 - 5 * dt)); }
        else m.w.multiplyScalar(Math.max(0, 1 - 0.3 * dt));
        const wl = m.w.length();
        if (wl > 1e-4) { _a.copy(m.w).multiplyScalar(1 / wl); _q.setFromAxisAngle(_a, wl * dt); m.q.premultiply(_q).normalize(); }
        if (onGround && m.v.lengthSq() < 0.04 && wl < 0.6) { m.rest += dt; } else m.rest = 0;
        if (m.rest > 0.4) {   // settle: lie on its flattest side, then sleep
          m.settle += dt;
          _a.copy(_up).applyQuaternion(m.q.clone().invert());          // world up in object space
          const ax = Math.abs(_a.x) > Math.abs(_a.y) && Math.abs(_a.x) > Math.abs(_a.z) ? 0 : Math.abs(_a.y) > Math.abs(_a.z) ? 1 : 2;
          const loc = new THREE.Vector3(); loc.setComponent(ax, Math.sign(_a.getComponent(ax)) || 1);
          const cur = loc.clone().applyQuaternion(m.q), fix = new THREE.Quaternion().setFromUnitVectors(cur, _up);
          m.q.premultiply(new THREE.Quaternion().slerp(fix, Math.min(1, dt * 6)));
          if (m.settle > 0.6) { m.asleep = true; m.v.set(0, 0, 0); m.w.set(0, 0, 0); }
        }
        _m.makeRotationFromQuaternion(m.q); _m.multiply(m.R0); _m.setPosition(m.p.x, m.p.y, m.p.z);
        m.holder.matrix.copy(_m); m.holder.matrixWorldNeedsUpdate = true;
      }
    }
    let nObj = 0;
    blockInfo.forEach((bi, i) => {
      const og = new THREE.Group(); bi.g.add(og); const instSets = {};
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
        if (rec.type === 2) registerMover(rec, holder, part, pm);
        }
        nObj++;
        // collider (round or oriented segment) for static solid objects
        if (rec.type === 0 && def.shape) {
          const x = rec.pos[0], z = rec.pos[2];
          if (def.shape === 1 && def.c1 > 0.05 && def.c1 < 10) colliders.add({ round: true, x, z, r: def.c1 }, x - def.c1 - 1.5, z - def.c1 - 1.5, x + def.c1 + 1.5, z + def.c1 + 1.5);
        }
      }
      for (const k in instSets) {   // build the instanced meshes of this block
        const { part, mats } = instSets[k]; const saved = part.parent; part.parent = null; part.updateMatrixWorld(true);
        part.traverse(o => {
          if (!o.isMesh) return;
          // own geometry object sharing the buffers, so each instanced mesh can carry its own bounding sphere (frustum culling of the whole set)
          const g0 = o.geometry, g2 = new THREE.BufferGeometry(); g2.index = g0.index; g2.attributes = g0.attributes; g2.groups = g0.groups;
          if (!g0.boundingSphere) g0.computeBoundingSphere();
          const im = new THREE.InstancedMesh(g2, o.material, mats.length); const tmp = new THREE.Matrix4(), c = new THREE.Vector3(), pos = [];
          mats.forEach((pm, n) => { tmp.multiplyMatrices(pm, o.matrixWorld); im.setMatrixAt(n, tmp); pos.push(new THREE.Vector3().setFromMatrixPosition(tmp)); c.add(pos[n]); });
          c.multiplyScalar(1 / mats.length); let r = 0; for (const q of pos) r = Math.max(r, q.distanceTo(c));
          const sc = Math.max(...mats.map(m => m.getMaxScaleOnAxis()), 1);
          g2.boundingSphere = new THREE.Sphere(c, r + g0.boundingSphere.radius * sc * 1.2 + 1);
          im.instanceMatrix.needsUpdate = true; im.frustumCulled = true; og.add(im);
        });
        part.parent = saved; part.updateMatrixWorld(true);
      }
      bi.og = og;
    });

    // materials used by objects (already loaded by buildRef)
    // ambient sound emitters (types 7 and 10) and road polylines
    const emitters = [];
    blockInfo.forEach(bi => bi.blk.objs.forEach(rec => {
      if (rec.type !== 7 && rec.type !== 10) return;
      const sd = cit.sounds[rec.id]; if (!sd) return;
      const dv = new DataView(new Uint32Array(sd.p).buffer);
      emitters.push({ x: -rec.pos[0], y: rec.pos[1], z: rec.pos[2], name: sd.name.toLowerCase(), min: dv.getFloat32(8, true) || 10, max: dv.getFloat32(12, true) || 100 });
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
    const camBlock = { last: 0 };
    function ground(x3, z3, refY) {
      const x = -x3, z = z3; const arr = groundTris.at(x, z); if (!arr) return null;
      let best = null, bd = 1e9;
      for (const t of arr) {
        const [ax, ay, az, bx, by, bz, cx, cy, cz] = t;
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(d) < 1e-9) continue;
        const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, l3 = 1 - l1 - l2;
        if (l1 < -0.001 || l2 < -0.001 || l3 < -0.001) continue;
        const y = l1 * ay + l2 * by + l3 * cy;
        const dd = Math.abs(y - refY - 0.2) ; // prefer surface nearest (slightly above) the car
        if (y <= refY + 1.2 && dd < bd) { bd = dd; best = y; }
      }
      return best;
    }
    // ---- general ray cast against the underground triangles (the original casts every wheel ray along the car's own down axis against all triangles of
    // the block meshes, FUN_00423270; that is what lets cars drive on the walls and ceiling of the round metro tunnels) ----
    const inTunnel = (x3, y, z3, keep) => y < (keep ? 6 : -2.5) && !!tunGrid.at(-x3, z3);
    function rayCast(ox, oy, oz, dx, dy, dz, maxT) {   // three-space origin/direction (unit) -> {t, nx, ny, nz (facing the origin)} or null
      const o = [-ox, oy, oz], d = [-dx, dy, dz]; let best = 1e9, bn = null;
      const seen = new Set(), step = CELL * 0.5, n = Math.ceil(maxT / step) + 1;
      for (let i = 0; i <= n; i++) {
        const tt = Math.min(maxT, i * step), arr = tunGrid.at(o[0] + d[0] * tt, o[2] + d[2] * tt); if (!arr || seen.has(arr)) continue; seen.add(arr);
        for (const tri of arr) {
          const e1x = tri[3] - tri[0], e1y = tri[4] - tri[1], e1z = tri[5] - tri[2], e2x = tri[6] - tri[0], e2y = tri[7] - tri[1], e2z = tri[8] - tri[2];
          const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x, det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-9) continue; const inv = 1 / det, tx = o[0] - tri[0], ty = o[1] - tri[1], tz = o[2] - tri[2];
          const u = (tx * px + ty * py + tz * pz) * inv; if (u < 0 || u > 1) continue;
          const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x, v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv; if (v < 0 || u + v > 1) continue;
          const t = (e2x * qx + e2y * qy + e2z * qz) * inv; if (t > 1e-4 && t < maxT && t < best) { best = t; bn = [e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x]; }
        }
      }
      if (!bn) return null; const l = Math.hypot(bn[0], bn[1], bn[2]) || 1; let nx = bn[0] / l, ny = bn[1] / l, nz = bn[2] / l;
      if (nx * d[0] + ny * d[1] + nz * d[2] > 0) { nx = -nx; ny = -ny; nz = -nz; }
      return { t: best, nx: -nx, ny, nz };
    }
    // car body against the tunnel surface: rays from the centre to the 8 corners of the body box (original FUN_0041e930 / FUN_00423270): push out along the
    // triangle normal and cancel the velocity into it
    const _cr = [[-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1], [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1]];
    // FUN_0041e930: for each of the 8 body-box corners a ray from the centre to the corner against all triangles; if it hits closer than the corner the body is
    // moved out along the normal by (len - t) * |dir . n| * 1.01 and the contact impulse is applied at the corner (turns the car like the original)
    function tunnelCollide(phys, dt) {
      const b = phys.basis; if (!b) return; const hw = 0.95, hh = 0.7, hl = 2.1, p = phys.pos, PH = global.YDPhysOrig; let hit = 0;
      for (const c of _cr) {
        const hy = c[1] < 0 ? -0.22 : hh;   // the body box starts just under the CG (the wheels carry the car; a deeper box would fight the floor contact)
        const cx = b.r[0] * hw * c[0] + b.u[0] * hy + b.f[0] * hl * c[2], cy = b.r[1] * hw * c[0] + b.u[1] * hy + b.f[1] * hl * c[2], cz = b.r[2] * hw * c[0] + b.u[2] * hy + b.f[2] * hl * c[2];
        const len = Math.hypot(cx, cy, cz), dx = cx / len, dy = cy / len, dz = cz / len, h = rayCast(p.x, p.y, p.z, dx, dy, dz, len); if (!h) continue;
        const pen = (len - h.t) * Math.abs(dx * h.nx + dy * h.ny + dz * h.nz); hit++;
        if (PH && PH.resolveContact3D) PH.resolveContact3D(phys, [h.nx, h.ny, h.nz], pen, [p.x + cx, p.y + cy, p.z + cz], { dt: dt || 0.008 });
        else { p.x += h.nx * pen; p.y += h.ny * pen; p.z += h.nz * pen; const vn = phys.vel.x * h.nx + phys.vel.y * h.ny + phys.vel.z * h.nz; if (vn < 0) phys.vel.addScaledVector({ x: h.nx, y: h.ny, z: h.nz }, -vn * 0.6); }
      }
      if (hit) phys.hitTimer = 0.15;
    }
    const world = {
      inTunnel, rayCast,
      cit, root, spawn, grid8, ground, sky, blockInfo, emitters, pathLines,
      heightAt(x3, z3, phys) {
        const ref = phys ? (phys.gy === undefined ? spawn.pos.y : phys.gy) : 0;
        let y = ground(x3, z3, ref);
        if (y === null) y = ref; // off-map: keep last height
        if (phys) phys.gy = y;
        return y;
      },
      // push the car out of walls/objects using 3 circles along its length.
      // Each circle takes only its deepest contact per pass (walls are made of many overlapping edges).
      collide(phys, dt) {
        phys.hitTimer = Math.max(0, (phys.hitTimer || 0) - dt);
        if (phys.tunnel) { tunnelCollide(phys, dt); return; }   // underground: surface contacts by ray casts, not by wall segments
        const R = 1.05, gy = phys.gy === undefined ? 0 : phys.gy;
        let hitAny = false;
        for (let pass = 0; pass < 2; pass++) {
          const fx = Math.sin(phys.yaw), fz = Math.cos(phys.yaw);
          for (const off of [1.7, 0, -1.7]) {
            const px = phys.pos.x + fx * off, pz = phys.pos.z + fz * off, qx = -px, qz = pz; // query in D3D space
            let best = 0, bnx = 0, bnz = 0;
            for (const arr of [walls.at(qx, qz), phys.ignoreObjects ? null : colliders.at(qx, qz)]) {
              if (!arr) continue;
              for (const s of arr) {
                let nx, nz, pen;
                if (s.round) {
                  const dx = qx - s.x, dz = qz - s.z, dist = Math.hypot(dx, dz); pen = R + s.r - dist; if (pen <= 0 || dist < 1e-6) continue; nx = dx / dist; nz = dz / dist;
                } else {
                  if (s.y1 < gy + 0.3 || s.y0 > gy + 2.2) continue;
                  const ex = s.x1 - s.x0, ez = s.z1 - s.z0, el2 = ex * ex + ez * ez; if (el2 < 1e-6) continue;
                  let t = ((qx - s.x0) * ex + (qz - s.z0) * ez) / el2; t = Math.max(0, Math.min(1, t));
                  const dx = qx - (s.x0 + ex * t), dz = qz - (s.z0 + ez * t), dist = Math.hypot(dx, dz); pen = R - dist; if (pen <= 0 || dist < 1e-6) continue; nx = dx / dist; nz = dz / dist;
                }
                if (pen > best) { best = pen; bnx = nx; bnz = nz; }
              }
            }
            if (best > 0) {
              // D3D-space normal (bnx,bnz) -> game space (-bnx, bnz)
              const gnx = -bnx, gnz = bnz;
              phys.pos.x += gnx * best; phys.pos.z += gnz * best;
              const vn = phys.vel.x * gnx + phys.vel.z * gnz;
              if (vn < 0) { phys.vel.x -= vn * gnx * 1.3; phys.vel.z -= vn * gnz * 1.3; hitAny = true; }
            }
          }
        }
        if (hitAny) { phys.hitTimer = 0.15; phys.vel.multiplyScalar(0.99); }
      },
      updateMovers,
      movers,
      update(dt, phys, camera) {
        const cx = -camera.position.x, cz = camera.position.z;
        for (const bi of blockInfo) {
          const s = bi.blk.sphere; const d = Math.hypot(cx - s[0], cz - s[2]) - s[3];
          const vis = d < 480; bi.g.visible = vis;
          if (vis) {
            bi.og.visible = d < 260;
            if (!bi.loaded) { bi.loaded = true; for (const mi of bi.used) wantTex(cityMats[mi], texCity); }
          }
        }
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
    for (const bi of blockInfo) { const s = bi.blk.sphere; if (Math.hypot(spawn.pos.x * -1 - s[0], spawn.pos.z - s[2]) < 350) { bi.loaded = true; for (const mi of bi.used) wantTex(cityMats[mi], texCity); } }
    spawn.pos.y = ground(spawn.pos.x, spawn.pos.z, spawn.pos.y + 1) ?? spawn.pos.y;
    spawn.gy = spawn.pos.y;
    console.log('city loaded', cit.blocks.length, 'blocks,', nObj, 'objects');
    return world;
  }

  global.YDWorld = { load, parseCit };
})(window);
