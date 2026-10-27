# Yerevan Drive v1.1: `yerevan.cit` (CIT1) and `Tracks/trackN.trc` format spec

Reverse-engineered from the decompiled `Yerevan Drive.exe` (Ghidra) and validated by parsing the real files.
Reference parsers: `cit.py`, `trc.py` (copies in this directory's `tools/`; originals in the session scratchpad `py/`).
Validation: `yerevan.cit` parses to **exactly EOF** (6,199,283 bytes); **all 28** `track0..27.trc` parse to exactly EOF.

All integers little-endian. `str16` = `u16 length` + that many bytes (cp1251/ASCII, no terminator).
`cstr` = NUL-terminated within a fixed-size field.

## 0. Conventions

- **Coordinates:** Direct3D 9, **left-handed, Y up**, 1 unit ≈ 1 metre. World spans x -608..1060, y -53..48, z -992..1360. The ground is at y≈0..0.2.
- **Matrices:** D3D row-major 4x4 with **row vectors** (`v' = v * M`). Rotation in rows 0-2, translation in row 3. Y rotation by θ: row0 = (cos 0 -sin), row2 = (sin 0 cos), as `D3DXMatrixRotationY` (a 90° turn gives row0 = (0,0,-1), row2 = (1,0,0)). For three.js: transpose, or negate Z at load (`z -> -z`, flip triangle winding) to convert to right-handed.
- **Triangles:** `D3DPT_TRIANGLELIST`, index `u16`. **Culling:** D3D default CW front faces (left-handed).
- Meshes use FVF `0x112` = `XYZ | NORMAL | TEX1`, stride 32: `pos(3f) normal(3f) uv(2f)`. (Cars use FVF 0x12/stride 24 in some parts.)

## 1. `yerevan.cit` (loader `FUN_00415c50`)

```
0x000  header[0x90]
         u32 'CIT1' (0x31544943)
         u32 0
         char title[]      "Mer qaxaq!"  ("Our city!") at +8
         ...               bytes 0x1c..0x8b are uninitialised stack garbage, ignore
         u32 nBlocks       at +0x8c  (= 209)
0x090  MaterialList  #0   (city geometry materials)   list name "graph/citmat.atx", 681 entries
       MaterialList  #1   ("graph/othtex.tex", 22)   sprites/signs used by object types 3, 6, 8
       MaterialList  #2   ("graph/plakats.tex", 42)  poster/billboard textures (plakat materials)
       SoundDefList       u32 n; n x SoundDef
       MObjDefList        u32 n; n x MObjDef          "movable objects" (cola machines, bins, ...)
       ObjDefList         u32 n; n x ObjDef           static objects (poles, trees, kiosks)
       PlakDefList        u32 n; n x ObjDef           posters (same record as ObjDef)
       Block[nBlocks]
       u32 nSpawn; nSpawn x SpawnSlot (0x44 bytes)    (8 slots)
EOF
```

### 1.1 MaterialList

```
str16  name              (usually empty)
u32    count
u32    unk               (=1)
char   listName[256]     archive the textures come from ("graph/citmat.atx", ...)  -> lowercase path in the game folder
Material[count]:
  str16 name             e.g. "asv3.dds"  -> key into the archive named by listName
  byte  data[100]        same layout as REF! type-3 material node data (25 dwords):
        u32 id0, u32 flags1
        D3DMATERIAL9 @ +8:  diffuse rgba(4f) ambient(4f) specular(4f) emissive(4f) power(f)   (floats [2..18])
        @0x4c: 4 bytes, u8 nStages is the low byte of dword[20] (=0 or 1)
        @0x54..0x63: 4 dwords (billboard width/height related; for type-3 sprites size = dword[22]+dword[21])
  Stage[nStages]: 60 bytes each: 44 bytes of texture-stage state, then char tex[16]  (texture file name)
```

- **Transparent material** iff `flags1 & 0x10000000` (drawn in the second, alpha-blended pass). 8 of 681 city materials. Opaque ones are drawn first. Alpha comes from the DXT3/5 texture; `diffuse.a` is usually 1.0 there.
- **Texture lookup:** `tex` (or `name`) is matched case-insensitively against the BFX1 archive entry names. Archive for list 0 = `Graph/CITMAT.ATX` (738 entries: mostly DXT1/3/5 `.dds`, 1 `.tga`, 1 `.psd`). About 10 of ~745 stage names have no entry (e.g. `tup1.tga`, `vaza1.tga`, `tup2.tga`, `mid.dds`, `haypost.dds`); the game just renders them untextured.
- **Material index:** in all binary mesh data, a "material" is the **0-based position in the corresponding list**, not an id. Block meshes use list #0 (max index used 680).

### 1.2 SoundDef / MObjDef / ObjDef

```
SoundDef : str16 name  (wav file name inside Sound/ambient.snd BFX1 archive)
           u32 p[8]     p[2]=minDist(f), p[3]=maxDist(f) (e.g. 10.0, 100.0), p[1]=1 (loop?)
MObjDef  : str16 name   (frame name in Graph/mobjects.ref)
           u32 p[9]     p[0]=flags (0 or 0x01010101), p[1..4]= float 100.0 defaults, ...
           SoundDef sound
ObjDef   : str16 name   (frame name in Graph/objects.ref  /  Graph/plakats.ref for PlakDef)
           u32 p[7]
              p[0]  0
              p[1]  KIND (see below)
              p[2]  collider shape: 1 = round (radius = float p[3]), 2 = oriented box/segment (width = float p[3], length = float p[4])
              p[3],p[4] floats (collider size)
           SoundDef sound
```

KIND (`p[1]`, observed in the object instantiation switch): `0` plain static mesh; `1` tree (the game picks one of 15 random variants/frames: cosmetic); `4` poster, instance field `b` selects the poster material from MaterialList #2; `7` lamp/pole with special draw (`stolb2`). Other kinds are not used in the data.

**Linking by name:** each def is matched (case-insensitive) with a first-level frame of the corresponding `.ref` (`FUN_00421010` / `FUN_00420d60`). The frame's mesh is the frame's own type-0xb child, or if none, the first child frame's mesh. **Defs whose name is not found are silently skipped (their instances aren't drawn):** objdefs `alen`; mobjdefs `zibil, pot1, cicul, park, nstaran, zibil1`; plakdefs `klor, plakatrot`. For MObjs the physics bound is the sibling frame named `<name>_bound`.

