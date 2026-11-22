import { create } from "zustand";
import { analyzeProject, gcodeProject, getDefaults, planProject } from "./backend";
import type { Analysis, Defaults, Gcode, Layer, Plan, Project } from "./types";

export type Mode = "design" | "analyse" | "simulate" | "gcode";
export type AnalyseView = "reserve" | "fibre";
export type ColorMode = "fibre" | "layers";

const AUTOSAVE_KEY = "filar.project.v1";
const HISTORY_LIMIT = 100;

interface State {
  ready: boolean;
  fatal: string | null;
  defaults: Defaults | null;
  project: Project | null;
  /** Plan for `project` (or for a slightly older edit while `planning`). */
  plan: Plan | null;
  planning: boolean;
  /** Strength estimate for `project`, refreshed with the plan. */
  analysis: Analysis | null;
  /** Estimates for the saved variants, keyed by variant id. */
  variantResults: Record<string, Analysis>;
  gcode: Gcode | null;
  gcodeStale: boolean;
  past: Project[];
  future: Project[];
  dirty: boolean;

  mode: Mode;
  leftTab: "part" | "machine";
  selectedLayerId: string | null;
  colorMode: ColorMode;
  showMachine: boolean;
  analyseView: AnalyseView;
  /** Load case being inspected; null follows the governing case. */
  caseId: string | null;
  /** Station (index into analysis.stations) being inspected, if any. */
  stationIndex: number | null;
  compareOpen: boolean;

  init(): Promise<void>;
  /** Apply an edit. Edits sharing a `coalesce` key within a short window are one undo step. */
  edit(fn: (p: Project) => void, coalesce?: string): void;
  load(project: Project): void;
  undo(): void;
  redo(): void;
  markSaved(): void;
  setMode(mode: Mode): void;
  set(partial: Partial<Pick<State, "leftTab" | "selectedLayerId" | "colorMode" | "showMachine" | "analyseView" | "caseId" | "stationIndex">>): void;
  setCompare(open: boolean): void;
  ensureGcode(): Promise<Gcode | null>;
}

let planTimer: ReturnType<typeof setTimeout> | undefined;
let planSerial = 0;
let lastCoalesce = { key: "", at: 0 };

/** Fill in sections that older project files do not have. */
function normalise(project: Project, defaults: Defaults): Project {
  project.analysis ??= structuredClone(defaults.tube.analysis);
  project.variants ??= [];
  project.material.shape ??= "flat";
  return project;
}

