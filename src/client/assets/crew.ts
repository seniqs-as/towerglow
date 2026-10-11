import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GlbDocument } from './glb.ts';

/**
 * Real skeletal animation for the whole crew, in one draw call. Ported from
 * Bot Crossing; only the loading changed.
 *
 * The body is KayKit's Mannequin_Medium and the motion is KayKit's Character
 * Animations (both CC0): hand-authored walk cycles, hammering, sitting,
 * cheering. What they are not is instanceable: three skins a `SkinnedMesh`
 * from a `Skeleton` object, one skeleton per character, which for three
 * hundred sessions means three hundred draw calls and three hundred
 * skeletons stepped on the CPU every frame.
 *
 * So the animation is BAKED ONCE, at load, into a bone-matrix texture. Every
 * clip is sampled at a fixed rate and each frame's twenty-one skinning
 * matrices are written into a float texture. At draw time one
 * `InstancedMesh` carries the whole crew, and each instance reads its own row
 * of that texture from a single per-instance float: the frame it is on.
 *
 * The cost is a texture of about a megabyte and a second of work at boot.
 * What it buys is that the crew costs the same whether there are six of them
 * or six hundred.
 *
 * Because the matrices also sit in an ordinary array on the CPU, anything
 * that has to ride ON a bone -- the helmet, the visor, the backpack -- can be
 * placed by reading one matrix out of it, with no skeleton to evaluate.
 */

/** Sampling rate for the bake. Fast enough that the shader's lerp has nothing to hide. */
export const BAKE_FPS = 30;

/** Floats per bone in the texture: a full mat4, four RGBA texels. */
const TEXELS_PER_BONE = 4;

/**
 * Bones the colony hangs things off. Their WORLD transforms are baked into a
 * small side-table on the CPU as well, because a helmet does not want the
 * skinning matrix: it wants to know where the head actually is.
 */
export const ATTACH = ['head', 'chest', 'hand.r'] as const;
export type AttachName = (typeof ATTACH)[number];

/**
 * The clips, and how the colony uses them. `loop` false means the clip is a
 * one-shot that holds on its last frame, which is what a sit-down or a spawn
 * wants.
 */
export const CLIP = {
  idle: { name: 'Idle_A', loop: true },
  idleAlt: { name: 'Idle_B', loop: true },
  walk: { name: 'Walking_A', loop: true },
  run: { name: 'Running_A', loop: true },
  work: { name: 'Hammering', loop: true },
  workAlt: { name: 'Working_A', loop: true },
  cheer: { name: 'Cheering', loop: true },
  jump: { name: 'Jump_Full_Short', loop: false },
  wave: { name: 'Waving', loop: true },
  sitDown: { name: 'Sit_Floor_Down', loop: false },
  sit: { name: 'Sit_Floor_Idle', loop: true },
  sitDesk: { name: 'Sit_Floor_Idle', loop: true },
  standUp: { name: 'Sit_Floor_StandUp', loop: false },
  hit: { name: 'Hit_A', loop: true },
  spawn: { name: 'Spawn_Ground', loop: false },
  interact: { name: 'Interact', loop: true },
} as const;

export type ClipKey = keyof typeof CLIP;
export const CLIP_KEYS = Object.keys(CLIP) as ClipKey[];

/**
 * Clips baked with the head pinned to the pose their first frame has it in.
 *
 * `Sit_Floor_Idle` is authored for someone sitting alone on the ground: over
 * its four seconds the head swings 35 degrees to the left and back. Behind a
 * desk that is two CEOs turning away from you together, because both start
 * the loop on the frame they sat down on. So the desk gets its own bake of
 * the same clip with the head left where the clip starts -- facing whoever
 * came in -- and the body still breathes. The floor keeps the original: an
 * astronaut asleep on its plot is exactly who the clip was authored for.
 */
const HOLD_HEAD: ReadonlySet<ClipKey> = new Set<ClipKey>(['sitDesk']);

export interface ClipSpec {
  /** First row of the clip in the frame table. */
  start: number;
  frames: number;
  duration: number;
  loop: boolean;
  name: string;
}

