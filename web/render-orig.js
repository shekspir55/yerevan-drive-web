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
    CAM: { follow: [5.0, 8.0], height: [2.0, 2.5], rate: 0.8, minLen: 3.2, driftK: 0.5, radius: 0.96, losDist: 3.0, shake: 1 / 6000, shakeCapSpeed: 70,
           startBack: 7, startUp: 2, interiorUp: 0.1, interiorFwd: 0.1 /* par bytes * 0.1 */, behindFwdScale: 0.1 },
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

  // ------------------------------------------------------------------ chase camera (FUN_00417ad0 + FUN_00417630)
  class ChaseCamera {
    constructor() { this.mode = 0; this.eye = new T.Vector3(); this.target = new T.Vector3(); this.up = new T.Vector3(0, 1, 0); this.vel = new T.Vector3(); this.prevEye = new T.Vector3(); this.init = false; this.lookBehind = false; }
    // car: {pos, vel, up, fwd (unit, game space), par?: {camBytes:[a,b,c,d]}}; opts.collideEye(eye, radius)
    reset(car) { // FUN_00417240: eye = pos - fwd*7 + up*2
      this.eye.copy(car.pos).addScaledVector(car.fwd, -C.CAM.startBack).addScaledVector(car.up, C.CAM.startUp); this.prevEye.copy(this.eye); this.init = true;
    }
    update(car, dt, camera, opts) {
      opts = opts || {}; if (!this.init) this.reset(car);
      this.prevEye.copy(this.eye);
      const cb = (car.par && car.par.camBytes) || [0, 0, 0, 0];
      if (this.mode >= 2) { // interior / look-behind
        const up = car.up;
        if (this.lookBehind) { // DAT_004aaea0 != 0 variant: eye = pos + up*(1+b) + fwd*c, target = pos + up
          this.target.copy(car.pos).add(up);
          this.eye.copy(car.pos).addScaledVector(up, 1 + cb[2] * 0.1).addScaledVector(car.fwd, cb[3] * 0.1);
        } else {            // eye = pos + up*A + fwd*B ; target = eye + fwd
          this.eye.copy(car.pos).addScaledVector(up, cb[0] * 0.1).addScaledVector(car.fwd, cb[1] * 0.1);
          this.target.copy(this.eye).add(car.fwd);
        }
        this.up.copy(up);
      } else {
        const L = C.CAM.follow[this.mode], H = C.CAM.height[this.mode];
        this.eye.addScaledVector(car.vel, dt * C.CAM.driftK);                         // eye drifts with half the car velocity
        this.target.set(car.pos.x, car.pos.y + H, car.pos.z);                          // look-at point
        const off = this.eye.clone().sub(this.target);
        const h = new T.Vector3(car.fwd.x, 0, car.fwd.z).normalize();
        const want = h.multiplyScalar(-L);
        off.addScaledVector(want.sub(off), Math.min(1, dt * C.CAM.rate));             // exponential approach to "behind the car"
        const len = off.length();
        if (len > L) off.multiplyScalar(L / len);                                     // clamp (max length assumed = L)
        if (len < C.CAM.minLen) off.multiplyScalar(C.CAM.minLen / Math.max(len, 1e-4));
        this.eye.copy(this.target).add(off);
        // up vector eases toward the car up (y made positive)
        const k = Math.min(1, dt);
        this.up.x += (car.up.x - this.up.x) * k; this.up.y += (Math.abs(car.up.y) - this.up.y) * k; this.up.z += (car.up.z - this.up.z) * k;
        if (opts.collideEye) opts.collideEye(this.eye, C.CAM.radius, this.target);   // 0.96 m sphere vs collision meshes + line-of-sight (>3 m)
      }
      this.vel.copy(this.eye).sub(this.prevEye).divideScalar(Math.max(dt, 1e-4));
      // view (FUN_00417630): a little vertical shake of the look-at point proportional to camera speed
      const tgt = this.target.clone();
      if (this.mode < 2) { const sp = Math.min(this.vel.length(), C.CAM.shakeCapSpeed); tgt.y += sp * C.CAM.shake * (Math.random() - 0.5); }
      camera.position.copy(this.eye); camera.up.copy(this.up).normalize(); camera.lookAt(tgt);
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
    const sunM = find(/sun/i), lens = [find(/lens0/i), find(/lens1/i), find(/lens2/i)];
    const mk = async (m, size) => {
      if (!m) return null; const tex = await ts.get(m.d.tex);
      const mat = new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, blending: T.AdditiveBlending, fog: false });
      const s = new T.Sprite(mat); s.scale.set(size, size, 1); s.renderOrder = 900; s.visible = false; scene.add(s); return s;
    };
    const sun = await mk(sunM, C.SUN_SIZE);
    const flares = []; for (const [k, sz] of [[0, 3], [1, 1.5], [2, 1]]) { const f = await mk(lens[k], sz); if (f) flares.push(f); }
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
