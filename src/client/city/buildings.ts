import * as THREE from 'three';
import type { ProjectInfo } from '../../shared/protocol.ts';
import { placeSlot, buildingFootprint, buildingHeight, floorsForSize } from './layout.ts';
import { EDGE_DIM, RUIN } from './palette.ts';
import type { Layer } from './stage.ts';

const CAP = 256;

/**
 * The projects' skyscrapers, in a single InstancedMesh.
 *
 * The neon edges are drawn in the FRAGMENT SHADER, not with geometry: an
 * EdgesGeometry per building would mean hundreds of draw calls, here they
 * stay one. fwidth() keeps the on-screen thickness constant at any distance.
 */
export class Buildings implements Layer {
  readonly object3d: THREE.Group;
  #mesh: THREE.InstancedMesh;
  #material: THREE.ShaderMaterial;
  #aColor: THREE.InstancedBufferAttribute;
  #aLit: THREE.InstancedBufferAttribute;
  #aFloors: THREE.InstancedBufferAttribute;
  #aWait: THREE.InstancedBufferAttribute;
  #index = new Map<string, number>();
  #order: string[] = [];
  /** Height and footprint per project: needed by badges, windows and rings. */
  #metrics = new Map<string, { height: number; footprint: number }>();
  #targetLit = new Map<string, number>();
  #dummy = new THREE.Object3D();
  #color = new THREE.Color();