export interface CrewRig {
  geometry: THREE.BufferGeometry;
  bones: THREE.Bone[];
  boneIndex: Map<string, number>;
  boneTexture: THREE.DataTexture;
  /** World transforms of the attachment bones, one mat4 per bone per frame. */
  attach: Float32Array;
  attachSlot: Map<AttachName, number>;
  boneCount: number;
  frameCount: number;
  clips: Record<ClipKey, ClipSpec>;
  fps: number;
}

/**
 * The mannequin's own head is left out of the body: the colony puts its own
 * helmet, visor and screen-face on the head bone instead, which is the
 * whole of the astronaut's identity.
 */
const DROP_MESHES = ['Mannequin_Medium_Head'];

/** Bake the rig from a parsed `crew.glb`. Synchronous; about a second. */
export function bakeCrew(doc: GlbDocument, dropMeshes: readonly string[] = DROP_MESHES): CrewRig {
  const root = doc.root;
  root.updateMatrixWorld(true);
  const skinned = doc.skinned;
  const first = skinned[0];
  if (!first) throw new Error('crew: crew.glb has no skinned mesh');

  const skeleton = first.skeleton;
  const bones = skeleton.bones;
  const boneIndex = new Map(bones.map((b, i) => [b.name, i]));

  const geometry = mergeBody(skinned, dropMeshes);
  const baked = bakeClips(root, skeleton, first, doc.animations);

  return { geometry, bones, boneIndex, ...baked };
}

/**
 * Merge the mannequin's parts into one geometry.
 *
 * They already share a skin, so the joint indices line up and no remapping
 * is needed. The UVs go: the pack's texture is a name badge and a smiley,
 * and the colony paints its crew from its own suit palette instead.
 */
function mergeBody(skinned: readonly THREE.SkinnedMesh[], dropMeshes: readonly string[]): THREE.BufferGeometry {
  const drop = new Set(dropMeshes);
  const parts: THREE.BufferGeometry[] = [];

  for (const mesh of skinned) {
    if (drop.has(mesh.name)) continue;
    const geo = new THREE.BufferGeometry();
    const src = mesh.geometry;
    const count = src.getAttribute('position').count;

    for (const [name, size] of [
      ['position', 3], ['normal', 3], ['skinIndex', 4], ['skinWeight', 4],
    ] as const) {
      const a = src.getAttribute(name);
      if (!a) throw new Error(`crew: ${mesh.name} has no ${name}`);
      const data = new Float32Array(count * size);
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < size; k++) data[i * size + k] = a.getComponent(i, k);
      }
      geo.setAttribute(name, new THREE.BufferAttribute(data, size));
    }
    if (src.index) geo.setIndex(Array.from(src.index.array));
    parts.push(geo);
  }

  const one = parts[0];
  if (!one) throw new Error('crew: every mesh of the body was dropped');
  const merged = parts.length === 1 ? one : mergeGeometries(parts, false);
  if (!merged) throw new Error('crew: could not merge the body');
  if (merged !== one) for (const g of parts) g.dispose();
  merged.computeBoundingBox();
  return merged;
}

/**
 * Step every clip and record the skinning matrices.
 *
 * What is stored is the matrix the shader can use directly -- three's bind
 * matrices folded in -- so the vertex stage is a plain weighted sum with
 * nothing left to reconstruct.
 */
