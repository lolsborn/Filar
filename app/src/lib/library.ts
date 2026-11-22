// The user's own materials, kept outside any one project so they can be
// reused: band (or strand) definitions and ply-property sets.

import { create } from "zustand";
import { loadLibraryText, saveLibraryText } from "./backend";
import type { Material, PlyProperties } from "./types";

interface LibraryFile {
  version: 1;
  materials: Material[];
  plies: PlyProperties[];
}

interface Library {
  materials: Material[];
  plies: PlyProperties[];
  /** Set when the library could not be read or written. */
  error: string | null;
  load(): Promise<void>;
  /** Add a material, or replace the one with the same name. */
  saveMaterial(m: Material): Promise<boolean>;
  removeMaterial(name: string): Promise<boolean>;
  savePly(p: PlyProperties): Promise<boolean>;
  removePly(name: string): Promise<boolean>;
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

export const useLibrary = create<Library>((set, get) => {
  /** Persist first, and only then show the change, so the UI never claims a save that failed. */
  const commit = async (next: Pick<Library, "materials" | "plies">): Promise<boolean> => {
    const file: LibraryFile = { version: 1, materials: next.materials, plies: next.plies };
    try {
      await saveLibraryText(JSON.stringify(file, null, 2));
      set({ ...next, error: null });
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  };
  const upsert = <T extends { name: string }>(list: T[], item: T) => [...list.filter((x) => x.name !== item.name), structuredClone(item)].sort(byName);

  return {
    materials: [],
    plies: [],
    error: null,

    async load() {
      try {
        const text = await loadLibraryText();
        if (!text.trim()) return;
        const file = JSON.parse(text) as Partial<LibraryFile>;
        set({
          materials: (Array.isArray(file.materials) ? file.materials : [])
            .filter((m) => m && typeof m.name === "string")
            .map((m) => ({ ...m, shape: m.shape ?? "flat" }))
            .sort(byName),
          plies: (Array.isArray(file.plies) ? file.plies : []).filter((p) => p && typeof p.name === "string").sort(byName),
          error: null,
        });
      } catch (e) {
        set({ error: `Your material library could not be read: ${e}` });
      }
    },

    saveMaterial: (m) => commit({ materials: upsert(get().materials, m), plies: get().plies }),
    removeMaterial: (name) => commit({ materials: get().materials.filter((m) => m.name !== name), plies: get().plies }),
    savePly: (p) => commit({ materials: get().materials, plies: upsert(get().plies, p) }),
    removePly: (name) => commit({ materials: get().materials, plies: get().plies.filter((p) => p.name !== name) }),
  };
});

const MATERIAL_KEYS = ["name", "shape", "bandWidth", "tows", "tex", "fiberDensity", "resinDensity", "fiberVolumeFraction", "color", "plyName"] as const;
const PLY_KEYS = ["name", "e1", "e2", "g12", "nu12", "xt", "xc", "yt", "yc", "s", "referenceVf"] as const;

const same = <T extends object>(keys: readonly (keyof T)[], a: T, b: T) =>
  keys.every((k) => {
    const [x, y] = [a[k] ?? null, b[k] ?? null];
    return typeof x === "number" && typeof y === "number" ? Math.abs(x - y) < 1e-9 : x === y;
  });

export const sameMaterial = (a: Material, b: Material) => same<Material>(MATERIAL_KEYS, a, b);
export const samePly = (a: PlyProperties, b: PlyProperties) => same<PlyProperties>(PLY_KEYS, a, b);

/** Where a named item stands relative to the built-in and saved lists. */
export type LibraryState = "builtin" | "builtinEdited" | "saved" | "savedEdited" | "new";

export function libraryState<T extends { name: string }>(item: T, builtins: T[], saved: T[], equal: (a: T, b: T) => boolean): LibraryState {
  const b = builtins.find((x) => x.name === item.name);
  if (b) return equal(b, item) ? "builtin" : "builtinEdited";
  const s = saved.find((x) => x.name === item.name);
  if (s) return equal(s, item) ? "saved" : "savedEdited";
  return "new";
}
