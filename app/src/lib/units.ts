// Display units.
//
// Everything is stored and computed in one fixed set of base units (mm, g,
// bar, N, N·m, MPa ...). This module only decides how a value is shown and
// how a typed value is read back, so changing units never alters a project
// file or the G-code.

import { useMemo } from "react";
import { create } from "zustand";
import { fmt } from "./format";

export interface UnitPrefs {
  length: "mm" | "in";
  mass: "g" | "kg" | "oz" | "lb";
  pressure: "bar" | "MPa" | "psi";
  force: "N" | "lbf";
  moment: "N·m" | "lbf·ft" | "lbf·in";
  stress: "MPa" | "ksi";
}

export const METRIC: UnitPrefs = { length: "mm", mass: "g", pressure: "bar", force: "N", moment: "N·m", stress: "MPa" };
export const IMPERIAL: UnitPrefs = { length: "in", mass: "oz", pressure: "psi", force: "lbf", moment: "lbf·ft", stress: "ksi" };

/** What each setting offers, in the order shown in Settings. */
export const UNIT_CHOICES: { key: keyof UnitPrefs; label: string; options: string[] }[] = [
  { key: "length", label: "Length", options: ["mm", "in"] },
  { key: "mass", label: "Mass", options: ["g", "kg", "oz", "lb"] },
  { key: "pressure", label: "Pressure", options: ["bar", "MPa", "psi"] },
  { key: "force", label: "Force", options: ["N", "lbf"] },
  { key: "moment", label: "Moment and torque", options: ["N·m", "lbf·ft", "lbf·in"] },
  { key: "stress", label: "Stress and stiffness", options: ["MPa", "ksi"] },
];

/**
 * A kind of quantity, named by what it measures. The base unit of each is
 * in the comment; values passed to this module are always in that unit.
 */
export type Quantity =
  | "length" // mm
  | "run" // m: fibre length
  | "mass" // g
  | "pressure" // bar
  | "force" // N
  | "bigForce" // kN
  | "moment" // N·m
  | "stress" // MPa
  | "modulus" // GPa
  | "speed" // mm/s
  | "density" // g/cm³
  | "strandWeight" // g/m
  | "bendStiffness" // N·m²
  | "axialStiffness"; // MN

export interface Unit {
  label: string;
  /** Display value = base value x `k`. */
  k: number;
  /** Decimal places to add (or drop) relative to the base unit. */
  extra: number;
}

const unit = (label: string, k = 1, extra = 0): Unit => ({ label, k, extra });

export function resolve(q: Quantity, p: UnitPrefs): Unit {
  const inch = p.length === "in";
  const lbf = p.force === "lbf";
  const ksi = p.stress === "ksi";
  switch (q) {
    case "length":
      return inch ? unit("in", 1 / 25.4, 2) : unit("mm");
    case "run":
      return inch ? unit("ft", 3.280839895) : unit("m");
    case "speed":
      return inch ? unit("in/s", 1 / 25.4, 2) : unit("mm/s");
    case "density":
      return inch ? unit("lb/in³", 0.0361272920, 3) : unit("g/cm³");
    case "mass":
      return { g: unit("g"), kg: unit("kg", 1e-3, 3), oz: unit("oz", 0.0352739619, 2), lb: unit("lb", 0.00220462262, 3) }[p.mass];
    case "strandWeight":
      // Rope is sold by the hundred feet where pounds are used.
      return p.mass === "oz" || p.mass === "lb" ? unit("lb/100 ft", 0.0671968975, 2) : unit("g/m");
    case "pressure":
      return { bar: unit("bar"), MPa: unit("MPa", 0.1, 1), psi: unit("psi", 14.5037738) }[p.pressure];
    case "force":
      return lbf ? unit("lbf", 0.224808943, 1) : unit("N");
    case "bigForce":
      return lbf ? unit("lbf", 224.808943, -1) : unit("kN");
    case "axialStiffness":
      return lbf ? unit("kip", 224.808943, -1) : unit("MN");
    case "bendStiffness":
      return lbf ? unit("lbf·in²", 348.455, -1) : unit("N·m²");
    case "moment":
      return { "N·m": unit("N·m"), "lbf·ft": unit("lbf·ft", 0.737562149, 1), "lbf·in": unit("lbf·in", 8.85074579) }[p.moment];
    case "stress":
      return ksi ? unit("ksi", 0.145037738, 1) : unit("MPa");
    case "modulus":
      return ksi ? unit("Msi", 0.145037738, 1) : unit("GPa");
  }
}

export interface Units {
  unit(q: Quantity): Unit;
  label(q: Quantity): string;
  /** Base value to display value. */
  to(q: Quantity, base: number): number;
  /** Number only, e.g. "18.11". `digits` is what the base unit would use. */
  num(q: Quantity, base: number, digits?: number): string;
  /** Number with its unit, e.g. "18.11 in". */
  fmt(q: Quantity, base: number, digits?: number): string;
}

export function makeUnits(prefs: UnitPrefs): Units {
  const cache = new Map<Quantity, Unit>();
  const get = (q: Quantity) => {
    let u = cache.get(q);
    if (!u) cache.set(q, (u = resolve(q, prefs)));
    return u;
  };
  const num = (q: Quantity, base: number, digits = 0) => fmt(base * get(q).k, Math.max(digits + get(q).extra, 0));
  return {
    unit: get,
    label: (q) => get(q).label,
    to: (q, base) => base * get(q).k,
    num,
    fmt: (q, base, digits) => `${num(q, base, digits)} ${get(q).label}`,
  };
}

/** A round step size at or just above `raw`: 1, 2, 2.5 or 5 times a power of ten. */
export function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const m = [1, 2, 2.5, 5, 10].find((x) => x * mag >= raw * 0.999) ?? 10;
  return Number((m * mag).toPrecision(6));
}

// -------------------------------------------------------------- settings --

const SETTINGS_KEY = "filar.settings.v1";

function loadPrefs(): UnitPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}").units ?? {};
    const out = { ...METRIC } as Record<string, string>;
    // Keep only values this version knows about.
    for (const c of UNIT_CHOICES) if (c.options.includes(saved[c.key])) out[c.key] = saved[c.key];
    return out as unknown as UnitPrefs;
  } catch {
    return { ...METRIC };
  }
}

interface Settings {
  units: UnitPrefs;
  setUnits(units: UnitPrefs): void;
}

export const useSettings = create<Settings>((set) => ({
  units: loadPrefs(),
  setUnits(units) {
    set({ units });
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ units }));
    } catch {
      /* the choice still applies for this session */
    }
  },
}));

export function useUnits(): Units {
  const prefs = useSettings((s) => s.units);
  return useMemo(() => makeUnits(prefs), [prefs]);
}

export const samePrefs = (a: UnitPrefs, b: UnitPrefs) => UNIT_CHOICES.every((c) => a[c.key] === b[c.key]);