function bakeClips(
  root: THREE.Object3D,
  skeleton: THREE.Skeleton,
  mesh: THREE.SkinnedMesh,
  animations: readonly THREE.AnimationClip[],
): Omit<CrewRig, 'geometry' | 'bones' | 'boneIndex'> {
  const boneCount = skeleton.bones.length;
  const byName = new Map(animations.map((a) => [a.name, a]));

  // Lay the clips out end to end in one table and remember where each one starts.
  const clips = {} as Record<ClipKey, ClipSpec>;
  let frameCount = 0;
  for (const key of CLIP_KEYS) {
    const spec = CLIP[key];
    const clip = byName.get(spec.name);
    // The file is ours and checked in: a clip that is not there is a build
    // error, not something to limp past with a frozen astronaut.
    if (!clip) throw new Error(`crew: crew.glb has no clip "${spec.name}"`);
    // A looping clip needs its wrap-around frame; a one-shot ends where it ends.
    const frames = Math.max(2, Math.round(clip.duration * BAKE_FPS) + 1);
    clips[key] = { start: frameCount, frames, duration: clip.duration, loop: spec.loop, name: spec.name };
    frameCount += frames;
  }

  const stride = boneCount * TEXELS_PER_BONE * 4;
  const data = new Float32Array(frameCount * stride);

  // Side-table of world transforms for the attachment bones: what the helmet
  // and backpack read. The skinning matrices in `data` cannot answer "where
  // is the head": they map bind space to posed space, which is only the same
  // thing when the bind matrices are identity. Node names arrive sanitised
  // (a dot is a path separator in an animation track, so `hand.r` is
  // `handr`); matching loosely costs nothing and the alternative is a table
  // of silent zeros and a prop pinned to the world origin.
  const plain = (n: string): string => n.replace(/[.\s_]/g, '').toLowerCase();
  const attachBones = ATTACH.map((name) => skeleton.bones.findIndex((b) => plain(b.name) === plain(name)));
  const lost = ATTACH.filter((_, i) => attachBones[i]! < 0);
  if (lost.length) throw new Error(`crew: no bone for attachment ${lost.join(', ')}`);
  const attach = new Float32Array(frameCount * ATTACH.length * 16);

  const mixer = new THREE.AnimationMixer(root);
  const scratch = new THREE.Matrix4();
  // `world * bindMatrixInverse * bone * bindMatrix` is the whole of three's
  // skinning pipeline for a vertex, so baking it means the shader has only
  // the weighted sum left. The mesh's own world matrix belongs in there
  // because the merged geometry is left in its authored frame.
  const bind = mesh.bindMatrix;
  const pre = new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse);

  const headBone = skeleton.bones[attachBones[ATTACH.indexOf('head')]!]!;

  for (const key of CLIP_KEYS) {
    const spec = clips[key];
    const clip = byName.get(spec.name)!;
    const action = mixer.clipAction(clip);
    action.play();

    // Where this clip starts the head, when the head is to be held there.
    // Read off the clip itself rather than off the bind pose: the bind pose
    // is a mannequin standing up, and a seated body wears its head at a
    // different angle on the neck.
    let held: THREE.Quaternion | null = null;
    if (HOLD_HEAD.has(key)) {
      mixer.setTime(0);
      held = headBone.quaternion.clone();
    }

    for (let f = 0; f < spec.frames; f++) {
      const raw = spec.frames > 1 ? (f / (spec.frames - 1)) * spec.duration : 0;
      // The last frame of a loop is the clip's own end, which equals its
      // start again: exactly the wrap frame the shader interpolates into. A
      // one-shot must stop just short of it: sampled at precisely its
      // duration the mixer's default loop mode wraps, so the frame a
      // sit-down or a spawn HOLDS would be the pose it started from.
      const t = spec.loop ? raw : Math.min(raw, Math.max(0, spec.duration - 1e-3));
      mixer.setTime(t);
      // After the mixer, before the world matrices: the mixer writes the
      // bone's local rotation and this is the one thing that overrules it.
      if (held) headBone.quaternion.copy(held);
      root.updateMatrixWorld(true);
      skeleton.update();
      const boneMatrices = skeleton.boneMatrices;
      if (!boneMatrices) throw new Error('crew: the skeleton has no bone matrices');

      const offset = (spec.start + f) * stride;
      for (let b = 0; b < boneCount; b++) {
        scratch.fromArray(boneMatrices, b * 16);
        scratch.premultiply(pre).multiply(bind);
        scratch.toArray(data, offset + b * 16);
      }

      const attachOffset = (spec.start + f) * ATTACH.length * 16;
      attachBones.forEach((b, slot) => {
        if (b < 0) return;
        skeleton.bones[b]!.matrixWorld.toArray(attach, attachOffset + slot * 16);
      });
    }

    action.stop();
  }

  const texture = new THREE.DataTexture(
    data,
    boneCount * TEXELS_PER_BONE,
    frameCount,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  mixer.stopAllAction();
  mixer.uncacheRoot(root);

  return {
    boneTexture: texture,
    attach,
    attachSlot: new Map(ATTACH.map((name, i) => [name, i])),
    boneCount,
    frameCount,
    clips,
    fps: BAKE_FPS,
  };
}

