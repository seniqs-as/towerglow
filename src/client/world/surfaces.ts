import * as THREE from 'three';
import { mulberry32 } from '../../shared/hash.ts';

/**
 * Procedurally drawn surfaces for the colony's own structures -- the plot decks and the
 * kerbs that edge them.
 *
 * BROWSER ONLY: every surface is painted on a `document.createElement('canvas')`, so this
 * module cannot be imported from a Node test. Neither `planet.ts` nor `sky.ts` imports it.
 *
 * Ported from Bot Crossing. These are drawn rather than shipped for the same reason the
 * face atlas is: they have to take each repo's accent colour, and a painted texture cannot.
 * Everything here is authored neutral grey so the material's own colour multiplies through
 * cleanly, and the *pattern* carries the detail instead.
 *
 * Each surface comes with a normal map derived from its own height field, which is what
 * makes the difference between a picture of a deck and a deck: panel seams catch a shadow
 * along one edge and a highlight along the other as the sun moves, and the bolt heads pick
 * out the light. On a surface this large and this flat, that relief is doing most of the
 * work -- a flat albedo pattern under a single directional light reads as wallpaper.
 *
 * Both are generated once and shared by every plot in the colony.
 */

/** World units one tile of the deck texture covers. Two panels to a tile. */
export const DECK_TEXTURE_SCALE = 4;

export interface DeckSurface {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}

export interface KerbSurface {
  map: THREE.CanvasTexture;
  emissiveMap: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
}

let deck: DeckSurface | null = null;
let kerb: KerbSurface | null = null;

/**
 * The plot deck: a plated metal floor of bolted panels.
 *
 * Authored to tile, so a plot of seven hex cells reads as one continuous apron rather than
 * seven repeats of a medallion.
 */
export function deckSurface(size = 512): DeckSurface {
  if (deck) return deck;

  const albedo = canvas(size);
  const height = canvas(size);
  const a = albedo.ctx;
  const h = height.ctx;

  // Base plate. Mid grey both times: the albedo so the accent tint has something neutral to
  // multiply, the height so seams can cut down and bolts can stand up from a middle.
  a.fillStyle = '#8e9296';
  a.fillRect(0, 0, size, size);
  h.fillStyle = '#808080';
  h.fillRect(0, 0, size, size);

  const panels = 2;
  const step = size / panels;
  const seam = Math.max(2, Math.round(size / 170));

  // Panels, each a shade off its neighbour so the floor is never one flat field.
  const rand = mulberry32(0x5eed);
  for (let px = 0; px < panels; px++) {
    for (let py = 0; py < panels; py++) {
      const shade = 138 + Math.round((rand() - 0.5) * 16);
      a.fillStyle = `rgb(${shade},${shade + 3},${shade + 6})`;
      a.fillRect(px * step + seam, py * step + seam, step - seam * 2, step - seam * 2);
    }
  }

  // Seams. Cut into the height field so they read as gaps between plates, and drawn dark in
  // the albedo so they still show at grazing angles where the normal map does little.
  a.strokeStyle = 'rgba(40,44,50,0.85)';
  a.lineWidth = seam;
  h.strokeStyle = '#3a3a3a';
  h.lineWidth = seam;
  for (let i = 0; i <= panels; i++) {
    for (const ctx of [a, h]) {
      ctx.beginPath();
      ctx.moveTo(i * step, 0);
      ctx.lineTo(i * step, size);
      ctx.moveTo(0, i * step);
      ctx.lineTo(size, i * step);
      ctx.stroke();
    }
  }

  // Bolt heads at the panel corners and along the seams -- the detail the eye actually
  // catches, so they get the strongest relief on the sheet.
  const bolt = Math.max(2, size / 150);
  const offsets: readonly (readonly [number, number])[] = [
    [0, 0],
    [step / 2, 0],
    [0, step / 2],
  ];
  for (let i = 0; i <= panels; i++) {
    for (let j = 0; j <= panels; j++) {
      for (const [ox, oy] of offsets) {
        const x = (i * step + ox) % size;
        const y = (j * step + oy) % size;
        a.fillStyle = 'rgba(198,203,209,0.85)';
        dot(a, x, y, bolt);
        h.fillStyle = '#e8e8e8';
        dot(h, x, y, bolt);
        // A touch of shadow under each, for the angles the normal map cannot reach.
        a.fillStyle = 'rgba(30,32,38,0.35)';
        dot(a, x + bolt * 0.5, y + bolt * 0.5, bolt * 0.8);
      }
    }
  }

  // Wear: a scatter of scuffs, so no two square metres of deck are identical.
  for (let i = 0; i < size / 6; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = (0.6 + rand() * 2.4) * (size / 128);
    a.fillStyle = rand() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)';
    dot(a, x, y, r);
  }

  const map = texture(albedo.el, THREE.SRGBColorSpace);
  deck = {
    map,
    normalMap: normalFrom(height, 1.7),
    // The albedo doubles as the roughness map: three reads the green channel, and a scuffed
    // panel being a little duller than a clean one is exactly the correlation wanted here.
    roughnessMap: texture(albedo.el, THREE.NoColorSpace),
  };
  return deck;
}

