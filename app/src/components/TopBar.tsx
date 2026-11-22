import { useEffect, useRef, useState } from "react";
import { Box, ChevronDown, Cone, Download, FolderOpen, Redo2, Save, Settings2, Undo2 } from "lucide-react";
import { isTauri } from "../lib/backend";
import { hasErrors, useApp, type Mode } from "../lib/store";
import { Field, Seg, Select } from "./ui";
import { IMPERIAL, METRIC, samePrefs, UNIT_CHOICES, useSettings, type UnitPrefs } from "../lib/units";
import { exportGcode, openProject, saveProject } from "../lib/actions";

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 64 64" aria-hidden>
      <g fill="none" strokeLinecap="round" strokeWidth="7">
        <path d="M8 46 L24 18 L40 46 L56 18" stroke="#c8f542" />
        <path d="M8 18 L24 46 L40 18 L56 46" stroke="#c8f542" strokeOpacity=".3" />
      </g>
    </svg>
  );
}

function NewMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const defaults = useApp((s) => s.defaults);
  const load = useApp((s) => s.load);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button className="btn btn-ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        New <ChevronDown size={13} />
      </button>
      {open && defaults && (
        <div className="glass rise absolute top-9 right-0 z-50 w-56 rounded-xl p-1.5" role="menu">
          {[
            { icon: Box, title: "Tube", sub: "Straight cylinder", project: defaults.tube },
            { icon: Cone, title: "Tapered cone", sub: "Two diameters", project: defaults.cone },
          ].map((item) => (
            <button
              key={item.title}
              role="menuitem"
              className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-white/[0.08]"
              onClick={() => {
                load(structuredClone(item.project));
                setOpen(false);
              }}
            >
              <item.icon size={17} className="text-ink-2" />
              <span>
                <span className="block font-medium text-ink">{item.title}</span>
                <span className="block text-[11px] text-ink-3">{item.sub}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const units = useSettings((s) => s.units);
  const setUnits = useSettings((s) => s.setUnits);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  const system = samePrefs(units, METRIC) ? "metric" : samePrefs(units, IMPERIAL) ? "imperial" : "mixed";

  return (
    <div ref={ref} className="relative">
      <button className="icon-btn" data-on={open} title="Settings" aria-label="Settings" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Settings2 size={15} />
      </button>
      {open && (
        <div className="glass rise absolute top-9 right-0 z-50 w-[300px] rounded-xl p-4" role="dialog" aria-label="Settings" style={{ background: "rgb(16 18 22 / 0.97)" }}>
          <div className="eyebrow mb-2.5">Units</div>
          <Seg
            fill
            aria-label="Unit system"
            value={system}
            options={[
              { value: "metric", label: "Metric" },
              { value: "imperial", label: "Imperial" },
              ...(system === "mixed" ? [{ value: "mixed" as const, label: "Mixed" }] : []),
            ]}
            onChange={(v) => v !== "mixed" && setUnits(v === "metric" ? { ...METRIC } : { ...IMPERIAL })}
          />
          <div className="mt-3 grid grid-cols-2 gap-x-2.5 gap-y-2.5">
            {UNIT_CHOICES.map((c) => (
              <Field key={c.key} label={c.label}>
                <Select
                  aria-label={c.label}
                  value={units[c.key]}
                  options={c.options.map((o) => ({ value: o, label: o }))}
                  onChange={(v) => setUnits({ ...units, [c.key]: v } as UnitPrefs)}
                />
              </Field>
            ))}
          </div>
          <p className="mt-3 text-[11px] leading-snug text-ink-3">
            Units change what you see and type. Projects are always saved in metric, and G-code units come from the machine profile.
          </p>
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const project = useApp((s) => s.project);
  const mode = useApp((s) => s.mode);
  const setMode = useApp((s) => s.setMode);
  const edit = useApp((s) => s.edit);
  const canUndo = useApp((s) => s.past.length > 0);
  const canRedo = useApp((s) => s.future.length > 0);
  const dirty = useApp((s) => s.dirty);
  const planning = useApp((s) => s.planning);
  const blocked = useApp((s) => hasErrors(s.plan));

  return (
    <header
      data-tauri-drag-region
      className="glass absolute top-3 right-3 left-3 z-30 flex h-12 items-center gap-3 rounded-2xl pr-2"
      style={{ paddingLeft: isTauri ? 84 : 14 }}
    >
      <div className="pointer-events-none flex items-center gap-2">
        <Logo />
        <span className="text-[14px] font-semibold tracking-tight">Filar</span>
      </div>
      <div className="hairline mx-1 h-5 border-l" />
      <div className="flex min-w-0 items-center gap-2">
        <input
          className="w-[190px] min-w-0 rounded-md bg-transparent px-1.5 py-1 font-medium text-ink outline-none hover:bg-white/[0.06] focus:bg-white/[0.08]"
          aria-label="Project name"
          spellCheck={false}
          value={project?.name ?? ""}
          onChange={(e) => edit((p) => void (p.name = e.target.value), "name")}
        />
        <span className={`h-1.5 w-1.5 rounded-full ${planning ? "pulse bg-accent" : dirty ? "bg-ink-4" : "bg-transparent"}`} title={planning ? "Planning…" : dirty ? "Unsaved changes" : ""} />
      </div>

      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="pointer-events-auto">
          <Seg<Mode>
            accent
            aria-label="Workspace"
            value={mode}
            options={[
              { value: "design", label: "Design", title: "Design (1)" },
              { value: "analyse", label: "Analyse", title: "Analyse (2)" },
              { value: "simulate", label: "Simulate", title: "Simulate (3)" },
              { value: "gcode", label: "G-code", title: "G-code (4)" },
            ]}
            onChange={setMode}
          />
        </div>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <button className="icon-btn" title="Undo (⌘Z)" disabled={!canUndo} onClick={() => useApp.getState().undo()}>
          <Undo2 size={15} />
        </button>
        <button className="icon-btn" title="Redo (⇧⌘Z)" disabled={!canRedo} onClick={() => useApp.getState().redo()}>
          <Redo2 size={15} />
        </button>
        <SettingsMenu />
        <div className="hairline mx-1 h-5 border-l" />
        <NewMenu />
        <button className="btn btn-ghost" title="Open project (⌘O)" onClick={() => void openProject()}>
          <FolderOpen size={14} /> Open
        </button>
        <button className="btn btn-ghost" title="Save project (⌘S)" onClick={() => void saveProject()}>
          <Save size={14} /> Save
        </button>
        <button
          className="btn btn-primary ml-1"
          disabled={blocked}
          title={blocked ? "Fix the errors in this plan before exporting" : "Export G-code (⌘E)"}
          onClick={() => void exportGcode()}
        >
          <Download size={14} /> Export G-code
        </button>
      </div>
    </header>
  );
}
