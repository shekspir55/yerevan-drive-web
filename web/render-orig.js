// render-orig.js — the original Yerevan Drive 3D render pipeline, ported to three.js.
// Every constant below was read out of "Yerevan Drive.exe" v1.1 (addresses in spec-render.md).
// Coordinates: callers work in the mirrored three.js space of world.js (x' = -x, yaw' = -yaw),
// so D3D vectors given here are already converted (x negated) where it matters.
(function (global) {
  'use strict';
  const T = global.THREE;

  // ------------------------------------------------------------------ constants
  const C = {
    // projection used every frame by the main 3D view: FUN_004286d0 -> FUN_00407820(fovY, aspect, near, far)
    FOV_Y: 0.98174775 * 180 / Math.PI, // 56.25 deg (vertical). Aspect is fixed 4:3 in the original
    ASPECT: 4 / 3, NEAR: 0.9, FAR: 1000,
    // projection of the dynamic reflection-cube pass: FUN_00411ff0
    ENV_FOV: 90, ENV_NEAR: 0.25, ENV_FAR: 70, ENV_EYE_UP: 0.6, ENV_SIZE: 128, ENV_EVERY_FRAMES: 4 /* period not found; approximation */,
    // sun: FUN_004182f0. D3D directional light, direction = (0.1, -sin(2.7), cos(2.7)) (not normalised), diffuse=specular=(1,1,1)
    SUN_ANGLE: 2.7, SUN_DX: 0.1,
    AMBIENT_BASE: 180, AMBIENT_DROP: 30, // D3DRS_AMBIENT grey = 180 - int(30 * sunGlare)  (FUN_004182f0 @0x4183ee)
    SUN_DIST: 60, SUN_SIZE: 40, SUN_EMISSIVE_BASE: 0.6, SUN_EMISSIVE_GAIN: 0.4, // FUN_00418670
    FLARE_FADE_PERIOD: 0.3, // FUN_00418430: visibility test every 0.3 s; glare ramps by dt per frame
    SKY_SCALE_PER_FAR: 1 / 120, SKY_EMISSIVE: 0.8, // FUN_00414d10: scale = far/120, material emissive (0.8,0.8,0.8), ZFUNC=ALWAYS
    // block culling radius from config ViewDistance 0/1/2 (FUN_00414000) and LOD scale S (DAT_004a8150)
    VIEW_DISTANCE: [300, 550, 850], LOD_S: [0.125, 0.09, 0.068], LOD_NEAR_FACTOR: 0.35, LOD_FAR_FACTOR: 0.25, LOD_RADIUS_CAP: 12,
    // reflection factor on cars: tfactor alpha = clamp01((r/d - 0.35 S)/(0.65 S)) * 60 / 255
    REFLECT_MAX: 60 / 255,
    // chase camera (FUN_00417ad0)
    CAM: { follow: [5.0, 8.0], maxLen: [8.0, 12.0], height: [2.0, 2.5], rate: 0.8, minLen: 3.2, driftK: 0.5, radius: 0.96, box: 1.2, losDist: 3.0, shake: 1 / 6000, shakeCapSpeed: 70, velClamp: 0.05,
           startBack: 7, startUp: 2, parScale: 0.1 /* par bytes 0x1b8..0x1bb * 0.1 */, backUp: 1, backFwd: 6 /* look-back guard for cars without camera bytes */, orbitR: 9, orbitRate: 0.2 },
  };

  // ------------------------------------------------------------------ D3D enum helpers
  const BLEND = [0, T.ZeroFactor, T.ZeroFactor, T.OneFactor, T.SrcColorFactor, T.OneMinusSrcColorFactor, T.SrcAlphaFactor, T.OneMinusSrcAlphaFactor, T.DstAlphaFactor, T.OneMinusDstAlphaFactor, T.DstColorFactor, T.OneMinusDstColorFactor];
  // note BLEND[n] corresponds to D3DBLEND_n: 1 ZERO, 2 ONE, 3 SRCCOLOR, 4 INVSRCCOLOR, 5 SRCALPHA, 6 INVSRCALPHA, 7 DESTALPHA, 8 INVDESTALPHA, 9 DESTCOLOR, 10 INVDESTCOLOR
  const D3DBLEND = [null, T.ZeroFactor, T.OneFactor, T.SrcColorFactor, T.OneMinusSrcColorFactor, T.SrcAlphaFactor, T.OneMinusSrcAlphaFactor, T.DstAlphaFactor, T.OneMinusDstAlphaFactor, T.DstColorFactor, T.OneMinusDstColorFactor];

  // Material flag word (material data dword 1, stored at material+0x14) — FUN_00406740:
  const MF = { LIGHTING: 1 << 25, ALPHATEST: 1 << 26, BLEND: 1 << 28, DOUBLE_SIDED: 1 << 29, ZWRITE: 1 << 30, SPECULAR: 1 << 31 };

  // Raw material layout (100 bytes, REF type 3 / CIT material): see spec-render.md §2
  function parseMaterialRaw(buf) {
    const dv = new DataView(buf.buffer ? buf.buffer : buf, buf.byteOffset || 0, 100);
    const f = i => dv.getFloat32(8 + i * 4, true);
    return {
      id: dv.getUint32(0, true), flags: dv.getUint32(4, true) >>> 0,
      diffuse: [f(0), f(1), f(2), f(3)], ambient: [f(4), f(5), f(6), f(7)], specular: [f(8), f(9), f(10), f(11)], emissive: [f(12), f(13), f(14), f(15)], power: f(16),
      alphaRef: dv.getUint8(0x4c), alphaFunc: dv.getUint8(0x4d), srcBlend: dv.getUint8(0x4e), dstBlend: dv.getUint8(0x4f),
      nStages: dv.getUint8(0x50), paintable: dv.getUint8(0x54) !== 0,
    };
  }

  // three.js material that follows the exact D3D state mapping of FUN_00406740
  function makeMaterial(raw, map, opts) {
    opts = opts || {};
    if (global.YD && YD.flagMaterial) { const m = YD.flagMaterial(raw, map || null); m.userData.raw = raw; return m; }   // single mapping, formats.js flagMaterial
    const lit = !!(raw.flags & MF.LIGHTING);
    const Cls = lit ? T.MeshLambertMaterial : T.MeshBasicMaterial;
    const m = new Cls({ map: map || null, color: new T.Color(raw.diffuse[0], raw.diffuse[1], raw.diffuse[2]) });
    if (lit) m.emissive = new T.Color(raw.emissive[0], raw.emissive[1], raw.emissive[2]);
    else if (raw.emissive[0] + raw.emissive[1] + raw.emissive[2] > 0) m.color.add(new T.Color(raw.emissive[0], raw.emissive[1], raw.emissive[2]));
    m.side = (raw.flags & MF.DOUBLE_SIDED) ? T.DoubleSide : T.FrontSide; // CULLMODE: NONE if bit29 else CW (front faces; X mirrored => FrontSide)
    m.depthWrite = !!(raw.flags & MF.ZWRITE);                              // D3DRS_ZWRITEENABLE = bit30
    if (raw.flags & MF.BLEND) {                                            // ALPHABLENDENABLE = bit28; SRC/DEST from bytes
      m.transparent = true; m.blending = T.CustomBlending; m.blendEquation = T.AddEquation;
      m.blendSrc = D3DBLEND[raw.srcBlend] || T.SrcAlphaFactor; m.blendDst = D3DBLEND[raw.dstBlend] || T.OneMinusSrcAlphaFactor;
      m.opacity = raw.diffuse[3];
    }
    if (raw.flags & MF.ALPHATEST) {                                        // ALPHATESTENABLE = bit26; ALPHAREF/ALPHAFUNC from bytes (func 7 = GREATEREQUAL)
      m.alphaTest = Math.max(1 / 255, raw.alphaRef / 255);
    }
    m.userData.raw = raw;
    return m;
  }

  // ------------------------------------------------------------------ scene set-up (lights, camera, no fog)
  // The original never enables fog (no D3DRS_FOGENABLE call exists) and clears the target with the sky box drawn
  // first; when the camera is not inside the city it clears to 0xFF323232 (see spec).
  function sunDirection() { // direction the light travels, in mirrored three space (D3D x negated)
    const a = C.SUN_ANGLE;
    return new T.Vector3(-C.SUN_DX, -Math.sin(a), Math.cos(a)).normalize();
  }
  function setupScene(scene, renderer, camera, opts) {
    opts = opts || {};
    scene.fog = null;
    scene.background = new T.Color(0x323232);
    const ambient = new T.AmbientLight(0xffffff, 1); ambient.color.setScalar(C.AMBIENT_BASE / 255);
    const sun = new T.DirectionalLight(0xffffff, 1);
    const d = sunDirection(); sun.position.copy(d).multiplyScalar(-100); sun.target.position.set(0, 0, 0);
    scene.add(ambient, sun, sun.target);
    camera.fov = C.FOV_Y; camera.near = C.NEAR; camera.far = opts.far || C.FAR;
    camera.aspect = opts.aspect || C.ASPECT; camera.updateProjectionMatrix();
    const rig = { ambient, sun, glare: 0, visTimer: 0, sunDir: d };
    return rig;
  }
  // per-frame: keep the light direction fixed relative to the world and follow the D3D ambient formula
  function updateLighting(rig, camera, dt, occluded) {
    const f = new T.Vector3(); camera.getWorldDirection(f);
    const towardSun = rig.sunDir.clone().negate();
    const inFront = towardSun.dot(f) > 0.2; // (original: dot(sunDir, camForward) <= 0 and inside the viewport)
    const ndc = towardSun.clone().multiplyScalar(100).add(camera.position).project(camera);
    const onScreen = inFront && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
    const visible = onScreen && !(occluded && occluded(camera.position, towardSun));
    rig.glare = Math.min(1, Math.max(0, rig.glare + (visible ? dt : -dt))); // FUN_00418430 lines 18639-18649
    rig.ambient.color.setScalar((C.AMBIENT_BASE - Math.floor(C.AMBIENT_DROP * rig.glare)) / 255);
    return rig.glare;
  }

  // ------------------------------------------------------------------ sky box (Graph/sky.ref + sky.tex)
  async function makeSkybox(vfs, scene, camera) {
    const ref = YD.parseRef(await vfs.bytes('Graph/sky.ref'));
    const ts = await YD.TexSet.load(vfs, 'Graph/sky.tex');
    const built = await YD.buildRef(ref, [ts], { doubleSided: true });
    const sky = built.group;
    sky.traverse(o => {
      if (!o.isMesh) return; o.frustumCulled = false; o.renderOrder = -1000;
      o.material = o.material.map(m => { // emissive 0.8 grey, unlit-ish, depth test always, no depth write
        const n = new T.MeshBasicMaterial({ map: m.map, color: new T.Color(C.SKY_EMISSIVE, C.SKY_EMISSIVE, C.SKY_EMISSIVE), side: T.DoubleSide, depthTest: false, depthWrite: false, fog: false });
        return n;
      });
    });
    scene.add(sky);
    const update = () => { sky.position.copy(camera.position); const s = camera.far * C.SKY_SCALE_PER_FAR; sky.scale.set(-s, s, s); };
    return { object: sky, update };
  }

  // ------------------------------------------------------------------ static env cube (Menu/menu.tex 'cubemap.dds', real 6-face cube)
  async function buildEnvCube(vfs) {
    const files = YD.readBFX(await vfs.bytes('Menu/menu.tex'));
    const raw = new Uint8Array(files.get('cubemap.dds'));
    const faceBytes = 128 * 128 * 4, images = [];
    for (let i = 0; i < 6; i++) { // D3D face order +X -X +Y -Y +Z -Z == THREE.CubeTexture order
      const one = new Uint8Array(128 + faceBytes); one.set(raw.subarray(0, 128)); one.set(raw.subarray(128 + i * faceBytes, 128 + (i + 1) * faceBytes), 128);
      const img = YD.decodeDDS(one.buffer);
      images.push(new T.DataTexture(img.data, img.width, img.height, T.RGBAFormat));
    }
    images.forEach(t => { t.flipY = false; t.needsUpdate = true; });
    const cube = new T.CubeTexture(images); // r128 expects the DataTexture objects themselves for raw-pixel cube faces
    cube.format = T.RGBAFormat; cube.generateMipmaps = false; cube.minFilter = T.LinearFilter; cube.magFilter = T.LinearFilter; cube.needsUpdate = true;
    return cube;
  }

  // Live reflection map (FUN_00411ff0): 6 faces, fov 90, aspect 1, near .25, far 70, eye = carPos + 0.6*carUp
  class DynamicEnv {
    constructor(size) {
      this.rt = new T.WebGLCubeRenderTarget(size || C.ENV_SIZE, { format: T.RGBFormat, generateMipmaps: false, minFilter: T.LinearFilter });
      this.cam = new T.CubeCamera(C.ENV_NEAR, C.ENV_FAR, this.rt); this.frame = 0; this.texture = this.rt.texture;
    }
    // The original redraws the whole cube every few frames in one go; on WebGL that makes a hitch (6 world renders in one frame, per car).
    // Instead we refresh ONE face every `every` frames in round-robin order, so the cost is spread evenly (same total, no spikes).
    update(renderer, scene, carPos, carUp, hide, every) {
      if ((this.frame++ % (every || 1)) !== 0) return;
      const face = this.nextFace = ((this.nextFace === undefined ? -1 : this.nextFace) + 1) % 6;
      const eye = carPos.clone().addScaledVector(carUp || new T.Vector3(0, 1, 0), C.ENV_EYE_UP);
      this.cam.position.copy(eye); this.cam.updateMatrixWorld(true);
      if (hide) hide.visible = false;
      const cur = renderer.getRenderTarget(), gm = this.rt.texture.generateMipmaps; this.rt.texture.generateMipmaps = false;
      renderer.setRenderTarget(this.rt, face); renderer.render(scene, this.cam.children[face]);
      this.rt.texture.generateMipmaps = gm; renderer.setRenderTarget(cur);
      if (hide) hide.visible = true;
    }
  }

  // Strength of the reflection on a car as a function of its on-screen size (FUN_00410c60)
  function reflectionFactor(radius, distance, viewDistanceSetting) {
    const S = C.LOD_S[viewDistanceSetting || 0], S1 = C.LOD_NEAR_FACTOR * S, ratio = radius / Math.max(distance, 1e-3);
    return Math.min(1, (ratio - S1) / (S - S1)) * C.REFLECT_MAX; // may be negative far away -> clamp at 0 below
  }

  // Env lookup by the camera-space vertex normal (smooth sheen like the original) instead of the reflection vector.
  // Shader hook for the reflective stage. D3D clamps the stage-0 result (ambient + sun lighting * texture) to 1.0 BEFORE stage 1 blends the cube
  // (BLENDFACTORALPHA), so a bright body mixes as 1.0*(1-f) + env*f (measured on the real game: white G500 = 0.82); three.js would mix the unclamped value.
  function envShader(mat) {
    const fx = mat.userData.ydNormalFlip;
    if (global.YD && YD.ydHooks) { mat.userData.ydEnv = 1; YD.ydHooks(mat); mat.needsUpdate = true; return; }   // shared patch (keeps the lighting clamp / specular of formats.js flag materials)
    mat.onBeforeCompile = shader => {
      if (fx !== undefined) shader.vertexShader = shader.vertexShader.replace('#include <envmap_vertex>', '#ifdef USE_ENVMAP\n vReflect = transformedNormal * vec3(' + fx.toFixed(1) + ', 1.0, 1.0);\n#endif');
      shader.fragmentShader = shader.fragmentShader.replace('#include <envmap_fragment>', 'outgoingLight = min(outgoingLight, vec3(1.0));\n#include <envmap_fragment>');
    };
    mat.customProgramCacheKey = () => 'ydenv' + fx;
    mat.needsUpdate = true;
  }
  function normalEnv(mat, flipX) { mat.userData.ydNormalFlip = flipX === undefined ? -1 : flipX; envShader(mat); }

  // change the reflection strength (and optionally the cube texture) of a car that already went through applyEnvironment
  function setReflectivity(carObj, f, tex) {
    carObj.traverse(o => { if (!o.isMesh) return; (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { if (m && m.envMap) { if (tex) m.envMap = tex; m.reflectivity = f; } }); });
  }
  // Put the env cube on the car's body/glass materials (stage 1 = BLENDFACTORALPHA: result = env*f + base*(1-f))
  function applyEnvironment(carObj, cube, factor) {
    const f = Math.max(0, factor === undefined ? C.REFLECT_MAX : factor);
    carObj.traverse(o => {
      if (!o.isMesh) return;
      const n = (o.name || '') + (o.parent && o.parent.name || '');
      if (/tire|bound|tormz|zadni/i.test(n)) return; // wheels / lamps are not on the reflective stage
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
        if (!m || !m.isMeshLambertMaterial) return;
        m.envMap = cube; m.combine = T.MixOperation; m.reflectivity = f; if (/[?&]reflnorm/.test(location.search)) normalEnv(m); else envShader(m);   /* in game: true camera-space reflection vector (D3DTSS_TCI_CAMERASPACEREFLECTIONVECTOR, FUN_00411ff0 cube) */ m.needsUpdate = true;
      });
    });
  }

  // ------------------------------------------------------------------ paint (cars)
  // Colourable materials are the ones whose raw material data has a non-zero byte at offset 0x54
  // (FUN_0040ed20 collects them into a list; FUN_0040f9b0/FUN_00410c60 write the colour into diffuse+ambient).
  async function paintMaterialIndices(vfs, folder) {
    const ref = YD.parseRef(await vfs.bytes('Cars/' + folder + '/avto.ref'));
    const ml = ref.kids[0].kids.find(k => k.type === YD.T.MATLIST);
    const out = []; ml.kids.forEach((m, i) => { if (new Uint8Array(m.data)[0x54] !== 0) out.push(i); });
    return out;
  }
  // `materials` = the three.js material array from YD.buildRef (aligned with the REF material list); rgb in 0..1
  function applyCarPaint(materials, paintIdx, rgb) {
    for (const i of paintIdx) {
      const m = materials[i]; if (!m) continue;
      m.color.setRGB(rgb[0], rgb[1], rgb[2]); // diffuse; ambient is set to the same colour, three uses diffuse for both
      m.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------------ chase camera (camera object DAT_004b1188: FUN_00417240 follow, FUN_00417ad0 update, FUN_00417630 view, FUN_004179e0 free)
  // closest point of a triangle (FUN_00416d40) and a double-sided ray/triangle test (D3DXIntersectTri, FUN_0043e235); t = 9 numbers, three space
  function closestOnTri(p, t, out) {
    const ax = t[0], ay = t[1], az = t[2], abx = t[3] - ax, aby = t[4] - ay, abz = t[5] - az, acx = t[6] - ax, acy = t[7] - ay, acz = t[8] - az, apx = p.x - ax, apy = p.y - ay, apz = p.z - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz; if (d1 <= 0 && d2 <= 0) return out.set(ax, ay, az);
    const bpx = p.x - t[3], bpy = p.y - t[4], bpz = p.z - t[5], d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz; if (d3 >= 0 && d4 <= d3) return out.set(t[3], t[4], t[5]);
    const vc = d1 * d4 - d3 * d2; if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return out.set(ax + abx * v, ay + aby * v, az + abz * v); }
    const cpx = p.x - t[6], cpy = p.y - t[7], cpz = p.z - t[8], d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz; if (d6 >= 0 && d5 <= d6) return out.set(t[6], t[7], t[8]);
    const vb = d5 * d2 - d1 * d6; if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return out.set(ax + acx * w, ay + acy * w, az + acz * w); }
    const va = d3 * d6 - d5 * d4; if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return out.set(t[3] + (t[6] - t[3]) * w, t[4] + (t[7] - t[4]) * w, t[5] + (t[8] - t[5]) * w); }
    const den = 1 / (va + vb + vc), v = vb * den, w = vc * den; return out.set(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
  }
  function rayTri(o, d, t) {
    const e1x = t[3] - t[0], e1y = t[4] - t[1], e1z = t[5] - t[2], e2x = t[6] - t[0], e2y = t[7] - t[1], e2z = t[8] - t[2];
    const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x, det = e1x * px + e1y * py + e1z * pz; if (Math.abs(det) < 1e-10) return -1;
    const inv = 1 / det, tx = o.x - t[0], ty = o.y - t[1], tz = o.z - t[2], u = (tx * px + ty * py + tz * pz) * inv; if (u < 0 || u > 1) return -1;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x, v = (d.x * qx + d.y * qy + d.z * qz) * inv; if (v < 0 || u + v > 1) return -1;
    const s = (e2x * qx + e2y * qy + e2z * qz) * inv; return s >= 0 ? s : -1;
  }
  const _v1 = new T.Vector3(), _v2 = new T.Vector3(), _v3 = new T.Vector3();
  class ChaseCamera {
    constructor() { this.mode = 0; this.eye = new T.Vector3(); this.target = new T.Vector3(); this.up = new T.Vector3(0, 1, 0); this.vel = new T.Vector3(); this.prevEye = new T.Vector3(); this.init = false; this.lookBehind = false; this.free = false; this.saved = null; this.clock = 0; this.viewEye = new T.Vector3(); this.viewTarget = new T.Vector3(); }
    // car: {pos, vel, up, fwd (unit, game space), par?: {camBytes:[a,b,c,d]}}
    reset(car) { // FUN_00417240(car): mode 0, eye = pos - fwd*7 + up*2, target = pos + (0,2,0), up = car up, vel = car vel
      this.mode = 0; this.eye.copy(car.pos).addScaledVector(car.fwd, -C.CAM.startBack).addScaledVector(car.up, C.CAM.startUp); this.prevEye.copy(this.eye);
      this.target.set(car.pos.x, car.pos.y + C.CAM.height[0], car.pos.z); this.up.copy(car.up); this.vel.copy(car.vel); this.init = true;
    }
    cycle() { this.mode = (this.mode + 1) % 3; }   // C (FUN_00417610): 0 -> 1 -> 2 -> 0
    setFree(on) { // FUN_004179e0: pause / menus. On: save eye, target, up, vel; off: restore them exactly
      on = !!on; if (on === this.free) return; this.free = on;
      if (on) this.saved = [this.eye.clone(), this.target.clone(), this.up.clone(), this.vel.clone()];
      else if (this.saved) { this.eye.copy(this.saved[0]); this.target.copy(this.saved[1]); this.up.copy(this.saved[2]); this.vel.copy(this.saved[3]); this.prevEye.copy(this.eye); }
    }
    // opts.tris(x0,y0,z0,x1,y1,z1) -> collision triangles of the blocks (eye +- 1.2 box); opts.noCollide skips it
    update(car, dt, camera, opts) {
      opts = opts || {}; if (!this.init) this.reset(car);
      const K = C.CAM, eye = this.eye, tg = this.target; this.clock += dt; this.prevEye.copy(eye);
      if (this.free) { // orbit around the frozen target at radius 9, height of the target (T = game clock * 0.2)
        const k = dt * K.orbitRate, a = this.clock * K.orbitRate, ox = eye.x - tg.x, oy = eye.y - tg.y, oz = eye.z - tg.z;
        eye.set(tg.x + ox + (-K.orbitR * Math.sin(a) - ox) * k, tg.y + oy - oy * k, tg.z + oz + (K.orbitR * Math.cos(a) - oz) * k);   // x mirrored
      } else {
        const L = K.follow[this.mode === 1 ? 1 : 0], Lmax = K.maxLen[this.mode === 1 ? 1 : 0], H = K.height[this.mode === 1 ? 1 : 0];   // mode 2 keeps the mode-0 chase running
        eye.addScaledVector(car.vel, dt * K.driftK);                                    // eye drifts with half the car velocity
        tg.set(car.pos.x, car.pos.y + H, car.pos.z);                                     // look-at point (world Y)
        const off = _v1.copy(eye).sub(tg), hl = Math.hypot(car.fwd.x, car.fwd.z), want = _v2.set(hl > 1e-6 ? -car.fwd.x / hl * L : 0, 0, hl > 1e-6 ? -car.fwd.z / hl * L : 0);
        off.addScaledVector(want.sub(off), dt * K.rate);                                 // pull towards L behind the car at 0.8/s
        const len = off.length();
        if (len > Lmax) off.multiplyScalar(Lmax / len);                                  // both tests use the length before scaling
        if (len < K.minLen) off.multiplyScalar(K.minLen / Math.max(len, 1e-4));
        eye.copy(tg).add(off);
        this.up.x += (car.up.x - this.up.x) * dt; this.up.y += (Math.abs(car.up.y) - this.up.y) * dt; this.up.z += (car.up.z - this.up.z) * dt;
      }
      if (opts.tris && !opts.noCollide) { // 0.96 m sphere out of every block triangle in the eye +-1.2 box, then the line of sight to the car (> 3 m: jump 1 m past the obstacle)
        const B = K.box, tris = opts.tris(eye.x - B, eye.y - B, eye.z - B, eye.x + B, eye.y + B, eye.z + B), c = _v3;
        for (const t of tris) { closestOnTri(eye, t, c); const d = eye.distanceTo(c); if (d < K.radius && d > 1e-6) eye.addScaledVector(_v1.copy(eye).sub(c), (K.radius - d) / d); }
        if (eye.distanceTo(tg) > K.losDist) {
          const dir = _v2.copy(car.pos).sub(eye), dist = dir.length(); dir.divideScalar(dist || 1); let best = 5000;
          for (const t of tris) { const s = rayTri(eye, dir, t); if (s >= 0 && s < best) best = s; }
          if (best < dist) eye.addScaledVector(dir, best + 1);
        }
      }
      if (dt > 0) {
        this.vel.copy(eye).sub(this.prevEye).divideScalar(dt);
        const cv = car.vel.length(), v = this.vel.length(); if (!this.free && v > cv) this.vel.multiplyScalar(K.velClamp * cv / v);   // only used for the shake (and the listener)
      }
      // view (FUN_00417630): does not touch the stored eye/target
      const cb = (car.par && car.par.camBytes) || [0, 0, 0, 0], ve = this.viewEye, vt = this.viewTarget;
      if (this.free) { ve.copy(eye); vt.copy(tg); camera.up.copy(this.up).normalize(); }
      else if (this.lookBehind) { // B in any mode: fixed front camera, target = pos + up, eye = target + up*C + fwd*D (C = D = 0 for 5 cars: degenerate in the original, guarded with 1 / 6)
        let Cc = cb[2] * K.parScale, Dd = cb[3] * K.parScale; if (!Cc && !Dd) { Cc = K.backUp; Dd = K.backFwd; }
        vt.copy(car.pos).add(car.up); ve.copy(vt).addScaledVector(car.up, Cc).addScaledVector(car.fwd, Dd); camera.up.copy(car.up);
      } else if (this.mode < 2) { // chase: small vertical shake of the look-at point from the camera speed
        const s = Math.min(this.vel.length(), K.shakeCapSpeed); ve.copy(eye); vt.copy(tg); vt.y += s * K.shake * (Math.random() - 0.5); camera.up.copy(this.up).normalize();
      } else { // mode 2: hood / roof camera, eye = pos + up*A + fwd*B, target = eye + fwd (A = B = 0: eye at the CG, as in the original)
        ve.copy(car.pos).addScaledVector(car.up, cb[0] * K.parScale).addScaledVector(car.fwd, cb[1] * K.parScale); vt.copy(ve).add(car.fwd); camera.up.copy(car.up);
      }
      camera.position.copy(ve); camera.lookAt(vt);
      return this;
    }
  }

  // ------------------------------------------------------------------ lens flare / sun sprite (Graph/citstdmat.*)
  async function makeSun(vfs, scene, rig) {
    const ref = YD.parseRef(await vfs.bytes('Graph/citstdmat.ref'));
    const ts = await YD.TexSet.load(vfs, 'Graph/citstdmat.tex');
    const ml = ref.kids[0].type === YD.T.MATLIST ? ref.kids[0] : ref.kids[0].kids.find(k => k.type === YD.T.MATLIST);   // citstdmat.ref: the list is the root's child
    const descs = YD.readMaterials(ml);
    const find = re => { const i = descs.findIndex(d => re.test(d.tex) || re.test(d.name)); return i < 0 ? null : { i, d: descs[i], raw: parseMaterialRaw(new Uint8Array(ml.kids[i].data)) }; };
    // lens flare (FUN_00418750): material 'LensFlare' (DAT_0049cde4, emissive white). Its texture name 'lens.tga' is not in citstdmat.tex; the archive holds
    // lens0.tga and lens1.tga (64x64, shape in alpha) = the two flare quads (the lens0-2.jpg are unused leftovers, like sun.jpg next to the used sun.bmp)
    const sunM = find(/^sun$/i) || find(/sun/i), lensM = find(/^lensflare$/i);
    const mk = async (m, size, texName, add) => {
      if (!m) return null; const tex = await ts.get(texName || m.d.tex); if (!tex) return null;
      const mat = new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, blending: add ? T.AdditiveBlending : T.NormalBlending, fog: false });
      const s = new T.Sprite(mat); s.scale.set(size, size, 1); s.renderOrder = 900; s.visible = false; scene.add(s); return s;
    };
    const sun = await mk(sunM, C.SUN_SIZE, null, true);
    const flares = []; for (const [tn, sz] of [['lens0.tga', 0.5], ['lens1.tga', 0.25]]) { const f = await mk(lensM, sz, tn, false); if (f) flares.push(f); }   // two quads, sizes 0.5 / 0.25 (spec-render.md)
    return {
      sun, flares,
      update(camera) { // call after updateLighting()
        const g = rig.glare; const dir = rig.sunDir.clone().negate();
        if (sun) { sun.position.copy(camera.position).addScaledVector(dir, C.SUN_DIST); const e = C.SUN_EMISSIVE_BASE + C.SUN_EMISSIVE_GAIN * g; sun.material.color.setScalar(e); sun.visible = dir.dot(camera.getWorldDirection(new T.Vector3())) > 0; }
        flares.forEach((f, i) => { f.visible = g > 0.01; f.material.opacity = g * C.SUN_EMISSIVE_BASE; const fw = camera.getWorldDirection(new T.Vector3()); f.position.copy(camera.position).addScaledVector(fw, 2).addScaledVector(dir, -0.5 * (i + 1)); });
      },
    };
  }

  // ------------------------------------------------------------------ licence plates (Cars/carmat.tex hamar*.tga + font text)
  // The in-game plate material is the car's 'hamar' material; the original draws a plate template (hamarN.tga) and writes the
  // plate text with the bitmap font. We reproduce that with a canvas texture (layout of the text is approximate).
  async function makePlateTexture(vfs, plateIndex, text, fontDraw) {
    const ts = await YD.TexSet.load(vfs, 'Cars/carmat.tex');
    const base = await ts.get('hamar' + (plateIndex | 0) + '.tga');
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 32;
    const g = cv.getContext('2d');
    if (base && base.image) {
      const tmp = document.createElement('canvas'); tmp.width = base.image.width; tmp.height = base.image.height;
      const id = tmp.getContext('2d').createImageData(tmp.width, tmp.height); id.data.set(base.image.data); tmp.getContext('2d').putImageData(id, 0, 0);
      g.drawImage(tmp, 0, 0, 128, 32);
    } else { g.fillStyle = '#fff'; g.fillRect(0, 0, 128, 32); }
    if (fontDraw && text) fontDraw(g, text, 64, 16, 128, 32);
    const t = new T.CanvasTexture(cv); t.flipY = false; return t;
  }

  // ------------------------------------------------------------------ alpha pass & misc
  // Original: opaque meshes are drawn immediately, objects with transparent subsets are queued and sorted by view depth
  // (FUN_00407500 key = dot(pos, camForward) in x/z only) — three.js already sorts transparent objects back-to-front.
  function sortAlpha(objects, camera) { objects.forEach(o => { if (o.material) o.renderOrder = 0; }); }

  // Object LOD from angular size (FUN_004221f0): returns 0 (full), 1, 2, or -1 (culled)
  function objectLOD(radius, distance, viewDistanceSetting) {
    const S = C.LOD_S[viewDistanceSetting || 0], ratio = Math.min(radius, C.LOD_RADIUS_CAP) / Math.max(distance, 1e-3);
    if (ratio <= C.LOD_FAR_FACTOR * S) return -1;
    if (ratio <= C.LOD_NEAR_FACTOR * S) return 2;
    if (ratio <= S) return 1;
    return 0;
  }

  global.YDRender = { C, MF, parseMaterialRaw, makeMaterial, sunDirection, setupScene, updateLighting, makeSkybox, buildEnvCube, DynamicEnv, reflectionFactor, applyEnvironment, setReflectivity, normalEnv, paintMaterialIndices, applyCarPaint, ChaseCamera, makeSun, makePlateTexture, sortAlpha, objectLOD };
})(window);
