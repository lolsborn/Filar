// File-level actions shared by buttons and keyboard shortcuts.

import { create } from "zustand";
import { openText, saveText } from "./backend";
import { slug } from "./format";
import { hasErrors, useApp } from "./store";
import type { Project } from "./types";

interface Toast {
  message: string | null;
  tone: "ok" | "error";
  show(message: string, tone?: "ok" | "error"): void;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export const useToast = create<Toast>((set) => ({
  message: null,
  tone: "ok",
  show(message, tone = "ok") {
    clearTimeout(toastTimer);
    set({ message, tone });
    toastTimer = setTimeout(() => set({ message: null }), 3200);
  },
}));

const toast = (m: string, tone: "ok" | "error" = "ok") => useToast.getState().show(m, tone);

export async function saveProject() {
  const { project, markSaved } = useApp.getState();
  if (!project) return;
  try {
    const ok = await saveText(`${slug(project.name)}.filar`, JSON.stringify(project, null, 2), { name: "Filar project", extensions: ["filar", "json"] });
    if (ok) {
      markSaved();
      toast("Project saved");
    }
  } catch (e) {
    toast(`Could not save: ${e}`, "error");
  }
}

export async function openProject() {
  try {
    const file = await openText({ name: "Filar project", extensions: ["filar", "json"] });
    if (!file) return;
    const parsed = JSON.parse(file.text) as Project;
    if (!parsed || typeof parsed !== "object" || !parsed.mandrel || !Array.isArray(parsed.layers) || !parsed.machine) {
      toast(`${file.name} is not a Filar project`, "error");
      return;
    }
    useApp.getState().load(parsed);
    toast(`Opened ${file.name}`);
  } catch (e) {
    toast(`Could not open: ${e instanceof SyntaxError ? "the file is not valid JSON" : e}`, "error");
  }
}

export async function exportGcode() {
  const app = useApp.getState();
  if (!app.project) return;
  if (hasErrors(app.plan)) {
    toast("Fix the errors in this plan before exporting", "error");
    return;
  }
  try {
    const g = await app.ensureGcode();
    if (!g) return;
    const ok = await saveText(`${slug(app.project.name)}.gcode`, g.text, { name: "G-code", extensions: ["gcode", "nc", "ngc", "txt"] });
    if (ok) toast(`Exported ${g.lines.toLocaleString("en-US")} lines of G-code`);
  } catch (e) {
    toast(`Could not export: ${e}`, "error");
  }
}