LOD: frames named `x`, `x_lo`, `x_lo_lo` exist in `objects.ref` and a type-0xb mesh node can have a child 0xb (next lower LOD). The CIT defs reference only the base name.

Def tables found (in order = id): see `cit.py` summary: objdefs `stolb1, stolb2, tree2, kangar, tree3, telbudka, elka2, tree4, stolb3, budka1, telbudka1, elka1, stolb4, budka2, stolb5, ancum, alen`; plakdefs `plakat5, plakat2, plakat3, plakat4, klor, antares, plakatrot, plakat7, plakat6`; mobjdefs `zibil, pot1, cola1, cola2, change, kilikia, h2o, cicul, ak1, park, nstaran, zibil1, metdur`; sounds `hayfm1, hay1, fant1, Ptica, hayfm2, hay2, getak1` (.wav).

### 1.3 Block (209 of them; loader `FUN_004233b0`)

The city is one world made of blocks (tiles with no fixed grid; they overlap and are connected through the `dw` neighbour table).

```
Header (56 bytes):
  u32 f0              flags (0, or 2 for 33 blocks; meaning unknown)
  f32 aabbMin[3]      (x,y,z)   f[1..3]
  f32 aabbMax[3]                f[4..6]
  f32 sphere[4]       cx,cy,cz,radius   f[7..10]    (bounding sphere used for culling)
  u16 nMeshA          extra meshes (list A)
  u16 nColl           collision meshes
  u16 nMeshB          extra meshes (list B)
  u16 nObj            placed object records
  u16 nPath           road path records
  u16 nNeighbour      length of the dw[] table
Body, in this order:
  Mesh main                      (1 mesh, the ground/road/buildings shell)
  Mesh meshesA[nMeshA]
  Mesh meshesB[nMeshB]
  ObjRec objs[nObj]              (0x54 bytes each)
  CollMesh colls[nColl]
  Path paths[nPath]
  u32 dw[nNeighbour]             neighbour/visible block indices (global block numbers)
```

Pass order when drawing a block: opaque pass = A, B, main, then alpha pass = main, A, B (each mesh draws only the subsets whose material is opaque / transparent respectively). All meshes of a block are in **world space** already (no per-block transform). A, B and main differ only in grouping (e.g. different update/lighting groups); render them identically.

