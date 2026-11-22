// Simulation clock and plan interpolation.
//
// The plan is a list of blocks, each a short list of samples run `repeats`
// times. The machine interpolates linearly between samples (one sample = one
// G-code move), so interpolating linearly here reproduces what it will do.

import { create } from "zustand";
import type { Plan } from "./types";

interface Clock {
  time: number;
  playing: boolean;
  /** Playback rate relative to real time. */
  speed: number;
  setTime(t: number): void;
  toggle(): void;
  set(partial: Partial<Pick<Clock, "playing" | "speed">>): void;
}

export const useClock = create<Clock>((set) => ({
  time: 0,
  playing: false,
  speed: 20,
  setTime: (time) => set({ time }),
  toggle: () => set((s) => ({ playing: !s.playing })),
  set: (partial) => set(partial),
}));

export const SPEEDS = [1, 5, 20, 100, 500];

export interface SimState {
  block: number;
  repeat: number;
  /** Index of the sample the current move started from. */
  sample: number;
  /** Fraction through the current move. */
  u: number;
  /** Time into the current repeat (s). */
  local: number;
  kind: number;
  z: number;
  r: number;
  phi: number;
  alpha: number;
  x: number;
  y: number;
  a: number;
  b: number;
}

/** Last index i with arr[i] <= v (arr ascending). */
export function lowerIndex(arr: ArrayLike<number>, v: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid] <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function stateAt(plan: Plan, time: number): SimState | null {
  const blocks = plan.blocks;
  if (!blocks.length) return null;
  const t = Math.min(Math.max(time, 0), plan.totals.duration);
  let bi = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].tStart <= t) bi = i;
    else break;
  }
  const b = blocks[bi];
  const s = b.samples;
  const into = t - b.tStart;
  const repeat = Math.min(Math.floor(into / b.duration + 1e-9), b.repeats - 1);
  const local = Math.min(Math.max(into - repeat * b.duration, 0), b.duration);
  const i = Math.min(lowerIndex(s.t, local), s.t.length - 2);
  const span = s.t[i + 1] - s.t[i];
  const u = span > 0 ? Math.min(Math.max((local - s.t[i]) / span, 0), 1) : 1;
  const mix = (v: number[]) => v[i] + (v[i + 1] - v[i]) * u;
  const turn = repeat * b.phiStep;
  return {
    block: bi,
    repeat,
    sample: i,
    u,
    local,
    kind: s.kind[i + 1],
    z: mix(s.z),
    r: mix(s.r),
    phi: mix(s.phi) + turn,
    alpha: mix(s.alpha),
    x: mix(s.x),
    y: mix(s.y),
    a: mix(s.a) + turn,
    b: mix(s.b),
  };
}
