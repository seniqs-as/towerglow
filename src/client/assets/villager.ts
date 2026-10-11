import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GlbDocument } from './glb.ts';

/**
 * You, as the colony draws you: a villager in ordinary clothes.
 *
 * The pack is a wardrobe, not a character. One armature carries three heads,
 * three beards, three hairstyles, seven bits of gear and six outfits, all
 * skinned at once and all in the file: loading it whole puts a figure on
 * screen wearing every beard it owns. So the build keeps exactly one of
 * each thing a person has one of (`VILLAGER_PARTS`) and drops the rest,
 * which is also what makes the choice a decision written down here rather
 * than an accident of what the exporter left in. The one thing it wears
 * that the pack does not carry is the cap: see `capFor`.
 *
 * It is not baked into the crew's bone texture (`crew.ts`). That bake exists
 * because the colony can hold hundreds of astronauts; there is exactly one
 * of you, and one character is what three's own skinning is for. It also
 * means the two never have to share a skeleton: this one has seventeen
 * bones, the mannequin twenty-one, and retargeting between them would buy
 * nothing -- you stand and you walk, and both clips are in the file.
 *
 * Nothing here touches the DOM. The face atlas arrives as a texture from
 * whoever could decode a PNG, or as null in a test.
 */

/**
 * The parts kept: one body, one head with its eyes, brows and mouth, one
 * hairstyle, and plain clothes. No beard, no gear, no outfit -- the outfits
 * in the pack are an apron, a robe and a tabard, and you are not in costume.
 */
export const VILLAGER_PARTS: readonly string[] = [
  'Body',
  'Head_A_0',
  'Head_A_1',
  'Head_A_2',
  'Head_A_3',
  'Hair_Short',
  'Base_Shirt',
  'Base_Trousers',
  'Base_Shoes',
  'Base_Belt',
];

/**
 * What the pack leaves white for the game to choose, by material name. Skin
 * and hair carry no colour of their own in the file: their meshes are white
 * with a shading gradient in the vertex colours, which is exactly a tint
 * waiting to be picked. The clothes do carry theirs, and keep it.
 */
const TINT: Readonly<Record<string, number>> = {
  'Skin.001': 0xe3b08d,
  'Hair.001': 0x4a3427,
  HairBrows: 0x4a3427,
};

/**
 * How big you stand: 1.66 m, against an astronaut's 1.22 m and a CEO's 1.34
 * at its desk (`CEO_SIZE`). The pack's villager is 1.85 units from the floor
 * to the crown, so this is that height over those units.
 *
 * It was 0.66 -- exactly the crew's height -- until the user asked for the
 * opposite (2026-09-20): you are a person and they are the crew, and the one
 * who walks in is the taller of the two. It is one figure and one number: the
 * same you climbs the ramp among the astronauts and stands at the desk.
 */
export const VILLAGER_SCALE = 0.9;

/**
 * The cap, and the fact that it is built rather than worn.
 *
 * The pack carries a wardrobe -- heads, beards, hair, glasses, shades, a
 * lute, a sack, a stethoscope, a sword, a bow, six outfits -- and no hat of
 * any kind. So this one is two primitives on the head bone, in the pack's
 * own flat-shaded style. When the pack grows a hat mesh, put its name in
 * `VILLAGER_PARTS` and delete `capFor`.
 */
const CAP_COLOR = 0xf4f3ef;

/** The clips in the file, by the job the figure gives them. */
const CLIP_NAMES = { idle: 'Idle', walk: 'Walk' } as const;

export interface VillagerBody {
  /**
   * The figure, posed in its bind pose: a template to clone, never drawn as
   * it is. Two places show you -- the ramp and the room -- and a skeleton
   * can only hold one pose at a time.
   */
  root: THREE.Object3D;
  idle: THREE.AnimationClip;
  walk: THREE.AnimationClip;
}