/**
 * The kerb that edges a plot: a lit strip, broken into dashes.
 *
 * A solid glowing bar is a solid glowing bar; the same bar dashed reads as runway edge
 * lighting, which is what a landing apron should have. The emissive mask is separate from
 * the albedo so the dark gaps stay dark after nightfall instead of glowing grey.
 */
export function kerbSurface(size = 128): KerbSurface {
  if (kerb) return kerb;

  // Two bands. The top half is the lit strip; the bottom half is a plain patch that every
  // face except the kerb's upper surface points at.
  //
  // A box gives all six of its faces the same 0..1 UV square, so a strip drawn once gets
  // stretched across the ends and down the sides as well -- and on a bar 14cm tall that
  // squashes the dark gaps between dashes into a solid black edge. Sending the other five
  // faces to a patch of flat colour is what keeps the sides reading as painted kerb.
  const h = size / 2;
  const albedo = canvas(size, h);
  const glow = canvas(size, h);
  const height = canvas(size, h);
  const band = h / 2;

  // The strip: dark channel, white dashes, and a raised lip either side of them.
  albedo.ctx.fillStyle = '#3c4148';
  albedo.ctx.fillRect(0, 0, size, band);
  glow.ctx.fillStyle = '#000000';
  glow.ctx.fillRect(0, 0, size, h);
  height.ctx.fillStyle = '#606060';
  height.ctx.fillRect(0, 0, size, band);

  const dashes = 6;
  const pitch = size / dashes;
  const len = pitch * 0.62;
  for (let i = 0; i < dashes; i++) {
    const x = i * pitch + (pitch - len) / 2;
    albedo.ctx.fillStyle = '#e9edf2';
    albedo.ctx.fillRect(x, band * 0.22, len, band * 0.56);
    glow.ctx.fillStyle = '#ffffff';
    glow.ctx.fillRect(x, band * 0.22, len, band * 0.56);
    height.ctx.fillStyle = '#d0d0d0';
    height.ctx.fillRect(x, band * 0.18, len, band * 0.64);
  }

  // The plain patch: near-white so the material's accent comes through at full strength,
  // unlit so the sides stay dark after nightfall, and flat so the normal map leaves them be.
  albedo.ctx.fillStyle = '#e6e9ee';
  albedo.ctx.fillRect(0, band, size, h - band);
  height.ctx.fillStyle = '#808080';
  height.ctx.fillRect(0, band, size, h - band);

  kerb = {
    map: texture(albedo.el, THREE.SRGBColorSpace),
    emissiveMap: texture(glow.el, THREE.SRGBColorSpace),
    normalMap: normalFrom(height, 1.1),
  };
  return kerb;
}

/**
 * Where on the kerb texture a face should look, given which way it points.
 *
 * `top` is the lit dash strip; everything else lands on the plain patch.
 */
export const KERB_UV = {
  top: { v0: 0.04, v1: 0.46 },
  side: { u: 0.5, v: 0.75 },
} as const;

// -- drawing helpers --------------------------------------------------------------------

interface Surface {
  el: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

function canvas(w: number, h = w): Surface {
  const el = document.createElement('canvas');
  el.width = w;
  el.height = h;
  const ctx = el.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('surfaces: no 2d canvas context');
  return { el, ctx };
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function texture(el: HTMLCanvasElement, colorSpace: string): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(el);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = colorSpace;
  t.anisotropy = 8;
  return t;
}

/**
 * Sobel a height field into a tangent-space normal map.
 *
 * Sampling wraps at the edges, because a normal map whose borders do not agree puts a hard
 * seam down every tile boundary -- which on a floor built out of tiles is every seam there
 * is.
 */
function normalFrom({ ctx, el }: Surface, strength: number): THREE.CanvasTexture {
  const w = el.width;
  const h = el.height;
  const src = ctx.getImageData(0, 0, w, h).data;
  const out = ctx.createImageData(w, h);
  const at = (x: number, y: number): number => src[(((y + h) % h) * w + ((x + w) % w)) * 4]! / 255;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx =
        at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) - (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
      const dy =
        at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) - (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
      const nx = dx * strength;
      const ny = dy * strength;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * w + x) * 4;
      out.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      out.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      out.data[i + 2] = (1 / len) * 0.5 * 255 + 127.5;
      out.data[i + 3] = 255;
    }
  }

  const dest = canvas(w, h);
  dest.ctx.putImageData(out, 0, 0);
  return texture(dest.el, THREE.NoColorSpace);
}
