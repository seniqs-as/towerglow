import * as THREE from 'three';

/**
 * A GLB reader of our own, with no DOM and no network.
 *
 * three's `GLTFLoader` is built on `FileLoader`, which uses `fetch()`, and the
 * bundle must not contain one. The files we ship are plain glTF 2.0: one
 * buffer, at most one embedded PNG, no extensions, no sparse accessors, no
 * cubic splines, triangles only. Reading THAT is a couple of hundred lines,
 * and a reader with no `document` in it runs in `node --test` on the real
 * files, which the loader never could.
 *
 * What comes out is what the rest of the code needs from a loader: a scene
 * graph of `Mesh`/`SkinnedMesh`/`Bone` with world matrices updated, skinned
 * meshes bound to their `Skeleton`, `AnimationClip`s whose tracks name the
 * sanitised node names exactly as three would, and the bytes of the base
 * colour image for whoever can turn them into a texture.
 */

const MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

interface AccessorDef {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  sparse?: unknown;
}
interface BufferViewDef {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}
interface PrimitiveDef {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
}
interface NodeDef {
  name?: string;
  children?: number[];
  mesh?: number;
  skin?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
interface GltfJson {
  asset?: { version?: string };
  extensionsRequired?: string[];
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: NodeDef[];
  meshes?: { name?: string; primitives: PrimitiveDef[] }[];
  materials?: {
    name?: string;
    alphaMode?: string;
    doubleSided?: boolean;
    pbrMetallicRoughness?: {
      baseColorFactor?: number[];
      roughnessFactor?: number;
      metallicFactor?: number;
      baseColorTexture?: { index: number };
    };
  }[];
  textures?: { source?: number }[];
  images?: { name?: string; mimeType?: string; bufferView?: number; uri?: string }[];
  accessors?: AccessorDef[];
  bufferViews?: BufferViewDef[];
  buffers?: { byteLength: number; uri?: string }[];
  skins?: { joints: number[]; inverseBindMatrices?: number; skeleton?: number }[];
  animations?: {
    name?: string;
    samplers: { input: number; output: number; interpolation?: string }[];
    channels: { sampler: number; target: { node?: number; path: string } }[];
  }[];
}

export interface GlbImage {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface GlbDocument {
  /** The scene, with world matrices already updated. */
  root: THREE.Group;
  skinned: THREE.SkinnedMesh[];
  animations: THREE.AnimationClip[];
  /** The base colour image of the first material that asks for one, or null when none does. */
  image: GlbImage | null;
  nodeCount: number;
  meshCount: number;
  materialCount: number;
}

type TypedArray = Int8Array | Uint8Array | Int16Array | Uint16Array | Uint32Array | Float32Array;

interface Reader {
  bytes: number;
  make: (length: number) => TypedArray;
  get: (view: DataView, offset: number) => number;
}

const READERS: Readonly<Record<number, Reader>> = {
  5120: { bytes: 1, make: (n) => new Int8Array(n), get: (v, o) => v.getInt8(o) },
  5121: { bytes: 1, make: (n) => new Uint8Array(n), get: (v, o) => v.getUint8(o) },
  5122: { bytes: 2, make: (n) => new Int16Array(n), get: (v, o) => v.getInt16(o, true) },
  5123: { bytes: 2, make: (n) => new Uint16Array(n), get: (v, o) => v.getUint16(o, true) },
  5125: { bytes: 4, make: (n) => new Uint32Array(n), get: (v, o) => v.getUint32(o, true) },
  5126: { bytes: 4, make: (n) => new Float32Array(n), get: (v, o) => v.getFloat32(o, true) },
};

const COMPONENTS: Readonly<Record<string, number>> = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
};

const ATTRIBUTES: Readonly<Record<string, string>> = {
  POSITION: 'position',
  NORMAL: 'normal',
  TEXCOORD_0: 'uv',
  JOINTS_0: 'skinIndex',
  WEIGHTS_0: 'skinWeight',
  COLOR_0: 'color',
};

const PATHS: Readonly<Record<string, string>> = {
  translation: 'position',
  rotation: 'quaternion',
  scale: 'scale',
};

function fail(what: string): never {
  throw new Error(`glb: ${what}`);
}

/** The bytes behind a `?inline` import: everything after the comma, base64. */
export function bytesFromDataUri(dataUri: string): Uint8Array {
  const comma = dataUri.indexOf(',');
  if (comma < 0 || !dataUri.slice(0, comma).endsWith(';base64')) fail('not a base64 data URI');
  const bin = atob(dataUri.slice(comma + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function parseGlb(input: Uint8Array | ArrayBuffer): GlbDocument {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const { json, bin } = splitChunks(bytes);
  return build(json, bin);
}

/* ───────────────────────── the container ───────────────────────── */

function splitChunks(bytes: Uint8Array): { json: GltfJson; bin: DataView } {
  if (bytes.byteLength < 20) fail('file too short to be a GLB');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) fail('not a GLB: bad magic');
  const version = view.getUint32(4, true);
  if (version !== 2) fail(`unsupported GLB version ${version}`);
  const total = view.getUint32(8, true);
  if (total > bytes.byteLength) fail(`truncated: header says ${total} bytes, got ${bytes.byteLength}`);

  let json: GltfJson | null = null;
  let bin: DataView | null = null;
  let offset = 12;
  while (offset + 8 <= total) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > total) fail('truncated chunk');
    if (type === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + length))) as GltfJson;
    } else if (type === CHUNK_BIN && !bin) {
      bin = new DataView(bytes.buffer, bytes.byteOffset + start, length);
    }
    offset = start + length;
  }
  if (!json) fail('no JSON chunk');
  if (!bin) fail('no BIN chunk');
  if (json.asset?.version !== '2.0') fail(`unsupported glTF version ${json.asset?.version ?? '?'}`);
  if (json.extensionsRequired?.length) fail(`requires extensions: ${json.extensionsRequired.join(', ')}`);
  const buffers = json.buffers ?? [];
  if (buffers.length !== 1 || buffers[0]?.uri !== undefined) fail('expected exactly one embedded buffer');
  return { json, bin };
}

