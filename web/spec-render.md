# Yerevan Drive v1.1 – 3D render pipeline (reverse engineered)

Source: Ghidra decompile of `Yerevan Drive.exe` (addresses are VAs; "dev" = global render wrapper `DAT_004a8164`, D3D9 device = `DAT_004a8160`).
Port: `render-orig.js` (`window.YDRender`). Items marked **(approx)** are not fully resolved (see §9).

D3D9 vtable offsets used below: 0xb0 SetTransform, 0xc4 SetMaterial, 0xcc SetLight, 0xe4 SetRenderState, 0x10c SetTextureStageState, 0x114 SetSamplerState, 0x148 DrawIndexedPrimitive.
Everything is **fixed function** (no shaders): Gouraud vertex lighting, texture stages, per-material render states.

## 1. Device / global state
- Render state cache wrapper: `FUN_00405c00(dev,state,value)` (SetRenderState with cache), `FUN_00405c50` (sampler), `FUN_00405cf0` (texture stage).
- Init `FUN_00436b70`: projection `fovY=0.98174775 rad (56.25°), aspect 4/3, near 0.5, far 500` (overridden every frame, §3), `D3DRS_DITHERENABLE=1`, `ZENABLE=1`, **ambient `0xFF646464`** (later replaced each frame by the sun code, §4), sampler stage0 MIN=LINEAR (or ANISOTROPIC when the TextureLOD option >= 2, `MAXANISOTROPY=option`), MAG=LINEAR, MIP=LINEAR, stage1 all LINEAR, light 0 enabled.
- **No fog**: there is no `D3DRS_FOGENABLE`/FOG* call anywhere in the binary. Visibility is limited only by the far plane and block culling (§6). (The web port previously used fog; remove it.)
- Clear: `FUN_00415a90`/`FUN_00415b10`: when the camera is not inside a block (`FUN_00417220(cam)==0`) the sky is drawn instead of clearing; otherwise `Clear(TARGET|ZBUFFER, 0xFF323232, z=1)`. Frame-end clear in menu code: `Clear(...,0xff,...)`.

## 2. Material (100-byte REF type-3 / CIT material) – `FUN_004036e0`, apply `FUN_00406740`
Raw data (little endian): `u32 id`, `u32 flags` (stored at material+0x14), `D3DMATERIAL9` at +8 (diffuse, ambient, specular, emissive RGBA floats, power), bytes `[0x4c]=alphaRef [0x4d]=alphaFunc [0x4e]=srcBlend [0x4f]=dstBlend`, `[0x50]=nStages`, **dword at 0x54: non-zero byte = "colourable/paint" material (cars)**.
Flag bits → render states (`FUN_00406740`):
| bit | meaning | state |
|---|---|---|
| 25 | lighting on | `D3DRS_LIGHTING(0x89)`; if on: `SetMaterial`, and bit31 → `SPECULARENABLE(0x1d)` |
| 26 | alpha test | `ALPHATESTENABLE(0xf)`, `ALPHAREF(0x18)=byte0x4c`, `ALPHAFUNC(0x19)=byte0x4d` (usually GREATEREQUAL, ref 0) |
| 28 | transparent | `ALPHABLENDENABLE(0x1b)=1`, `SRCBLEND(0x13)=byte0x4e`, `DESTBLEND(0x14)=byte0x4f` (usually 5/6 = SRCALPHA/INVSRCALPHA); also drawn in the alpha pass |
| 29 | double sided | `CULLMODE(0x16)=NONE(1)`, else `CW(2)` |
| 30 | z-write | `ZWRITEENABLE(0xe)` |
Common flag words: `0xC2000000` (lit, zwrite, specular), `0x42000000` (lit, zwrite), `0x52000000` (lit, zwrite, **blend**).
If the draw's fade parameter < 1, blending is forced on and diffuse alpha is multiplied by it.
`render-orig.js: parseMaterialRaw / makeMaterial` implement this mapping.

