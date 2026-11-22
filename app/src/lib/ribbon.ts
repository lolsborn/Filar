// Builds the mesh for one repeat of a plan block: a flat ribbon for a band
// of tows, or one tube-like strand per rope for round material.
//
// Samples are sparse - a helix on a tube is two samples - so each move is
// subdivided by mandrel rotation here. Points are placed in cylindrical
// coordinates so the band sits exactly on the surface however wide it is.
//
// Local frame of the mandrel group: axis along +X with the mandrel centred,
// angle phi measured from +Z towards -Y.

import * as THREE from "three";
import type { Block, Material, Plan } from "./types";

export interface Ribbon {
  geometry: THREE.BufferGeometry;
  /** Time into the repeat (s) at each cross-section, ascending. */
  times: Float32Array;
  sections: number;
  /** Index count per cross-section step, for partial draw ranges. */
  indicesPerSection: number;
}

const PHI_STEP = (3 * Math.PI) / 180;
/** Keeps a layer clear of the one beneath it in the depth buffer (mm). */
export const LIFT_EPS = 0.015;

export type BandShape = Pick<Material, "shape" | "bandWidth" | "tows">;

export function radiusAt(profile: [number, number][], z: number): number {
  const n = profile.length;
  if (z <= profile[0][0]) return profile[0][1];
  if (z >= profile[n - 1][0]) return profile[n - 1][1];
  for (let i = 1; i < n; i++) {
    if (z <= profile[i][0]) {
      const [z0, r0] = profile[i - 1];
      const [z1, r1] = profile[i];
      return r0 + ((r1 - r0) * (z - z0)) / (z1 - z0);
    }
  }
  return profile[n - 1][1];
}

function slopeAt(profile: [number, number][], z: number): number {
  const n = profile.length;
  if (z < profile[0][0] || z > profile[n - 1][0]) return 0;
  for (let i = 1; i < n; i++) {
    if (z <= profile[i][0]) {
      const [z0, r0] = profile[i - 1];
      const [z1, r1] = profile[i];
      return (r1 - r0) / (z1 - z0);
    }
  }
  return 0;
}

const isRound = (band: BandShape) => band.shape === "round";
const strandDiameter = (band: BandShape) => band.bandWidth / Math.max(band.tows, 1);

/**
 * Extra lift for a round strand on its return pass. Strands cannot pass
 * through each other, so the pass heading back rides over the one heading
 * out by about a diameter; the change is eased in around the turnaround.
 */
function crossoverLift(band: BandShape, alpha: number): number {
  if (!isRound(band)) return 0;
  const t = Math.min(Math.max((alpha - (Math.PI / 2 - 0.17)) / 0.34, 0), 1);
  return strandDiameter(band) * 0.92 * t * t * (3 - 2 * t);
}

/** Extra lift each successive repeat gets, so later bands lie on top. */
export function liftPerRepeat(block: Block, band: BandShape): number {
  // Round strands of one pass sit side by side at the same height.
  if (isRound(band)) return 0.004;
  return Math.max(block.radialBuild / block.repeats, 0.012);
}

/** Radial lift of the band's underside `u` (0..1) of the way through a repeat. */
export function liftWithin(block: Block, band: BandShape, u: number, alpha: number): number {
  return block.radialBase + LIFT_EPS + liftPerRepeat(block, band) * u + crossoverLift(band, alpha);
}

/** Height of the fibre's contact line above the band's underside. */
export function contactHeight(band: BandShape): number {
  return isRound(band) ? strandDiameter(band) : 0;
}

/**
 * Cross-section of the band: points across its width, each with a height
 * above the surface and an outward direction (across, up) for shading.
 */
function crossSection(band: BandShape): { w: number; h: number; nw: number; nh: number; v: number }[] {
  if (!isRound(band)) {
    const half = band.bandWidth / 2;
    return [
      { w: -half, h: 0, nw: 0, nh: 1, v: 0 },
      { w: half, h: 0, nw: 0, nh: 1, v: 1 },
    ];
  }
  // Each strand: the visible arc of a circle resting on the surface.
  const n = Math.max(band.tows, 1);
  const d = strandDiameter(band);
  const arc = 8;
  const from = (215 * Math.PI) / 180;
  const to = (-35 * Math.PI) / 180;
  const out = [];
  for (let s = 0; s < n; s++) {
    const centre = (s - (n - 1) / 2) * d;
    for (let k = 0; k <= arc; k++) {
      const a = from + ((to - from) * k) / arc;
      out.push({ w: centre + (d / 2) * Math.cos(a), h: d / 2 + (d / 2) * Math.sin(a), nw: Math.cos(a), nh: Math.sin(a), v: s + k / arc });
    }
  }
  return out;
}