/**
 * Where an attachment bone is, in character space, on a given frame.
 *
 * This is how anything worn rather than skinned gets placed: the helmet
 * reads `head`, the backpack reads `chest`. A straight array slice: no
 * skeleton is evaluated and nothing is allocated. The frame is rounded
 * rather than interpolated; at 30 fps the worst case is half a frame of lag
 * on a helmet whose own body is drawn from the same table.
 */
export function attachMatrixAt(rig: CrewRig, frame: number, slot: number, out: THREE.Matrix4): THREE.Matrix4 {
  const f = Math.min(rig.frameCount - 1, Math.max(0, Math.round(frame)));
  return out.fromArray(rig.attach, (f * ATTACH.length + slot) * 16);
}

/**
 * Where in the frame table an agent is, given a clip and how long it has
 * been playing. Looping clips wrap; one-shots hold their last frame.
 */
export function frameFor(clip: ClipSpec | null | undefined, time: number): number {
  if (!clip) return 0;
  const last = clip.frames - 1;
  const f = time * BAKE_FPS;
  return clip.start + (clip.loop ? f % last : Math.min(f, last));
}

/**
 * Adds GPU skinning to any three material.
 *
 * Slotted in around `<beginnormal_vertex>` and `<begin_vertex>`, which are
 * upstream of three's own instancing, so the skinned vertex still goes
 * through `instanceMatrix` and the crew stays one instanced draw. Three's
 * `USE_SKINNING` path is deliberately not used: it binds to a `Skeleton`
 * object, which is the thing being replaced.
 *
 * `normals` must be false for the shadow pass. Three's depth shader only
 * includes `<beginnormal_vertex>` behind `USE_DISPLACEMENTMAP`, so a depth
 * material decorated as if it had normals would skin against an
 * uninitialised matrix and the crew would cast the shadow of a folded-up
 * bind pose.
 */
export function decorateSkinned<T extends THREE.Material>(
  material: T,
  uniforms: Record<string, THREE.IUniform>,
  { normals = true }: { normals?: boolean } = {},
): T {
  material.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms): void => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
       attribute vec4 skinIndex;
       attribute vec4 skinWeight;
       attribute float aFrame;
       uniform highp sampler2D uBones;
       uniform float uFrameMax;

       mat4 boneAt( int bone, int row ) {
         int x = bone * ${TEXELS_PER_BONE};
         return mat4(
           texelFetch( uBones, ivec2( x + 0, row ), 0 ),
           texelFetch( uBones, ivec2( x + 1, row ), 0 ),
           texelFetch( uBones, ivec2( x + 2, row ), 0 ),
           texelFetch( uBones, ivec2( x + 3, row ), 0 )
         );
       }

       // The two rows either side of a fractional frame, mixed. A
       // component-wise mix of two skinning matrices is not a true
       // interpolation, but a thirtieth of a second apart the error is far
       // below a pixel and it costs one instruction. Both rows are clamped:
       // a one-shot clip holds on its last frame, and its "next" row would
       // otherwise be the first frame of whatever clip was baked after it.
       mat4 botSkinMatrix() {
         float f = clamp( aFrame, 0.0, uFrameMax );
         int a = int( floor( f ) );
         int b = min( a + 1, int( uFrameMax ) );
         float t = f - float( a );
         mat4 m = mat4( 0.0 );
         for ( int i = 0; i < 4; i ++ ) {
           float w = skinWeight[ i ];
           if ( w <= 0.0 ) continue;
           int bone = int( skinIndex[ i ] );
           m += w * ( boneAt( bone, a ) * ( 1.0 - t ) + boneAt( bone, b ) * t );
         }
         return m;
       }

       mat4 botSkin;`,
    );

    if (normals) {
      // Three runs the normal stage first, so the matrix is built there and
      // the position stage reuses it: one set of texture fetches per vertex.
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
           botSkin = botSkinMatrix();
           objectNormal = mat3( botSkin ) * objectNormal;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           transformed = ( botSkin * vec4( transformed, 1.0 ) ).xyz;`,
        );
    } else {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         botSkin = botSkinMatrix();
         transformed = ( botSkin * vec4( transformed, 1.0 ) ).xyz;`,
      );
    }
  };
  return material;
}