### Texture stage struct (60 bytes, REF type 5; `FUN_00403e40`, applied by `FUN_00406590`)
`[0]` type (0 = 2D texture, 1 = cube texture → `D3DXCreateCubeTexture…`), `[1..6]` COLOROP, COLORARG1, COLORARG2, ALPHAOP, ALPHAARG1, ALPHAARG2 (D3DTOP/TA values; typical `4,2,0,4,2,0` = MODULATE(tex,diffuse)), `[7..9]` ADDRESSU/V/W, `[10..12]` MIN/MAG/MIP filter, `[13],[14]` MAXMIPLEVEL / MIPMAPLODBIAS (bytes), dword@0x10 = TEXTURETRANSFORMFLAGS, dword@0x14 = TEXCOORDINDEX, byte@0x18 mip count, name char[16] @ **0x2c** (not 0x30).

## 3. Projection
- Per frame (`FUN_004286d0`): `FUN_00407820(fovY=0.98174775, aspect=1.33333, near=0.9, far=1000)` – fixed 4:3 even on wide windows.
- Reflection cube pass (`FUN_00411ff0`): fov 90° (1.5707964), aspect 1, near 0.25, far 70.
- Default constructor (`FUN_00407bf0`): 45°, 4/3, 0.4, 700 (unused in play).
Frustum test `FUN_00405a30(center,radius)`: sphere vs 4 side planes + far plane.

## 4. Lights & sun (`FUN_004182f0`, `FUN_00418430`, `FUN_00418670`, `FUN_00418750`)
- **One directional D3DLIGHT9**, diffuse = specular = (1,1,1), ambient 0, range 1000; direction vector `(0.1, -sin(2.7), cos(2.7))` = (0.1, -0.4274, -0.9041) in D3D space (not normalised; D3D normalises). Mirrored three.js space: `(-0.1,-0.4274,-0.9041)`.
- Ambient render state each frame: grey `180 - int(30 * glare)` (code @0x4183ee..), glare ∈ [0,1].
- Glare (`FUN_00418430`): every 0.3 s tests whether the sun is in front of the camera, inside the viewport and not occluded (ray vs block collision meshes, `FUN_004225c0`); glare ramps +dt / -dt per frame, clamped 0..1.
- Sun sprite: material `DAT_0049cde0` (citstdmat `sun`), billboard 40×40 at `eye - sunDir*60`, emissive `0.6 + 0.4*glare` (FUN_00418670).
- Lens flare (`FUN_00418750`, only if glare != 0): ZENABLE=0, two quads with `DAT_0049cde4` (citstdmat `lens0/lens1/lens2.jpg`), alpha = glare*0.6, sizes 0.5 and 0.25 placed along the sun axis from a point 2 units in front of the camera **(positions approx)**.
- No time-of-day change was found.

## 5. Sky (`FUN_00414d10`)
Sky ref `Graph/sky.ref` (+`sky.tex`), single frame `skybox` (box ≈ 200×100×190). Each frame: translate to the camera eye, uniform scale `far * (1/120)`; all sky materials get emissive `(0.8,0.8,0.8,1)`; `D3DRS_ZFUNC=ALWAYS(8)` while drawing, then `LESSEQUAL(4)`. Drawn before the city.

## 6. World draw order & culling
`FUN_00415b10` (per frame): camera update `FUN_00417630` → **reflection cube** `FUN_00411ff0` → `FUN_00414e40` (visible-block selection) → sun light `FUN_004182f0` → sky `FUN_00414d10` + `FUN_00418670` → blocks (`FUN_00415a90`) → alpha-sorted list (`FUN_00422340`) → lens flare `FUN_00418750`.
- Block selection `FUN_00414e40`: distance = |block sphere centre - eye| - radius; drawn if `<= viewDistance`: **300 / 550 / 850 m** for config `ViewDistance` 0/1/2 (`FUN_00414000`); blocks within 400 m are kept in the "near" list, within 250 in a second list; the block containing the camera is always drawn.
- Block draw `FUN_004223e0`: world matrix = identity, main mesh, then mesh lists (A, B, objects) each frustum-tested by bounding sphere.
- Mesh draw `FUN_00404a30`: SetStreamSource/SetIndices/SetFVF then **two passes over the subsets**: opaque (material flag 28 clear) then transparent (flag 28 set), `DrawIndexedPrimitive(TRILIST, 0, minVertex, numVerts, startTri*3, triCount)`.
- Object LOD `FUN_004221f0`: `ratio = min(radius,12)/distance`, with `S = {0.125, 0.09, 0.068}` by ViewDistance: `ratio <= 0.25*S` culled; `<= 0.35*S` LOD 2; `<= S` LOD 1; else LOD 0. LOD 2 and objects whose flag word is negative are queued for the sorted alpha draw (`FUN_00407500`, key = view-depth).