/* ───────────────────────── accessors ───────────────────────── */

interface Accessor {
  array: TypedArray;
  itemSize: number;
  normalized: boolean;
  count: number;
}

function readAccessor(json: GltfJson, bin: DataView, index: number): Accessor {
  const def = json.accessors?.[index] ?? fail(`no accessor ${index}`);
  if (def.sparse) fail(`accessor ${index} is sparse`);
  if (def.bufferView === undefined) fail(`accessor ${index} has no buffer view`);
  const reader = READERS[def.componentType] ?? fail(`accessor ${index}: unknown component type ${def.componentType}`);
  const itemSize = COMPONENTS[def.type] ?? fail(`accessor ${index}: unknown type ${def.type}`);
  // Matrix columns of 1- and 2-byte components carry alignment padding in
  // glTF; only float matrices exist in our files, so that case stays out.
  if (itemSize > 4 && reader.bytes < 4) fail(`accessor ${index}: padded matrix components are not supported`);
  const bv = json.bufferViews?.[def.bufferView] ?? fail(`no buffer view ${def.bufferView}`);
  const elementBytes = itemSize * reader.bytes;
  const stride = bv.byteStride ?? elementBytes;
  const base = (bv.byteOffset ?? 0) + (def.byteOffset ?? 0);
  const last = base + (def.count - 1) * stride + elementBytes;
  if (def.count > 0 && last > (bv.byteOffset ?? 0) + bv.byteLength) fail(`accessor ${index} runs past its buffer view`);
  if (def.count > 0 && last > bin.byteLength) fail(`accessor ${index} runs past the binary chunk`);

  // Always de-interleaved, one component at a time: a buffer view with a
  // stride is what glTF-Transform writes, and a typed array view over an
  // interleaved buffer is not something three's merge can consume.
  const array = reader.make(def.count * itemSize);
  for (let i = 0; i < def.count; i++) {
    const at = base + i * stride;
    for (let k = 0; k < itemSize; k++) {
      array[i * itemSize + k] = reader.get(bin, at + k * reader.bytes);
    }
  }
  return { array, itemSize, normalized: def.normalized ?? false, count: def.count };
}

function attributeOf(acc: Accessor): THREE.BufferAttribute {
  return new THREE.BufferAttribute(acc.array, acc.itemSize, acc.normalized);
}

function floatsOf(acc: Accessor, what: string): Float32Array {
  if (!(acc.array instanceof Float32Array)) fail(`${what}: expected float data`);
  return acc.array;
}

/* ───────────────────────── the scene ───────────────────────── */