/** Pick the one villager out of the wardrobe. Synchronous, and cheap. */
export function buildVillager(doc: GlbDocument, face: THREE.Texture | null): VillagerBody {
  const root = doc.root;
  root.updateMatrixWorld(true);

  const keep = new Set(VILLAGER_PARTS);
  const drop: THREE.Object3D[] = [];
  for (const mesh of doc.skinned) {
    if (keep.has(mesh.name)) dress(mesh, face);
    else drop.push(mesh);
  }
  for (const mesh of drop) {
    mesh.removeFromParent();
    if (mesh instanceof THREE.Mesh) mesh.geometry.dispose();
  }
  const worn = doc.skinned.filter((m) => keep.has(m.name));
  if (worn.length !== keep.size) {
    const missing = VILLAGER_PARTS.filter((n) => !worn.some((m) => m.name === n));
    throw new Error(`villager: the pack has no ${missing.join(', ')}`);
  }
  // The groups the dropped heads hung off are empty now, and an empty group
  // is a node the clone walks for nothing.
  for (const node of [...root.children]) prune(node);

  const head = worn[0]?.skeleton.bones.find((b) => b.name === 'Head');
  if (!head) throw new Error('villager: the pack has no head bone to hang a cap on');
  head.add(capFor(head));

  return { root, idle: clipOf(doc, CLIP_NAMES.idle), walk: clipOf(doc, CLIP_NAMES.walk) };
}

/**
 * One part, ready to draw: its own material (the pack shares one between the
 * belt and every piece of gear, and a tint on a shared material paints all
 * of them), its shading gradient switched on, its tint applied, and the face
 * atlas on the three materials that asked for it.
 */
function dress(mesh: THREE.SkinnedMesh, face: THREE.Texture | null): void {
  const source = mesh.material;
  if (Array.isArray(source)) throw new Error(`villager: ${mesh.name} has more than one material`);
  const mat = source.clone() as THREE.MeshStandardMaterial;
  mesh.material = mat;
  mat.vertexColors = mesh.geometry.getAttribute('color') !== undefined;
  const tint = TINT[mat.name];
  if (tint !== undefined) mat.color.setHex(tint);
  if (mat.userData.baseColorImage !== undefined && face) {
    face.colorSpace = THREE.SRGBColorSpace;
    mat.map = face;
    mat.needsUpdate = true;
  }
  // Shadows from the colony's sun, on the ramp. Nothing receives: the figure
  // is small and the two lamps inside the ship cast nothing at all.
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false; // it is one figure, and it is the one you are looking at
}

/**
 * The cap, as a child of the head bone: a crown over the hair and a peak
 * over the eyes. Built in the figure's own rest frame -- where the pack's
 * measurements are readable, the skull between y 1.53 and 1.80 and the short
 * hair on top of it up to 1.85 -- and then pulled into the bone's frame, so
 * it rides the head through every clip without being skinned to anything.
 */
function capFor(head: THREE.Bone): THREE.Mesh {
  // A dome that swallows the hair it sits on and little else: its top is
  // 1.87, a shade over the hair's 1.847, and its brim line at 1.715 sits
  // above the brows, so the short hair still shows at the back and the
  // sides. Wider than this and it reads as a helmet, not a cap.
  const crown = new THREE.SphereGeometry(0.155, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  crown.scale(1, 1.0, 1.02);
  crown.translate(0, 1.715, 0.005);
  // The peak: half a disc, tipped down a little, out over the face (+Z).
  const peak = new THREE.CylinderGeometry(0.19, 0.19, 0.022, 20, 1, false, -Math.PI / 2, Math.PI);
  peak.scale(1, 1, 1.15);
  peak.rotateX(-0.13);
  peak.translate(0, 1.722, 0.03);
  const geometry = mergeGeometries([crown, peak], false);
  if (!geometry) throw new Error('villager: could not merge the cap');
  crown.dispose();
  peak.dispose();
  // Into the head bone's frame, so the bone's own transform carries it.
  geometry.applyMatrix4(new THREE.Matrix4().copy(head.matrixWorld).invert());

  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    name: 'Cap',
    color: CAP_COLOR,
    roughness: 0.78,
    metalness: 0,
  }));
  mesh.name = 'Cap';
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

/** Drop a node that no longer holds anything drawn, and nothing else. */
function prune(node: THREE.Object3D): void {
  for (const child of [...node.children]) prune(child);
  const empty = node.children.length === 0 && node.type === 'Group';
  if (empty) node.removeFromParent();
}

function clipOf(doc: GlbDocument, name: string): THREE.AnimationClip {
  const clip = doc.animations.find((c) => c.name === name);
  // The file is ours and checked in: a missing clip is a build error, not
  // something to limp past with a figure frozen in its bind pose.
  if (!clip) throw new Error(`villager: villager.glb has no clip "${name}"`);
  return clip;
}
