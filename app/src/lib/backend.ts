// One contract, two transports. Inside the Tauri shell the planner runs as
// native Rust behind `invoke`; in a plain browser the very same Rust crate
// runs as WebAssembly. Both speak the JSON facade in filar-core::api.

import type { Analysis, Defaults, Gcode, Plan, Project } from "./types";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface Transport {
  defaults(): Promise<string>;
  plan(projectJson: string): Promise<string>;
  gcode(projectJson: string): Promise<string>;
  analyze(projectJson: string): Promise<string>;
}

let transport: Promise<Transport> | null = null;

async function connect(): Promise<Transport> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return {
      defaults: () => invoke<string>("defaults"),
      plan: (projectJson) => invoke<string>("plan", { projectJson }),
      gcode: (projectJson) => invoke<string>("gcode", { projectJson }),
      analyze: (projectJson) => invoke<string>("analyze", { projectJson }),
    };
  }
  const wasm = await import("../wasm/filar_wasm.js");
  await wasm.default();
  return {
    defaults: async () => wasm.defaults(),
    plan: async (projectJson) => wasm.plan(projectJson),
    gcode: async (projectJson) => wasm.gcode(projectJson),
    analyze: async (projectJson) => wasm.analyze(projectJson),
  };
}

function core(): Promise<Transport> {
  return (transport ??= connect());
}

export async function getDefaults(): Promise<Defaults> {
  return JSON.parse(await (await core()).defaults());
}

export async function planProject(project: Project): Promise<Plan> {
  return JSON.parse(await (await core()).plan(JSON.stringify(project)));
}

export async function gcodeProject(project: Project): Promise<Gcode> {
  return JSON.parse(await (await core()).gcode(JSON.stringify(project)));
}

export async function analyzeProject(project: Project): Promise<Analysis> {
  return JSON.parse(await (await core()).analyze(JSON.stringify(project)));
}

// -------------------------------------------------------------- library --

const LIBRARY_KEY = "filar.library.v1";

/** The user's saved materials as JSON text ("" when there are none). */
export async function loadLibraryText(): Promise<string> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("load_library");
  }
  return localStorage.getItem(LIBRARY_KEY) ?? "";
}

export async function saveLibraryText(json: string): Promise<void> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_library", { json });
    return;
  }
  localStorage.setItem(LIBRARY_KEY, json);
}

// ---------------------------------------------------------------- files --

export interface FileKind {
  name: string;
  extensions: string[];
}

/** Save text to a user-chosen file. Resolves false if the user cancels. */
export async function saveText(suggestedName: string, text: string, kind: FileKind): Promise<boolean> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    const path = await save({ defaultPath: suggestedName, filters: [kind] });
    if (!path) return false;
    await invoke("write_text_file", { path, contents: text });
    return true;
  }
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/** Let the user pick a file and read it as text. Resolves null on cancel. */
export async function openText(kind: FileKind): Promise<{ name: string; text: string } | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    const path = await open({ multiple: false, filters: [kind] });
    if (!path || Array.isArray(path)) return null;
    const text = await invoke<string>("read_text_file", { path });
    return { name: path.split(/[\\/]/).pop() ?? path, text };
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = kind.extensions.map((e) => `.${e}`).join(",");
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { name: file.name, text: await file.text() } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