## 7. Cars (`FUN_0040ed20` load, `FUN_00410c60` draw, `FUN_0040f9b0` menu preview draw)
- Parts from `avto.ref` by name: `tire_l`(0x6c0) `tire_r`(0x6c4) `kuzov`(body,0x6cc) `lusamut`(window/glass,0x6d4) `most`(0x6d8) `tormz`(brake lights,0x6dc) `zadni`(rear/reverse light,0x6e0) `bound`(collision hull, never drawn). `rul`, `inter` appear in some cars (steering wheel / interior).
- **Paint**: collected at load = every material with non-zero byte at data[0x54] (verified on all 17 cars: e.g. BMW `[5]`, TT `[10]`, Hummer `[1,13,14]`). Colour (RGBA floats from `carcol.ini`) is written into the material's diffuse (+0x1c..0x28) and ambient (+0x2c..0x38) every frame in the opaque pass.
- Draw order: lusamut, most, kuzov; alpha pass: tormz (only if brake flag `car+0x17c & 0x40000000`), zadni (if `car+0x194 == 0`), plus an optional extra object (`car+0x154`, headlight/siren). Wheels: for each wheel (list at `car+0x1ac`) set its matrix; flag `0x20000000` → draw `tire_l`, `0x10000000` → `tire_r`.
- Blinking (spawn/invulnerability): while `car+0x1d8 > 0` the car is only drawn when `int(timer*10)` is even.
- **Reflections (dynamic cube map)**: class at `DAT_004b1110` (`FUN_00411f90` init, `FUN_00411ff0` render, `FUN_00412420` set follow target): R5G6B5 cube render target, 6 faces rendered with fov 90°, near 0.25, far 70, eye = car position + 0.6 × car up vector, using the full world draw (`FUN_00415a90`). The cube is bound as texture stage 1 with COLOROP = **BLENDFACTORALPHA(14)** (Arg1 = TEXTURE (cube), Arg2 = CURRENT), TEXCOORDINDEX = `0x30000` (**CAMERASPACEREFLECTIONVECTOR**), TTF = COUNT3 (texture matrix = inverse view), CLAMP, LINEAR. Result = env·f + base·(1−f) with `f = D3DRS_TEXTUREFACTOR alpha`. Per car per frame: `f = clamp01((r/d − 0.35 S)/(0.65 S)) × 60/255` (r = car bounding radius, d = distance, S as in §6) → **max 23.5 %**, 0 far away. Stage 1 is disabled for LOD 2 (max stages = 1).
- Menu preview uses the static real cube map `Menu/menu.tex` `cubemap.dds` (6 × 128², 32-bit; face order +X,−X,+Y,−Y,+Z,−Z = three.js CubeTexture order).
- Licence plate: car material `hamar` (in each avto.tex a 128×32 DXT). The game calls `FUN_0040f670(model, plateTexture, alpha)` (→ `FUN_00403840` swaps the texture of the `hamar` material). Plate backgrounds are `Cars/carmat.tex` `hamar0..9.tga`; text is drawn with the bitmap font **(layout approx)**.
- Engine sound params set in `FUN_0040f6b0`: `engine.wav` (loop, min 10 m, max 60 m).