function build(json: GltfJson, bin: DataView): GlbDocument {
  const materials = (json.materials ?? []).map((m) => {
    const pbr = m.pbrMetallicRoughness;
    const mat = new THREE.MeshStandardMaterial({
      name: m.name ?? '',
      roughness: pbr?.roughnessFactor ?? 1,
      metalness: pbr?.metallicFactor ?? 1,
    });
    // A pack whose parts are painted by their material rather than by an
    // atlas -- the villager's shirt, its trousers, its shoes -- is a figure
    // in white without this. glTF's factor is linear light, which is the
    // space three mixes colour in, so it goes in untouched.
    const f = pbr?.baseColorFactor;
    if (f) {
      mat.color.setRGB(f[0] ?? 1, f[1] ?? 1, f[2] ?? 1, THREE.LinearSRGBColorSpace);
      const alpha = f[3] ?? 1;
      if (alpha < 1) {
        mat.opacity = alpha;
        mat.transparent = true;
      }
    }
    if (m.alphaMode === 'BLEND') mat.transparent = true;
    if (m.doubleSided) mat.side = THREE.DoubleSide;
    // Which image this material's colour comes from, for whoever can decode
    // a PNG: this reader has no DOM and cannot make a texture, and a caller
    // handed one cannot otherwise tell which materials asked for it.
    const tex = pbr?.baseColorTexture?.index;
    if (tex !== undefined) mat.userData.baseColorImage = json.textures?.[tex]?.source ?? 0;
    return mat;
  });
  const fallback = new THREE.MeshStandardMaterial();

  const geometries = new Map<string, THREE.BufferGeometry>();
  const geometryFor = (meshIndex: number, primIndex: number, prim: PrimitiveDef): THREE.BufferGeometry => {
    const key = `${meshIndex}/${primIndex}`;
    let geo = geometries.get(key);
    if (geo) return geo;
    if ((prim.mode ?? 4) !== 4) fail(`mesh ${meshIndex}: only triangle lists are supported`);
    geo = new THREE.BufferGeometry();
    for (const [semantic, index] of Object.entries(prim.attributes)) {
      const name = ATTRIBUTES[semantic];
      if (!name) continue; // TANGENT, TEXCOORD_1...: nothing here draws them
      geo.setAttribute(name, attributeOf(readAccessor(json, bin, index)));
    }
    if (!geo.getAttribute('position')) fail(`mesh ${meshIndex} has no POSITION`);
    if (prim.indices !== undefined) geo.setIndex(attributeOf(readAccessor(json, bin, prim.indices)));
    geometries.set(key, geo);
    return geo;
  };

  const nodeDefs = json.nodes ?? [];
  const joints = new Set<number>();
  for (const skin of json.skins ?? []) for (const j of skin.joints) joints.add(j);

  // Objects first, hierarchy second: a child may be listed before its parent.
  const objects: THREE.Object3D[] = nodeDefs.map((def, i) => {
    const name = THREE.PropertyBinding.sanitizeNodeName(def.name ?? '');
    let obj: THREE.Object3D;
    if (def.mesh !== undefined) {
      const mesh = json.meshes?.[def.mesh] ?? fail(`node ${i}: no mesh ${def.mesh}`);
      const prims = mesh.primitives.map((prim, p) => {
        const geo = geometryFor(def.mesh!, p, prim);
        const mat = prim.material !== undefined ? materials[prim.material] ?? fallback : fallback;
        const skinned = def.skin !== undefined && geo.getAttribute('skinIndex') !== undefined;
        return skinned ? new THREE.SkinnedMesh(geo, mat) : new THREE.Mesh(geo, mat);
      });
      if (prims.length === 1) {
        obj = prims[0]!;
      } else {
        obj = new THREE.Group();
        prims.forEach((m, p) => {
          m.name = `${name}_${p}`;
          obj.add(m);
        });
      }
    } else if (joints.has(i)) {
      obj = new THREE.Bone();
    } else {
      obj = new THREE.Group();
    }
    obj.name = name;
    if (def.matrix) {
      obj.matrix.fromArray(def.matrix);
      obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
    } else {
      if (def.translation) obj.position.fromArray(def.translation);
      if (def.rotation) obj.quaternion.fromArray(def.rotation);
      if (def.scale) obj.scale.fromArray(def.scale);
    }
    return obj;
  });

  nodeDefs.forEach((def, i) => {
    for (const c of def.children ?? []) {
      const child = objects[c] ?? fail(`node ${i}: no child ${c}`);
      objects[i]!.add(child);
    }
  });

  const root = new THREE.Group();
  root.name = 'scene';
  const scene = json.scenes?.[json.scene ?? 0] ?? fail('no scene');
  for (const n of scene.nodes ?? []) root.add(objects[n] ?? fail(`scene: no node ${n}`));
  root.updateMatrixWorld(true);

  // Skins, after the world matrices exist: binding takes the mesh's own.
  // One skeleton per skin, shared by every mesh that names it, exactly as
  // three's loader does: the crew's six meshes are one body, and the bake
  // steps one skeleton for all of them.
  const skeletons = new Map<number, THREE.Skeleton>();
  const skeletonFor = (index: number): THREE.Skeleton => {
    const cached = skeletons.get(index);
    if (cached) return cached;
    const skin = json.skins?.[index] ?? fail(`no skin ${index}`);
    const bones = skin.joints.map((j) => {
      const b = objects[j];
      if (!(b instanceof THREE.Bone)) fail(`skin ${index}: joint ${j} is not a bone`);
      return b;
    });
    let inverses: THREE.Matrix4[] | undefined;
    if (skin.inverseBindMatrices !== undefined) {
      const ibm = floatsOf(readAccessor(json, bin, skin.inverseBindMatrices), 'inverse bind matrices');
      inverses = bones.map((_, k) => new THREE.Matrix4().fromArray(ibm, k * 16));
    }
    const skeleton = new THREE.Skeleton(bones, inverses);
    skeletons.set(index, skeleton);
    return skeleton;
  };
  const skinned: THREE.SkinnedMesh[] = [];
  nodeDefs.forEach((def, i) => {
    if (def.skin === undefined) return;
    const skeleton = skeletonFor(def.skin);
    objects[i]!.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh) {
        o.bind(skeleton, o.matrixWorld);
        o.normalizeSkinWeights();
        skinned.push(o);
      }
    });
  });

  const animations = (json.animations ?? []).map((an, a) => {
    const tracks: THREE.KeyframeTrack[] = [];
    an.channels.forEach((ch, c) => {
      if (ch.target.node === undefined) return; // an animation of nothing
      const sampler = an.samplers[ch.sampler] ?? fail(`animation ${a}: no sampler ${ch.sampler}`);
      const interpolation = sampler.interpolation ?? 'LINEAR';
      if (interpolation === 'CUBICSPLINE') fail(`animation ${a}: cubic splines are not supported`);
      const property = PATHS[ch.target.path] ?? fail(`animation ${a} channel ${c}: unsupported path ${ch.target.path}`);
      const target = objects[ch.target.node] ?? fail(`animation ${a}: no node ${ch.target.node}`);
      const times = floatsOf(readAccessor(json, bin, sampler.input), 'animation times');
      const values = floatsOf(readAccessor(json, bin, sampler.output), 'animation values');
      const name = `${target.name}.${property}`;
      const mode = interpolation === 'STEP' ? THREE.InterpolateDiscrete : THREE.InterpolateLinear;
      tracks.push(property === 'quaternion'
        ? new THREE.QuaternionKeyframeTrack(name, times, values, mode)
        : new THREE.VectorKeyframeTrack(name, times, values, mode));
    });
    return new THREE.AnimationClip(an.name ?? `animation_${a}`, -1, tracks);
  });

  return {
    root,
    skinned,
    animations,
    image: baseColorImage(json, bin),
    nodeCount: nodeDefs.length,
    meshCount: json.meshes?.length ?? 0,
    materialCount: materials.length,
  };
}

function baseColorImage(json: GltfJson, bin: DataView): GlbImage | null {
  // The first material that asks for one, not the first material: the
  // villager's first material is its belt buckle, which is painted by hand,
  // and its face atlas hangs off the ninth.
  const texIndex = json.materials?.find((m) => m.pbrMetallicRoughness?.baseColorTexture)
    ?.pbrMetallicRoughness?.baseColorTexture?.index;
  if (texIndex === undefined) return null;
  const source = json.textures?.[texIndex]?.source;
  if (source === undefined) return null;
  const img = json.images?.[source] ?? fail(`no image ${source}`);
  if (img.bufferView === undefined) fail('only embedded images are supported');
  const bv = json.bufferViews?.[img.bufferView] ?? fail(`no buffer view ${img.bufferView}`);
  const start = bv.byteOffset ?? 0;
  if (start + bv.byteLength > bin.byteLength) fail('image runs past the binary chunk');
  const bytes = new Uint8Array(bin.buffer, bin.byteOffset + start, bv.byteLength).slice();
  return { name: img.name ?? '', mimeType: img.mimeType ?? 'application/octet-stream', bytes };
}