**Streaming / culling:** the game keeps all blocks resident. Each frame it draws the block that contains the camera, plus the blocks listed in that block's `dw[]` (the "visible set"), tested against `sphere`. (`dw` values are global block indices of nearby blocks, not including the block itself; e.g. block 0: `13,15,16,120`.) A web port can instead frustum-cull by `sphere`/`aabb` over all blocks, or use `dw[]` for the visible set.

#### Mesh (`FUN_00416a10`)

```
Header 56 bytes: u32 unk; u32 nVerts; u32 nTris; u32 nSubsets; f32 bbox[6] (min xyz, max xyz); u32 x4 (unused here)
Vertex  [nVerts] x 32 bytes   pos(3f) normal(3f) uv(2f)
Index   [nTris*3] x u16       triangle list, ABSOLUTE vertex indices (BaseVertexIndex 0)
Subset  [nSubsets] x 20 bytes (matIndex, startTri, triCount, minVertex, numVertices)
         -> DrawIndexedPrimitive(TRILIST, 0, minVertex, numVertices, startTri*3, triCount)
         matIndex indexes MaterialList #0.
```

#### ObjRec (0x54 bytes, `FUN_004233b0`)

```
u32 type
f32 m[16]       4x4 row-major world matrix: rows 0-2 = rotation(+scale) with 4th column 0; row 3 = position, w=1.
                (stored as 12 floats m[0..11], then pos xyz at +0x34, then 1.0 at +0x40)
u32 id          index into a def/material/sound list, depending on type
u32 b           extra index (see types)
u8  p0, p1      float distances for sound/sprite types (stored as bytes: 0x0a=10, 0x14=20), then 6 padding bytes
```

| type | count | meaning | `id` indexes | extra |
|---|---|---|---|---|
| 0 | 1738 | static object (mesh from `objects.ref`) | ObjDefList | uses ObjDef.kind/collider |
| 1 | 144 | poster/billboard (mesh from `plakats.ref`) | PlakDefList | `b` = poster material index in MaterialList #2 (for def kind 4) |
| 2 | 189 | movable object (mesh `mobjects.ref`, with `<name>_bound`) | MObjDefList | physics object |
| 3 | 106 | camera-facing textured quad (sign), position only | MaterialList #1 (othtex) | size from material dwords |
| 6 | 16 | sprite with distance range (min=p0, max/radius=p1) | MaterialList #1 | |
| 7 | 6 | positional sound emitter (min=p0, radius=p1) | SoundDefList | |
| 8 | 0 | sprite + sound | `id` = material, `b` = sound | (unused in data) |
| 9 | 75 | **ignored by the original loader** (y=5, id 0) | | |
| 10 | 32 | ambient sound zone, position only | SoundDefList | uses SoundDef p[2]/p[3] as min/max distance |

Placement: `world = meshVertex * frameMatrix * m` (the `.ref` frame matrix is almost always identity; apply it anyway).

#### CollMesh (`FUN_00416900`; 168 in total)

```
u32 nVerts; u32 nTris; f32 bbox[6]
f32 verts[nVerts*3]     (x,y,z, world space)
u16 idx[nTris*3]
```
Used for car/wall collisions (not drawn).

#### Path (`FUN_00421150`; 410 total, the AI/road network and race routes)

```
u32 a          road class flags: 0x80000000 (260), 0x40000000 (120), 0x20000000 (30)  (path+0xc in memory; the minimap FUN_00428c80 draws == 0x80000000 grey, pen 8, == 0x20000000 light blue, pen 6, first->last point; 0x40000000 not drawn)
u16 nPts       u16 pad
f32 length     == polyline length of the points (verified)
f32 width      (3.0 .. ~10.0; lane width / speed hint)
u8  nPrev      u8 nNext   u16 pad
f32 pts[nPts*3]            3D polyline in world space, driving direction
u32 prev[nPrev]            links to previous paths
u32 next[nNext]            links to next paths
```

**Link encoding** (`FUN_004224b0`): for a `u32 v`: `lo = v & 0xffff`, `hi = v >> 16`. If `lo == 0` the target is path number `hi` in the **same block**; otherwise it is path number `hi` in block `dw[lo-1]` (`dw` of the current block). All 942 links resolve to existing paths.

### 1.4 SpawnSlot (0x44 bytes; 8 of them, at EOF)

