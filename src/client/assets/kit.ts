import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GlbDocument } from './glb.ts';

/**
 * The model kits: KayKit's *Space Base Bits* and *Forest Nature Pack* (both
 * CC0), each packed into one glb and harvested exactly once here. Ported
 * from Bot Crossing; only the loading changed, because the bytes now arrive
 * from `parseGlb` instead of a network loader.
 *
 * Their shared design is what makes them worth building on: every model in
 * a pack UVs into a single 1024px gradient atlas and therefore shares a
 * single material, so a colony assembled out of one collapses to one draw
 * call per building. Nothing downstream needs to know a model came from a
 * file rather than a primitive: `part()` hands back a plain BufferGeometry
 * with its node transform already baked in.
 *
 * The base kit's atlas is an 8x4 grid of gradient swatches, so a *cell
 * index* is a stable name for a material. That is what lets the building
 * shader repaint one swatch -- the gold trim band, cell 11 -- into each
 * project's accent colour without touching a texture or splitting the mesh.
 *
 * The two kits keep separate part registries because they have separate
 * atlases: a geometry can only carry one material, so a habitat and a fir
 * tree can never merge into one mesh.
 */

/** Columns and rows in the gradient atlas. */
export const ATLAS = { cols: 8, rows: 4 } as const;

/**
 * Cells worth naming. Everything else is structure and stays the colour Kay
 * painted it. `TRIM` is the gold band that runs round the habitats, edges the
 * airlocks and fills the window strips: the one swatch that reads as "this
 * building's colour", which is why it is the one the accent replaces and the
 * one that lights up after dark.
 */
export const CELL = {
  WHITE: 1,
  GREY: 2,
  SLATE: 3,
  BLACK: 4,
  ROCK: 7,
  TRIM: 11,
  RED: 12,
  SOLAR_A: 28,
  SOLAR_B: 29,
} as const;

export type KitId = 'base' | 'forest';

interface Kit {
  parts: Map<string, THREE.BufferGeometry>;
  solo: Map<string, THREE.BufferGeometry>;
  atlas: THREE.Texture | null;
}

const KITS: Readonly<Record<KitId, Kit>> = {
  /** Space Base Bits: every building, and the colony's hard surfaces. */
  base: { parts: new Map(), solo: new Map(), atlas: null },
  /** Forest Nature Pack: trees, bushes, grass, and the boulders on every world. */
  forest: { parts: new Map(), solo: new Map(), atlas: null },
};

/**
 * Harvest a parsed pack into a kit. The atlas texture is whatever the caller
 * could make of the pack's image: a real texture in the browser, null in a
 * test, where only the geometry matters.
 */
export function loadKit(id: KitId, doc: GlbDocument, atlas: THREE.Texture | null): void {
  const kit = KITS[id];
  for (const g of kit.parts.values()) g.dispose();
  for (const g of kit.solo.values()) g.dispose();
  kit.parts.clear();
  kit.solo.clear();
  doc.root.updateMatrixWorld(true);
  for (const node of doc.root.children) harvest(node, kit);
  kit.atlas = atlas ? prepareAtlas(atlas) : null;
}

/** True once `loadKit` has run for this kit. */
export function kitReady(id: KitId): boolean {
  return KITS[id].parts.size > 0;
}

/**
 * Bake one node into geometry in its own local frame, twice.
 *
 * `parts` gets the node WITH everything under it, which is what a recipe
 * usually wants: a rover arrives with its wheels on. `solo` gets the node's
 * own mesh alone, which is what a recipe wants when a sub-part has to move
 * independently: the pack names a turbine's rotor and a garage's door
 * separately precisely because those are the bits that turn and slide, and a
 * spinning rotor has to be built from a tower that has not already got one.
 *
 * Sub-nodes are harvested as parts in their own right as well.
 */
function harvest(node: THREE.Object3D, kit: Kit): void {
  const inverse = new THREE.Matrix4().copy(node.matrixWorld).invert();
  const bake = (mesh: THREE.Mesh): THREE.BufferGeometry => {
    const geo = mesh.geometry.clone();
    // Into the NODE's frame, not the scene's, so a part drops in at its own origin.
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld));
    return normalize(geo);
  };

  const all: THREE.BufferGeometry[] = [];
  node.traverse((child) => {
    if (child instanceof THREE.Mesh) all.push(bake(child));
  });

  if (all.length) {
    const merged = all.length === 1 ? all[0]!.clone() : mergeGeometries(all, false);
    if (!merged) throw new Error(`kit: could not merge the parts of "${node.name}"`);
    merged.computeBoundingBox();
    kit.parts.set(node.name, merged);
  }
  if (node instanceof THREE.Mesh) {
    const own = bake(node);
    own.computeBoundingBox();
    kit.solo.set(node.name, own);
  }
  for (const g of all) g.dispose();

  for (const child of node.children) harvest(child, kit);
}

/**
 * Reduce a primitive to exactly `position`, `normal` and `uv`, each a plain
 * float attribute of its own.
 *
 * Merging is unforgiving about this: `mergeGeometries` refuses any set that
 * does not match exactly, which is how a building of eight parts ends up as
 * no building at all. Rebuilding each channel is cheap (it happens once, at
 * load) and it means a recipe can mix any two models in the pack.
 */
function normalize(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const count = geo.getAttribute('position').count;

  for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2]] as const) {
    const src = geo.getAttribute(name);
    const data = new Float32Array(count * size);
    if (src) {
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < size; k++) data[i * size + k] = src.getComponent(i, k);
      }
    }
    out.setAttribute(name, new THREE.BufferAttribute(data, size));
  }

  if (geo.index) out.setIndex(Array.from(geo.index.array));
  if (!geo.getAttribute('normal')) out.computeVertexNormals();
  geo.dispose();
  return out;
}

function prepareAtlas(texture: THREE.Texture): THREE.Texture {
  texture.colorSpace = THREE.SRGBColorSpace;
  // Swatches are gradients that fill a whole cell; filtering across a cell
  // boundary bleeds one material into the next along every UV seam in the pack.
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/**
 * A part's geometry, cloned so callers may transform it freely. Unknown
 * names throw. `solo` leaves the node's children behind: the tower without
 * its rotor, the garage without its door.
 */
export function part(name: string, kit: KitId = 'base', { solo = false }: { solo?: boolean } = {}): THREE.BufferGeometry {
  const geo = (solo ? KITS[kit].solo : KITS[kit].parts).get(name);
  if (!geo) throw new Error(`kit: no ${solo ? 'solo ' : ''}part named "${name}" in the ${kit} kit`);
  return geo.clone();
}

export function hasPart(name: string, kit: KitId = 'base'): boolean {
  return KITS[kit].parts.has(name);
}

export function partNames(kit: KitId = 'base'): string[] {
  return [...KITS[kit].parts.keys()];
}

export function atlasTexture(kit: KitId = 'base'): THREE.Texture | null {
  return KITS[kit].atlas;
}

/**
 * A 32-entry mask, one float per atlas cell, uploaded as a uniform array.
 * Shaders index it by cell rather than sampling a second texture, which
 * keeps the whole idea to 128 bytes.
 */
export function cellMask(cells: readonly number[], value = 1): Float32Array {
  const mask = new Float32Array(ATLAS.cols * ATLAS.rows);
  for (const cell of cells) mask[cell] = value;
  return mask;
}