/** `tint`, when given, colours the band by axial position (linear RGB, 0..1). */
export function buildRibbon(block: Block, plan: Plan, band: BandShape, tint?: (z: number) => [number, number, number]): Ribbon {
  const s = block.samples;
  const profile = plan.mandrel.profile;
  const xOff = -plan.mandrel.length / 2;
  const cross = crossSection(band);
  const P = cross.length;

  // Count cross-sections first.
  const pieces: number[] = [];
  let sections = 1;
  for (let i = 1; i < s.t.length; i++) {
    const n = Math.max(1, Math.ceil(Math.abs(s.phi[i] - s.phi[i - 1]) / PHI_STEP));
    pieces.push(n);
    sections += n;
  }

  const pos = new Float32Array(sections * P * 3);
  const nor = new Float32Array(sections * P * 3);
  const uv = new Float32Array(sections * P * 2);
  const col = new Float32Array(sections * P * 3);
  const times = new Float32Array(sections);
  const indicesPerSection = (P - 1) * 6;
  const index = new Uint32Array((sections - 1) * indicesPerSection);

  let k = 0;
  let arc = 0;
  let prev: [number, number, number] | null = null;
  const put = (i: number, u: number) => {
    const j = Math.max(i - 1, 0);
    const mix = (v: number[]) => v[j] + (v[i] - v[j]) * u;
    const z = mix(s.z);
    const phi = mix(s.phi);
    const alpha = mix(s.alpha);
    const t = mix(s.t);
    const r = radiusAt(profile, z);
    const slope = slopeAt(profile, z);
    const cg = 1 / Math.sqrt(1 + slope * slope);
    const sg = slope * cg;
    const lift = liftWithin(block, band, block.duration > 0 ? t / block.duration : 0, alpha);
    const sa = Math.sin(alpha);
    const ca = Math.cos(alpha);

    // Centre point, for arc length along the fibre.
    const cx = z + xOff;
    const cy = -(r + lift) * Math.sin(phi);
    const cz = (r + lift) * Math.cos(phi);
    if (prev) arc += Math.hypot(cx - prev[0], cy - prev[1], cz - prev[2]);
    prev = [cx, cy, cz];

    // The return pass is shaded a touch darker, which is what makes the
    // diamond pattern readable.
    const shade = alpha > Math.PI / 2 + 1e-6 ? 0.78 : 1;
    const rgb = tint ? tint(z) : null;

    for (let q = 0; q < P; q++) {
      const c = cross[q];
      // Across the band: -sin(alpha) along the meridian, +cos(alpha) around.
      const ze = z - c.w * sa * cg;
      const re = radiusAt(profile, ze) + lift + c.h;
      const pe = phi + (c.w * ca) / r;
      const o = (k * P + q) * 3;
      const sp = Math.sin(pe);
      const cp = Math.cos(pe);
      pos[o] = ze + xOff;
      pos[o + 1] = -re * sp;
      pos[o + 2] = re * cp;
      // Outward direction: `nh` along the surface normal, `nw` across the band.
      const ax = -sa * cg;
      const ar = -sa * sg;
      nor[o] = c.nh * -sg + c.nw * ax;
      nor[o + 1] = c.nh * (-cg * sp) + c.nw * (ar * -sp + ca * -cp);
      nor[o + 2] = c.nh * (cg * cp) + c.nw * (ar * cp + ca * -sp);
      col[o] = (rgb ? rgb[0] : 1) * shade;
      col[o + 1] = (rgb ? rgb[1] : 1) * shade;
      col[o + 2] = (rgb ? rgb[2] : 1) * shade;
      const w = (k * P + q) * 2;
      uv[w] = arc / band.bandWidth;
      uv[w + 1] = c.v;
    }
    times[k] = t;
    if (k > 0) {
      let o = (k - 1) * indicesPerSection;
      for (let q = 0; q < P - 1; q++) {
        const a = (k - 1) * P + q;
        const b = k * P + q;
        index[o++] = a;
        index[o++] = a + 1;
        index[o++] = b;
        index[o++] = a + 1;
        index[o++] = b + 1;
        index[o++] = b;
      }
    }
    k++;
  };

  put(0, 1);
  for (let i = 1; i < s.t.length; i++) {
    const n = pieces[i - 1];
    for (let p = 1; p <= n; p++) put(i, p / n);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  // Instances are rotations about the axis, so one generous sphere covers all.
  const reach = Math.hypot(plan.mandrel.length / 2 + 50, plan.mandrel.maxRadius + 10 + 4 * contactHeight(band));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), reach);
  return { geometry, times, sections, indicesPerSection };
}

/** A second geometry sharing the same GPU buffers but its own draw range. */
export function shareGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv", "color"]) g.setAttribute(name, src.getAttribute(name));
  g.setIndex(src.getIndex());
  g.boundingSphere = src.boundingSphere;
  return g;
}