  constructor() {
    this.object3d = new THREE.Group();
    this.object3d.name = 'buildings';

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    // Origin at the base: scaling in height then grows the building upward.
    geometry.translate(0, 0.5, 0);

    const colors = new Float32Array(CAP * 3);
    const lit = new Float32Array(CAP);
    const floors = new Float32Array(CAP);
    const waiting = new Float32Array(CAP);
    this.#aColor = new THREE.InstancedBufferAttribute(colors, 3);
    this.#aLit = new THREE.InstancedBufferAttribute(lit, 1);
    this.#aFloors = new THREE.InstancedBufferAttribute(floors, 1);
    this.#aWait = new THREE.InstancedBufferAttribute(waiting, 1);
    geometry.setAttribute('aColor', this.#aColor);
    geometry.setAttribute('aLit', this.#aLit);
    geometry.setAttribute('aFloors', this.#aFloors);
    geometry.setAttribute('aWait', this.#aWait);

    this.#material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aLit;
        attribute float aFloors;
        attribute float aWait;
        varying vec3 vLocal;
        varying vec3 vNormalL;
        varying vec3 vColor;
        varying float vLit;
        varying float vFloors;
        varying float vWait;
        void main() {
          vWait = aWait;
          vLocal = position;
          vNormalL = normal;
          vColor = aColor;
          vLit = aLit;
          vFloors = aFloors;
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vLocal;
        varying vec3 vNormalL;
        varying vec3 vColor;
        varying float vLit;
        varying float vFloors;
        varying float vWait;
        uniform float uTime;

        void main() {
          // Coordinates on the face: the two axes perpendicular to the normal.
          vec3 a = abs(vNormalL);
          vec2 uv;
          if (a.x > 0.5)      uv = vec2(vLocal.z, vLocal.y - 0.5);
          else if (a.y > 0.5) uv = vec2(vLocal.x, vLocal.z);
          else                uv = vec2(vLocal.x, vLocal.y - 0.5);

          // Distance from the face's edge, in local units.
          vec2 d = 0.5 - abs(uv);
          float edgeDist = min(d.x, d.y);
          vec2 w = fwidth(uv) * 1.6;
          float edge = 1.0 - smoothstep(0.0, max(w.x, w.y), edgeDist);

          // Floor lines: one stroke per floor, so the height reads at a glance.
          float floorLine = 0.0;
          if (a.y < 0.5) {
            float f = (vLocal.y) * vFloors;
            float fd = abs(fract(f) - 0.5);
            float fw = fwidth(f) * 1.2;
            floorLine = (1.0 - smoothstep(0.0, fw, fd - 0.46)) * 0.18;
          }

          // A building waiting on a reply from YOU pulses. It is the only state
          // where you need to step in, so it must read from far away without
          // having to read a badge.
          float beacon = vWait > 0.5 ? 0.55 + 0.45 * sin(uTime * 4.2) : 0.0;

          float body = 0.055 + 0.035 * vLit + beacon * 0.10;
          float glow = max(edge, floorLine) * (1.0 + beacon * 1.5);
          // The edges of a dark building stay readable: it is the map of the
          // city, and it must orient even when no one is working on it. The
          // base is raised only for them -- for a lit building the total stays
          // what it was, so the difference between lit and dark never thins out.
          vec3 color = vColor * (body + glow * (1.4 + 0.4 * vLit));
          float alpha = clamp(body * 2.4 + glow * 0.9, 0.0, 1.0);

          if (alpha < 0.004) discard;
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });

    this.#mesh = new THREE.InstancedMesh(geometry, this.#material, CAP);
    this.#mesh.count = 0;
    this.#mesh.frustumCulled = false;
    this.object3d.add(this.#mesh);
  }

  /**
   * Places the buildings. The position comes from the server as a `slot`
   * already assigned and frozen: nothing gets decided here, only drawn.
   */
  setProjects(
    projects: readonly ProjectInfo[],
    activeColor: (projectId: string) => number | null,
    pitch?: number,
  ): void {
    const usable = projects.slice(0, CAP);
    this.#index.clear();
    this.#order = [];

    this.#metrics.clear();
    usable.forEach((project, i) => {
      const place = placeSlot(project.slot, pitch);
      // Height and footprint scale with the project's real size: that is
      // what makes a skyline distinguishable instead of a checkerboard.
      const footprint = buildingFootprint();
      const height = buildingHeight(project.size);
      this.#metrics.set(project.id, { height, footprint });

      this.#dummy.position.set(place.x, 0, place.z);
      this.#dummy.rotation.set(0, 0, 0);
      this.#dummy.scale.set(footprint, height, footprint);
      this.#dummy.updateMatrix();
      this.#mesh.setMatrixAt(i, this.#dummy.matrix);

      const tint = activeColor(project.id);
      this.#color.set(!project.exists ? RUIN : (tint ?? EDGE_DIM));
      this.#color.toArray(this.#aColor.array as Float32Array, i * 3);
      this.#aFloors.setX(i, floorsForSize(project.size));
      this.#aWait.setX(i, 0);
      this.#aLit.setX(i, tint === null ? 0 : 1);
      this.#targetLit.set(project.id, tint === null ? 0 : 1);

      this.#index.set(project.id, i);
      this.#order.push(project.id);
    });

    this.#mesh.count = usable.length;
    this.#mesh.instanceMatrix.needsUpdate = true;
    // The raycast culls on this sphere, and three computes it once: without a
    // refresh a tower added after the first pick could never be clicked.
    this.#mesh.computeBoundingSphere();
    this.#aColor.needsUpdate = true;
    this.#aLit.needsUpdate = true;
    this.#aFloors.needsUpdate = true;
    this.#aWait.needsUpdate = true;
  }

  /** Turns on the beacon: someone in this project is waiting for a reply. */
  setWaiting(projectId: string, waiting: boolean): void {
    const i = this.#index.get(projectId);
    if (i === undefined) return;
    const value = waiting ? 1 : 0;
    if (this.#aWait.getX(i) === value) return;
    this.#aWait.setX(i, value);
    this.#aWait.needsUpdate = true;
  }

  /**
   * A building lights up when a session is working inside it, and takes the
   * tool's color: that is how the skyline reads WHO occupies it.
   */
  setActive(projectId: string, tint: number | null, isRuin: boolean): void {
    const i = this.#index.get(projectId);
    if (i === undefined) return;
    this.#targetLit.set(projectId, tint === null ? 0 : 1);
    this.#color.set(isRuin ? RUIN : (tint ?? EDGE_DIM));
    this.#color.toArray(this.#aColor.array as Float32Array, i * 3);
    this.#aColor.needsUpdate = true;
  }

  /** Building height: badges must sit above it, not inside it. */
  heightOf(projectId: string): number {
    return this.#metrics.get(projectId)?.height ?? buildingHeight(0);
  }

  footprintOf(projectId: string): number {
    return this.#metrics.get(projectId)?.footprint ?? buildingFootprint();
  }

  /** The project whose tower the ray hits first, if any. */
  pick(raycaster: THREE.Raycaster): string | null {
    const hit = raycaster.intersectObject(this.#mesh, false)[0];
    return hit?.instanceId === undefined ? null : (this.#order[hit.instanceId] ?? null);
  }

  positionOf(projectId: string): THREE.Vector3 | null {
    const i = this.#index.get(projectId);
    if (i === undefined) return null;
    const m = new THREE.Matrix4();
    this.#mesh.getMatrixAt(i, m);
    return new THREE.Vector3().setFromMatrixPosition(m);
  }

  update(dt: number, now: number): void {
    this.#material.uniforms['uTime']!.value = now;
    // Smooth lit/dark transition: no allocation happens in here.
    let dirty = false;
    for (let i = 0; i < this.#order.length; i++) {
      const id = this.#order[i]!;
      const target = this.#targetLit.get(id) ?? 0;
      const cur = this.#aLit.getX(i);
      if (Math.abs(cur - target) < 0.002) continue;
      this.#aLit.setX(i, cur + (target - cur) * Math.min(1, dt * 4));
      dirty = true;
    }
    if (dirty) this.#aLit.needsUpdate = true;
  }

  dispose(): void {
    this.#mesh.geometry.dispose();
    this.#material.dispose();
  }
}