```
u32 blockIndex        (64 for all 8 in the file)
f32 m[16]             4x4 row-major matrix; translation = row 3 = (-108.2, 0.2, 1124.9) etc.; facing ~ +X/-Z
```
These are the default free-ride start grid (8 cars). The loader turns `blockIndex` into a block pointer after loading.

## 2. `Tracks/trackN.trc` (loader at `yd.c` ~line 16074, `FUN_004...` "Tracks/track%d.trc")

28 files (`track0..track27`), size = `0x210 + 8*nSeg`.

```
0x000 u32  unk0 (= 0x15b3 in every file; ignore)
0x004 u32  startBlock          index into CIT blocks[]
0x008 u32  startPath           path index inside that block
0x00C GridSlot[8]  each: f32 m[16]   4x4 row-major start-grid matrix for car 0..7 (position in row 3, y=0.5). All 8 slots belong to startBlock.
0x20C u32  nSeg
0x210 Seg[nSeg]: { u32 block; u32 path }      ordered list of road paths forming the race circuit
```

How the game uses it (verified on all 28 tracks):
- `seg[0] == (startBlock, startPath)` always; the car grid is placed using the matrices (they may lie slightly outside `startBlock`'s AABB in 7 tracks; fine).
- The route is a **closed loop**: for every seg `k`, `seg[k+1 mod n]` is in `next` of seg `k`'s path (34/34, 28/28, ... for every track). The loader then **overwrites** each segment's `prev`/`next` link arrays with single entries (the previous / next seg of the loop; first seg's prev = last seg) and stores the ordinal in the path (`path+8 = k-1`) so the AI/lap logic can follow the chain. **Laps** = loop completions, count from `config.ini` (`Laps=2`) and the lobby; the start/finish line is the start path.
- AI opponents steer along `pts` of the current seg path and switch to the next seg at the end; checkpoints are the seg polylines themselves (no separate checkpoint list exists).
- Several tracks reuse the same start (tracks 7/9; 10/15/16/19 share start block 175; 2/21 share 203).

Per-track summary (start block/path, nSeg): 0:(50,2,34) 1:(12,2,28) 2:(203,1,29) 3:(54,2,49) 4:(88,3,73) 5:(178,2,73) 6:(25,0,48) 7:(97,2,43) 8:(183,4,48) 9:(97,2,43) 10:(175,2,44) 11:(24,2,53) 12:(6,2,32) 13:(14,0,39) 14:(201,2,30) 15:(175,2,29) 16:(175,2,20) 17:(164,2,32) 18:(80,2,53) 19:(175,2,39) 20:(34,2,32) 21:(203,1,34) 22:(176,1,73) 23:(56,2,34) 24:(5,2,49) 25:(56,2,49) 26:(71,2,30) 27:(199,2,73).

## 3. Other containers (already known, for completeness)

- **BFX1** archive: `'BFX1'`, `u32 count`, `count x {char name[16]; u32 offset; u32 size}`, data follows (offsets absolute).
- **REF!** chunk tree: node = `u32 type, u32 nameLen, u32 dataLen, u32 childCount`, then name, data, children. Types: 1 scene, 3 material (100-byte data, same as 1.1; child type 5 = texture stage, 60 bytes, texture name at +44), 7 material container, 9 frame (64-byte 4x4 matrix), 0xb mesh (80-byte header `[flags, FVF, stride, nVerts, nTris, nSubsets, ...bounds]` + vertices + u16 indices + 20-byte subsets, same subset record as 1.3; a 0xb child = lower-LOD mesh), 0xd/0x21 embedded texture data.
- The REF files used by the city: `Graph/objects.ref` (+ `objects.tex`), `Graph/mobjects.ref`, `Graph/plakats.ref`, `Graph/sky.ref`, `Graph/citstdmat.ref` (+ `citstdmat.tex`: shared standard city materials; the CIT file itself carries the per-city material lists).

## 4. Open items

- Block header `f0` (0/2) and ObjRec bytes `p0/p1` semantics are inferred (sound/sprite distances); `a` field of Path (class flags) and `width` are guesses by magnitude, not by code.
- MaterialList stage state bytes (44 per stage), SoundDef params (other than min/max distance), MObjDef params 0..8 and the exact visibility policy of `dw[]` were not decoded (not needed for rendering the city statically).
- Object type 8 and kind-1 tree variant selection are not exercised by `yerevan.cit`.