## 8. Camera (`FUN_00417ad0` update, `FUN_00417630` view, `FUN_00417240` follow, `FUN_004179e0` free-cam toggle)
Camera object `0x4b1188`: mode at +4 (C key cycles; modes 0,1 chase, ≥2 interior), eye +8, target +0x20, up +0x2c, velocity +0x38, followed car +0xa8. Car vectors: pos `+0x14`, vel `+0x3c`, up `+0xa0`, forward `+0xac`.
- Init on follow: `eye = pos − fwd*7 + up*2`.
- Chase (modes 0/1): `eye += 0.5*dt*carVel`; `target = pos + (0, H, 0)`, **H = 2.0 (mode 0) / 2.5 (mode 1)**; offset = eye − target; desired offset = `−(fwd.x,0,fwd.z)_normalised × L`, **L = 5.0 (mode 0) / 8.0 (mode 1)**; `offset += (desired − offset) * dt*0.8`; length clamped to ≤ L (assumed) and ≥ **3.2**; `eye = target + offset`. Up eases to `(car.up.x, |car.up.y|, car.up.z)` at rate dt.
- Camera collision: sphere radius **0.96** vs nearby collision triangles (pushed out along the normal); if |eye−pos| > **3.0** a ray from the eye to the car is tested and the eye is moved to the hit point + 1 m.
- Camera velocity = Δeye/dt (clamped to carSpeed×0.05).
- View shake: look-at y += `min(|camVel|,70)/6000 × (rand − 0.5)`.
- Interior (mode ≥ 2, from CAR! par bytes `par[0x1b8..0x1bd]` ×0.1): `eye = pos + up*A + fwd*B` (A = par[0x1b8]·0.1 ≈ 1.2–1.6 m, B = par[0x1b9]·0.1), `target = eye + fwd`; cars with all-zero bytes (A190, Honda, Kamaz, UAZ, gazel) have no interior view. Look-behind (B key, `DAT_004aaea0`): `eye = pos + up*(1 + par[0x1ba]·0.1) + fwd*(par[0x1bb]·0.1)` (6 m ahead of the car), `target = pos + up`.
- Audio listener/doppler uses the camera velocity (`FUN_00408670`).

## 9. Unresolved / approximate
1. Reflection cube resolution/format used in play and re-render period (`this+0x58` counter): defaults 128 / every 4 frames in the port.
2. Chase camera max offset length (register `unaff_ESI` in the decompile) – assumed L; mode ≥ 2 selection details (number of views per car, C-key cycle skipping cars without interior).
3. Lens-flare quad positions along the sun axis; sun visibility occlusion needs the world collision meshes (hook `occluded` in `updateLighting`).
4. Plate text layout (font draw into the plate texture) and exact plate material swap.
5. Headlight beam/flare quads (`far_alpha.tga`, `farflare1/2.tga` in every avto.tex; positions come from derived par fields at car+0x300..0x33c written in `FUN_0040ed20`, drawn by `FUN_00410940`); siren (`migalka`, `migr/migb.dds`) not ported.
6. Billboard sprites (CIT object types 3/6) go through `FUN_00406a70(dev, material, pos, w, h, rot, …)`; size is read from material dwords – not re-verified here.
7. `SetTransform(0x100 = world)` after each block uses an identity matrix (`dev+0x2c74`).

## 10. API summary (`render-orig.js`)
`YDRender.C` (all constants) · `setupScene(scene,renderer,camera,{aspect})` (no fog, ambient + sun, camera 56.25°/0.9/1000/4:3) · `updateLighting(rig,camera,dt,occluded)` · `makeSkybox(vfs,scene,camera)` · `makeSun(vfs,scene,rig)` · `buildEnvCube(vfs)` · `DynamicEnv` (live 6-face cube) · `reflectionFactor(radius,dist,viewDistSetting)` · `applyEnvironment(carObj,cube,factor)` · `paintMaterialIndices(vfs,folder)` + `applyCarPaint(materials,idx,rgb)` (needs the `materials` array returned by `YD.buildRef`; `car.js loadCar` currently does not expose it – add `materials: built.materials` to its return value) · `ChaseCamera` · `makeMaterial(raw,map)` (flag→state mapping) · `objectLOD(radius,dist,setting)` · `makePlateTexture`.