export const useApp = create<State>((set, get) => {
  /** Re-plan shortly after the last edit; stale results are dropped. */
  const schedulePlan = (delay = 60) => {
    clearTimeout(planTimer);
    set({ planning: true, gcodeStale: true });
    planTimer = setTimeout(async () => {
      const serial = ++planSerial;
      const project = get().project;
      if (!project) return;
      try {
        const [plan, analysis] = await Promise.all([planProject(project), analyzeProject(project)]);
        if (serial !== planSerial) return;
        const stationIndex = get().stationIndex;
        set({
          plan,
          analysis,
          planning: false,
          stationIndex: stationIndex != null && stationIndex < analysis.stations.length ? stationIndex : null,
        });
        if (get().mode === "gcode") void get().ensureGcode();
        if (get().compareOpen) void refreshVariants();
      } catch (e) {
        if (serial !== planSerial) return;
        set({ planning: false, fatal: String(e) });
      }
    }, delay);
  };

  /** Re-run the estimate for every saved variant of the current project. */
  const refreshVariants = async () => {
    const project = get().project;
    if (!project) return;
    const entries = await Promise.all(
      project.variants.map(async (v) => [v.id, await analyzeProject({ ...project, layers: v.layers, variants: [] })] as const),
    );
    if (get().project === project) set({ variantResults: Object.fromEntries(entries) });
  };

  const autosave = (project: Project) => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(project));
    } catch {
      /* storage may be unavailable; autosave is best-effort */
    }
  };

  return {
    ready: false,
    fatal: null,
    defaults: null,
    project: null,
    plan: null,
    planning: false,
    analysis: null,
    variantResults: {},
    gcode: null,
    gcodeStale: true,
    past: [],
    future: [],
    dirty: false,
    mode: "design",
    leftTab: "part",
    selectedLayerId: null,
    colorMode: "fibre",
    showMachine: true,
    analyseView: "reserve",
    caseId: null,
    stationIndex: null,
    compareOpen: false,

    async init() {
      try {
        const defaults = await getDefaults();
        let project = defaults.tube;
        try {
          const saved = localStorage.getItem(AUTOSAVE_KEY);
          if (saved) {
            const parsed = JSON.parse(saved) as Project;
            if (parsed?.version === defaults.tube.version && parsed.mandrel && parsed.layers) project = normalise(parsed, defaults);
          }
        } catch {
          /* ignore a corrupt autosave */
        }
        const [plan, analysis] = await Promise.all([planProject(project), analyzeProject(project)]);
        const firstHelical = project.layers.find((l) => l.kind === "helical") ?? project.layers[0];
        set({ defaults, project, plan, analysis, ready: true, selectedLayerId: firstHelical?.id ?? null });
      } catch (e) {
        set({ fatal: String(e) });
      }
    },

    edit(fn, coalesce) {
      const current = get().project;
      if (!current) return;
      const next = structuredClone(current);
      fn(next);
      const now = Date.now();
      const merge = !!coalesce && coalesce === lastCoalesce.key && now - lastCoalesce.at < 800;
      lastCoalesce = { key: coalesce ?? "", at: now };
      set((s) => ({
        project: next,
        past: merge ? s.past : [...s.past.slice(-HISTORY_LIMIT + 1), current],
        future: [],
        dirty: true,
      }));
      autosave(next);
      schedulePlan();
    },

    load(project) {
      const current = get().project;
      const defaults = get().defaults;
      if (defaults) normalise(project, defaults);
      const firstHelical = project.layers.find((l) => l.kind === "helical") ?? project.layers[0];
      set((s) => ({
        project,
        past: current ? [...s.past.slice(-HISTORY_LIMIT + 1), current] : s.past,
        future: [],
        dirty: false,
        selectedLayerId: firstHelical?.id ?? null,
        caseId: null,
        stationIndex: null,
        compareOpen: false,
        variantResults: {},
      }));
      autosave(project);
      schedulePlan(0);
    },

    undo() {
      const { past, project, future } = get();
      if (!past.length || !project) return;
      const prev = past[past.length - 1];
      set({ project: prev, past: past.slice(0, -1), future: [project, ...future], dirty: true });
      lastCoalesce = { key: "", at: 0 };
      autosave(prev);
      schedulePlan(0);
    },

    redo() {
      const { past, project, future } = get();
      if (!future.length || !project) return;
      const next = future[0];
      set({ project: next, past: [...past, project], future: future.slice(1), dirty: true });
      lastCoalesce = { key: "", at: 0 };
      autosave(next);
      schedulePlan(0);
    },

    markSaved() {
      set({ dirty: false });
    },

    setMode(mode) {
      set({ mode, leftTab: mode === "gcode" ? "machine" : mode === "design" ? "part" : get().leftTab, compareOpen: false });
      if (mode === "gcode") void get().ensureGcode();
    },

    set(partial) {
      set(partial);
    },

    setCompare(open) {
      set({ compareOpen: open });
      if (open) void refreshVariants();
    },

    async ensureGcode() {
      const { project, gcode, gcodeStale } = get();
      if (!project) return null;
      if (gcode && !gcodeStale) return gcode;
      const serial = planSerial;
      const fresh = await gcodeProject(project);
      // Only accept it if no newer edit landed while we were generating.
      if (serial === planSerial && get().project === project) set({ gcode: fresh, gcodeStale: false });
      return fresh;
    },
  };
});

let layerCounter = 0;
export function newLayerId(layers: Layer[]): string {
  let id: string;
  do {
    id = `l${Date.now().toString(36)}${(layerCounter++).toString(36)}`;
  } while (layers.some((l) => l.id === id));
  return id;
}

export function newId(prefix: string, taken: { id: string }[]): string {
  let id: string;
  do {
    id = `${prefix}${Date.now().toString(36)}${(layerCounter++).toString(36)}`;
  } while (taken.some((t) => t.id === id));
  return id;
}

/** The load case being inspected: the chosen one, else the governing one. */
export function activeCase(analysis: Analysis | null, caseId: string | null): number {
  if (!analysis || analysis.cases.length === 0) return 0;
  const i = analysis.cases.findIndex((c) => c.id === caseId);
  return i >= 0 ? i : analysis.governingCase;
}

export function hasErrors(plan: Plan | null): boolean {
  return !!plan?.warnings.some((w) => w.level === "error");
}
