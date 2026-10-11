import * as THREE from 'three';
import type { ToolCategory } from '../../shared/protocol.ts';
import { TOOL_COLOR } from './palette.ts';
import { pulseDuration } from '../../shared/toolCategories.ts';
import type { Layer } from './stage.ts';

const CAP = 4096;

/**
 * Tool call pulses, entirely GPU-driven.
 *
 * Each pulse is a point in a single `Points`: creating one means writing a
 * few floats into an array, and from there the vertex shader takes over. No
 * Object3D, no allocation per frame, no CPU work while the pulse travels.
 * With this scheme hundreds of simultaneous pulses cost a single draw call
 * and fractions of a millisecond.
 *
 * The alternative -- a mesh per pulse, animated in JS -- would have tanked
 * the frame rate exactly in the interesting moments, i.e. when the agents
 * are working hard.
 */
export class Pulses implements Layer {
  readonly object3d: THREE.Points;
  #material: THREE.ShaderMaterial;
  #start: THREE.BufferAttribute;
  #end: THREE.BufferAttribute;
  #t0: THREE.BufferAttribute;
  #dur: THREE.BufferAttribute;
  #color: THREE.BufferAttribute;
  #size: THREE.BufferAttribute;
  #arc: THREE.BufferAttribute;
  #next = 0;
  #count = 0;
  #tmpColor = new THREE.Color();

  constructor() {
    const geometry = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(CAP * 3), 3);
    this.#start = new THREE.BufferAttribute(new Float32Array(CAP * 3), 3);
    this.#end = new THREE.BufferAttribute(new Float32Array(CAP * 3), 3);
    this.#t0 = new THREE.BufferAttribute(new Float32Array(CAP), 1);
    this.#dur = new THREE.BufferAttribute(new Float32Array(CAP), 1);
    this.#color = new THREE.BufferAttribute(new Float32Array(CAP * 3), 3);
    this.#size = new THREE.BufferAttribute(new Float32Array(CAP), 1);
    this.#arc = new THREE.BufferAttribute(new Float32Array(CAP), 1);

    // `position` is not used by the vertex shader, but three requires it.
    geometry.setAttribute('position', pos);
    geometry.setAttribute('aStart', this.#start);
    geometry.setAttribute('aEnd', this.#end);
    geometry.setAttribute('aT0', this.#t0);
    geometry.setAttribute('aDur', this.#dur);
    geometry.setAttribute('aColor', this.#color);
    geometry.setAttribute('aSize', this.#size);
    geometry.setAttribute('aArc', this.#arc);
    geometry.setDrawRange(0, 0);

    this.#material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aStart;
        attribute vec3 aEnd;
        attribute float aT0;
        attribute float aDur;
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aArc;
        uniform float uTime;
        uniform float uPixelRatio;
        varying vec3 vColor;
        varying float vFade;

        void main() {
          float u = (uTime - aT0) / max(aDur, 0.0001);
          if (u < 0.0 || u >= 1.0) {
            // Outside the clip volume: the GPU discards it without drawing anything.
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            gl_PointSize = 0.0;
            return;
          }

          vec3 p = mix(aStart, aEnd, u);
          p.y += sin(u * 3.14159265) * aArc;   // ballistic arc

          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;

          vColor = aColor;
          // Bright at the start, fades out on arrival.
          vFade = (1.0 - u) * (0.35 + 0.65 * smoothstep(0.0, 0.15, u));
          gl_PointSize = aSize * uPixelRatio * (260.0 / max(-mv.z, 1.0));
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vColor;
        varying float vFade;
        void main() {
          // Round point with a soft edge, no texture to load.
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = dot(d, d);
          if (r > 0.25) discard;
          float glow = 1.0 - smoothstep(0.0, 0.25, r);
          gl_FragColor = vec4(vColor * glow, glow * vFade);
        }
      `,
    });

    this.object3d = new THREE.Points(geometry, this.#material);
    this.object3d.name = 'pulses';
    this.object3d.frustumCulled = false;
  }

  /** Creating a pulse costs a few writes to a Float32Array: nothing else. */
  spawn(
    from: THREE.Vector3,
    to: THREE.Vector3,
    category: ToolCategory,
    now: number,
    opts: { size?: number; arc?: number; duration?: number } = {},
  ): void {
    const i = this.#next;
    this.#next = (this.#next + 1) % CAP;
    if (this.#count < CAP) this.#count++;

    this.#start.setXYZ(i, from.x, from.y, from.z);
    this.#end.setXYZ(i, to.x, to.y, to.z);
    this.#t0.setX(i, now);
    this.#dur.setX(i, opts.duration ?? pulseDuration(category));
    this.#size.setX(i, opts.size ?? 13);
    this.#arc.setX(i, opts.arc ?? 4);
    this.#tmpColor.set(TOOL_COLOR[category]);
    this.#color.setXYZ(i, this.#tmpColor.r, this.#tmpColor.g, this.#tmpColor.b);

    // Only the touched slot is uploaded, not the whole 4096-entry buffer.
    for (const attr of [this.#start, this.#end, this.#t0, this.#dur, this.#size, this.#arc, this.#color]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(i * attr.itemSize, attr.itemSize);
      attr.needsUpdate = true;
    }
    this.object3d.geometry.setDrawRange(0, this.#count);
  }

  update(_dt: number, now: number): void {
    // All the motion lives in the shader: here only the clock advances.
    this.#material.uniforms['uTime']!.value = now;
  }

  dispose(): void {
    this.object3d.geometry.dispose();
    this.#material.dispose();
  }
}
