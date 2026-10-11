import * as THREE from 'three';
import { GRID_MAJOR, GRID_MINOR } from './palette.ts';

/**
 * Ground with a procedural grid: a fine one, and a brighter line every few
 * cells. The lines are drawn in the fragment shader with fwidth(), so they
 * have constant thickness on screen at any distance: no texture, no file.
 *
 * The brighter lines were taken out once, on 2026-09-28, read as the streets
 * the user had asked to remove. They were not: the streets were the gaps
 * between the towers, and the fine lines alone are so dark that the floor
 * went black -- "the grid has disappeared". The grid is the floor, and it
 * stays whole.
 */
/**
 * Spacing of the grid lines, in world units.
 *
 * Exported because they are not just a decorative pattern: the spacing of
 * the towers moves by one cell (`PITCH_STEP` in `layout.ts`), so each tower
 * meets the fine lines the same way, and two values written in two different
 * files diverge at the first tweak.
 */
export const GRID_CELL = 6;
export const GRID_BLOCK = 30;

export function createGround(size: number): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(size, size, 1, 1);
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uMinor: { value: new THREE.Color(GRID_MINOR) },
      uMajor: { value: new THREE.Color(GRID_MAJOR) },
      uCell: { value: GRID_CELL },
      uBlock: { value: GRID_BLOCK },
      uFade: { value: size * 0.42 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vWorld;
      uniform vec3 uMinor;
      uniform vec3 uMajor;
      uniform float uCell;
      uniform float uBlock;
      uniform float uFade;

      // Line of constant thickness on screen: 1 on the line, 0 elsewhere.
      float gridLine(vec2 p, float period) {
        vec2 c = abs(fract(p / period - 0.5) - 0.5) * period;
        vec2 w = fwidth(p) * 1.2;
        vec2 l = 1.0 - smoothstep(vec2(0.0), w, c);
        return max(l.x, l.y);
      }

      void main() {
        vec2 p = vWorld.xz;
        float minor = gridLine(p, uCell);
        float major = gridLine(p, uBlock);

        vec3 color = uMinor * minor;
        color = mix(color, uMajor, major);

        float alpha = max(minor * 0.55, major * 0.95);
        // radial fade to black: the city has no sharp edges
        float d = length(p) / uFade;
        alpha *= 1.0 - smoothstep(0.55, 1.0, d);

        if (alpha < 0.002) discard;
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'ground';
  mesh.renderOrder = -1;
  return mesh;
}
