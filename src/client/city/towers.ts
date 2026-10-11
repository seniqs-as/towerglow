import * as THREE from 'three';
import type { Layer } from './stage.ts';
import { RING_COLOR } from './palette.ts';
import { MAX_RINGS } from '../../shared/rings.ts';
import type { GitEvent } from '../../shared/rings.ts';

/** Rings per project, from the one rule both sides use; re-exported for the legend. */
export { MAX_RINGS };

const CAP = 512;
const RING_GAP = 1.5;

const COLOR: Record<string, number> = RING_COLOR;

interface Ring {
  projectId: string;
  index: number;
  color: number;
  bornAt: number;
}

/**
 * The commit tower: one ring per commit of the last hour, above the roof.
 *
 * It is the project's memory made visible. Rings pile up from the bottom
 * and the most recent sits on top, so the tower's height tells at a glance
 * how much has been consolidated in this working session. Which events make
 * a ring is decided once, in `shared/rings.ts`: this only draws the list.
 */
export class Towers implements Layer {
  readonly object3d: THREE.Group;
  #mesh: THREE.InstancedMesh;
  #material: THREE.ShaderMaterial;
  #color: THREE.InstancedBufferAttribute;
  #born: THREE.InstancedBufferAttribute;
  #rings: Ring[] = [];
  #dummy = new THREE.Object3D();
  #tmp = new THREE.Color();

  constructor() {
    this.object3d = new THREE.Group();
    this.object3d.name = 'towers';

    const geometry = new THREE.TorusGeometry(1, 0.14, 6, 20);
    geometry.rotateX(Math.PI / 2);

    this.#color = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3);
    this.#born = new THREE.InstancedBufferAttribute(new Float32Array(CAP).fill(-999), 1);
    geometry.setAttribute('aColor', this.#color);
    geometry.setAttribute('aBorn', this.#born);

    this.#material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aBorn;
        uniform float uTime;
        varying vec3 vColor;
        varying float vFresh;
        void main() {
          vColor = aColor;
          // A newly born ring pulses: a commit is an event, not a state.
          float age = uTime - aBorn;
          vFresh = aBorn < -900.0 ? 0.0 : clamp(1.0 - age / 3.0, 0.0, 1.0);
          vec3 p = position * (1.0 + vFresh * 0.35);
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vColor;
        varying float vFresh;
        void main() {
          gl_FragColor = vec4(vColor * (0.75 + 1.6 * vFresh), 0.55 + 0.45 * vFresh);
        }
      `,
    });

    this.#mesh = new THREE.InstancedMesh(geometry, this.#material, CAP);
    this.#mesh.count = 0;
    this.#mesh.frustumCulled = false;
    this.object3d.add(this.#mesh);
  }

  /**
   * The rings to show, as the ledger has them: each project's oldest first.
   *
   * Replaced whole, never added to: rings used to be appended one per event
   * received, so a history replayed after a server restart piled up again on
   * top of itself, and past twelve the index wrapped and laid new rings over
   * old ones. `bornAtOf` turns a commit's instant into the shader's clock, so
   * only a commit that just happened swells.
   */
  set(events: readonly GitEvent[], bornAtOf: (at: number) => number): void {
    const next: Ring[] = [];
    const seen = new Map<string, number>();
    for (const ev of events) {
      const index = seen.get(ev.projectId) ?? 0;
      seen.set(ev.projectId, index + 1);
      next.push({ projectId: ev.projectId, index, color: COLOR[ev.kind] ?? COLOR['other']!, bornAt: bornAtOf(ev.at) });
    }
    this.#rings = next.slice(-CAP);
  }

  /** How many rings a project shows. */
  count(projectId: string): number {
    return this.#rings.filter((r) => r.projectId === projectId).length;
  }

  /** Relocates the rings above the roofs. Called when the city changes. */
  place(metrics: (projectId: string) => { position: THREE.Vector3 | null; height: number; footprint: number }): void {
    let i = 0;
    for (const ring of this.#rings) {
      if (i >= CAP) break;
      const m = metrics(ring.projectId);
      if (!m.position) continue;

      const radius = m.footprint * 0.3;
      this.#dummy.position.set(
        m.position.x,
        m.height + 2.5 + ring.index * RING_GAP,
        m.position.z,
      );
      this.#dummy.scale.setScalar(radius);
      this.#dummy.updateMatrix();
      this.#mesh.setMatrixAt(i, this.#dummy.matrix);
      this.#tmp.set(ring.color).toArray(this.#color.array as Float32Array, i * 3);
      this.#born.setX(i, ring.bornAt);
      i++;
    }
    this.#mesh.count = i;
    this.#mesh.instanceMatrix.needsUpdate = true;
    this.#color.needsUpdate = true;
    this.#born.needsUpdate = true;
  }

  update(_dt: number, now: number): void {
    this.#material.uniforms['uTime']!.value = now;
  }

  dispose(): void {
    this.#mesh.geometry.dispose();
    this.#material.dispose();
  }
}
