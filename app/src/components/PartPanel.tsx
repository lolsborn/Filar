import { ArrowDown, ArrowUp, Copy, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { newLayerId, useApp } from "../lib/store";
import { fibreColor, layerColor, STATUS } from "../lib/theme";
import { fmt } from "../lib/format";
import type { Layer, Material, Project } from "../lib/types";
import { libraryState, sameMaterial, useLibrary } from "../lib/library";
import { useToast } from "../lib/actions";
import { LibraryBar } from "./LibraryBar";
import { useUnits } from "../lib/units";
import { Field, Num, Section, Seg, Select, Text } from "./ui";

function describe(layer: Layer): string {
  return layer.kind === "helical" ? `±${Number(layer.angleDeg.toFixed(1))}°` : layer.plies > 1 ? `${layer.plies} plies` : "~90°";
}

/** Default names track the settings until the user types their own. */
function autoName(layer: Layer): string {
  return layer.kind === "helical" ? `Helical ±${Number(layer.angleDeg.toFixed(1))}°` : "Hoop";
}

function MandrelSection({ project }: { project: Project }) {
  const edit = useApp((s) => s.edit);
  const U = useUnits();
  const m = project.mandrel;
  const tapered = Math.abs(m.startDiameter - m.endDiameter) > 1e-9;
  const total = m.headExtension + m.length + m.tailExtension;
  const part = total - project.zone.headMargin - project.zone.tailMargin;
  const halfAngle = (Math.atan2((m.endDiameter - m.startDiameter) / 2, m.length) * 180) / Math.PI;

  return (
    <Section title="Mandrel">
      <Seg
        fill
        aria-label="Mandrel shape"
        value={tapered ? "taper" : "tube"}
        options={[
          { value: "tube", label: "Tube" },
          { value: "taper", label: "Taper" },
        ]}
        onChange={(v) =>
          edit((p) => {
            if (v === "tube") {
              p.mandrel.endDiameter = p.mandrel.startDiameter;
              p.layers.forEach((l) => l.kind === "helical" && (l.mode = "constant"));
            } else if (p.mandrel.endDiameter === p.mandrel.startDiameter) {
              p.mandrel.endDiameter = Number((p.mandrel.startDiameter * 0.6).toFixed(1));
            }
          })
        }
      />
      <div className="mt-3 grid grid-cols-2 gap-x-2.5 gap-y-2.5">
        {tapered ? (
          <>
            <Field label="Head diameter">
              <Num value={m.startDiameter} q="length" min={2} max={2000} step={1} onChange={(v) => edit((p) => void (p.mandrel.startDiameter = v), "d1")} />
            </Field>
            <Field label="Tail diameter">
              <Num value={m.endDiameter} q="length" min={2} max={2000} step={1} onChange={(v) => edit((p) => void (p.mandrel.endDiameter = v), "d2")} />
            </Field>
          </>
        ) : (
          <Field label="Diameter">
            <Num
              value={m.startDiameter}
              q="length"
              min={2}
              max={2000}
              step={1}
              onChange={(v) =>
                edit((p) => {
                  p.mandrel.startDiameter = v;
                  p.mandrel.endDiameter = v;
                }, "d")
              }
            />
          </Field>
        )}
        <Field label={tapered ? "Taper length" : "Length"} span={tapered}>
          <Num value={m.length} q="length" min={10} max={20000} step={10} onChange={(v) => edit((p) => void (p.mandrel.length = v), "len")} />
        </Field>
        {tapered && (
          <>
            <Field label="Head extension" hint="Cylindrical run-out before the taper, at the head diameter">
              <Num value={m.headExtension} q="length" min={0} max={5000} step={5} onChange={(v) => edit((p) => void (p.mandrel.headExtension = v), "he")} />
            </Field>
            <Field label="Tail extension" hint="Cylindrical run-out after the taper, at the tail diameter">
              <Num value={m.tailExtension} q="length" min={0} max={5000} step={5} onChange={(v) => edit((p) => void (p.mandrel.tailExtension = v), "te")} />
            </Field>
          </>
        )}
        <Field label="Head margin" hint="Distance from the head end of the mandrel to where the part starts. Turnarounds happen here.">
          <Num value={project.zone.headMargin} q="length" min={0} max={10000} step={5} onChange={(v) => edit((p) => void (p.zone.headMargin = v), "hm")} />
        </Field>
        <Field label="Tail margin" hint="Distance from the end of the part to the tail end of the mandrel. Turnarounds happen here.">
          <Num value={project.zone.tailMargin} q="length" min={0} max={10000} step={5} onChange={(v) => edit((p) => void (p.zone.tailMargin = v), "tm")} />
        </Field>
      </div>
      <p className="mt-2.5 text-[11px] leading-snug text-ink-3">
        Usable part <span className="num text-ink-2">{U.fmt("length", Math.max(part, 0), 0)}</span> of a{" "}
        <span className="num text-ink-2">{U.fmt("length", total, 0)}</span> mandrel
        {tapered && (
          <>
            , half-angle <span className="num text-ink-2">{fmt(Math.abs(halfAngle), 2)}°</span>
          </>
        )}
        .
      </p>
    </Section>
  );
}

const BUILT_IN = "Built in";
const YOURS = "Your materials";

function MaterialSection({ project }: { project: Project }) {
  const edit = useApp((s) => s.edit);
  const U = useUnits();
  const builtins = useApp((s) => s.defaults?.materials ?? []);
  const builtinPlies = useApp((s) => s.defaults?.plies ?? []);
  const saved = useLibrary((s) => s.materials);
  const savedPlies = useLibrary((s) => s.plies);
  const toast = useToast((s) => s.show);
  const mat = project.material;
  const round = mat.shape === "round";
  const state = libraryState(mat, builtins, saved, sameMaterial);
  const listed = state !== "new";
  const plies = [...builtinPlies, ...savedPlies];

  /** Switch to a library entry, taking its linked strength properties along. */
  const choose = (entry: Material) =>
    edit((p) => {
      p.material = structuredClone(entry);
      const ply = entry.plyName && plies.find((x) => x.name === entry.plyName);
      if (ply) p.analysis.ply = structuredClone(ply);
    });

  const fibreArea = (mat.tows * mat.tex * 1e-3) / mat.fiberDensity;
  const ply = round ? mat.bandWidth / Math.max(mat.tows, 1) : fibreArea / mat.fiberVolumeFraction / mat.bandWidth;
  const diameter = mat.bandWidth / Math.max(mat.tows, 1);
  const set = (fn: (m: Material) => void, key: string) => edit((p) => fn(p.material), `mat:${key}`);

  return (
    <Section title="Material">
      <div className="grid grid-cols-2 gap-x-2.5 gap-y-2.5">
        <Field label="Start from" span>
          <Select
            aria-label="Material"
            value={listed ? mat.name : "__custom"}
            options={[
              ...builtins.map((m) => ({ value: m.name, label: m.name, group: BUILT_IN })),
              ...saved.map((m) => ({ value: m.name, label: m.name, group: YOURS })),
              ...(listed ? [] : [{ value: "__custom", label: `${mat.name || "Untitled"} (not saved)` }]),
            ]}
            onChange={(name) => {
              const entry = [...builtins, ...saved].find((m) => m.name === name);
              if (entry) choose(entry);
            }}
          />
        </Field>
        <Field label="Name" span>
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <Text aria-label="Material name" value={mat.name} maxLength={48} onChange={(v) => set((m) => void (m.name = v), "name")} />
            </div>
            <label className="field w-[30px] shrink-0 cursor-pointer justify-center" title="Colour in the 3D view">
              <span className="h-4 w-4 rounded-[4px] border border-white/20" style={{ background: fibreColor(mat).color }} />
              <input
                type="color"
                className="sr-only"
                aria-label="Colour in the 3D view"
                value={fibreColor(mat).color}
                onChange={(e) => set((m) => void (m.color = e.target.value), "color")}
              />
            </label>
          </div>
        </Field>
        <Field label="Cross-section" span>
          <Seg
            fill
            value={mat.shape}
            options={[
              { value: "flat", label: "Flat band", title: "Fibre tows that consolidate into a thin ply" },
              { value: "round", label: "Round", title: "Rope, cord, twine or wire that keeps its shape" },
            ]}
            onChange={(v) =>
              edit((p) => {
                p.material.shape = v;
                // Round material carries no strength properties.
                if (v === "round") delete p.material.plyName;
              })
            }
          />
        </Field>
        {round ? (
          <>
            <Field label="Diameter" hint="Diameter of one strand as it lies on the mandrel">
              <Num value={Number(diameter.toFixed(4))} q="length" min={0.05} max={200} step={0.5} onChange={(v) => set((m) => void (m.bandWidth = v * Math.max(m.tows, 1)), "dia")} />
            </Field>
            <Field label="Strands side by side" hint="Strands fed together and laid next to each other in one pass">
              <Num
                value={mat.tows}
                integer
                min={1}
                max={64}
                onChange={(v) =>
                  set((m) => {
                    const d = m.bandWidth / Math.max(m.tows, 1);
                    m.tows = v;
                    m.bandWidth = d * v;
                  }, "tows")
                }
              />
            </Field>
            <Field label="Weight" hint="Weight of one strand per metre">
              <Num value={Number((mat.tex / 1000).toFixed(4))} q="strandWeight" min={0.001} max={5000} step={0.5} onChange={(v) => set((m) => void (m.tex = v * 1000), "tex")} />
            </Field>
          </>
        ) : (
          <>
            <Field label="Band width" hint="Width of the band as it lies on the mandrel">
              <Num value={mat.bandWidth} q="length" min={0.2} max={200} step={0.5} onChange={(v) => set((m) => void (m.bandWidth = v), "bw")} />
            </Field>
            <Field label="Tows in band">
              <Num value={mat.tows} integer min={1} max={64} onChange={(v) => set((m) => void (m.tows = v), "tows")} />
            </Field>
            <Field label="Tow weight" hint="Linear density of one tow: tex = grams per kilometre">
              <Num value={mat.tex} unit="tex" min={10} max={20000} step={50} onChange={(v) => set((m) => void (m.tex = v), "tex")} />
            </Field>
            <Field label="Fibre volume" hint="Fibre volume fraction of the cured laminate">
              <Num value={Number((mat.fiberVolumeFraction * 100).toFixed(1))} unit="%" min={10} max={90} step={1} onChange={(v) => set((m) => void (m.fiberVolumeFraction = v / 100), "vf")} />
            </Field>
            <Field label="Fibre density">
              <Num value={mat.fiberDensity} q="density" min={0.1} max={25} step={0.05} onChange={(v) => set((m) => void (m.fiberDensity = v), "fd")} />
            </Field>
            <Field label="Resin density">
              <Num value={mat.resinDensity} q="density" min={0.1} max={5} step={0.05} onChange={(v) => set((m) => void (m.resinDensity = v), "rd")} />
            </Field>
            <Field label="Strength properties" span hint="The ply-property set Analyse switches to when this material is chosen">
              <Select
                aria-label="Strength properties"
                value={mat.plyName && plies.some((x) => x.name === mat.plyName) ? mat.plyName : "__none"}
                options={[{ value: "__none", label: "None linked" }, ...plies.map((x) => ({ value: x.name, label: x.name }))]}
                onChange={(name) =>
                  edit((p) => {
                    const linked = plies.find((x) => x.name === name);
                    if (linked) {
                      p.material.plyName = linked.name;
                      p.analysis.ply = structuredClone(linked);
                    } else delete p.material.plyName;
                  })
                }
              />
            </Field>
          </>
        )}
      </div>
      <p className="mt-2.5 text-[11px] leading-snug text-ink-3">
        {round ? (
          <>
            Each ply is one diameter, <span className="num text-ink-2">{U.fmt("length", ply, 2)}</span>, thick. Round material is treated as wound dry and has no strength estimate.
          </>
        ) : (
          <>
            One ply is <span className="num text-ink-2">{U.fmt("length", ply, 3)}</span> thick at full coverage.
          </>
        )}
      </p>
      <LibraryBar
        state={state}
        noun="material"
        invalid={mat.name.trim() ? null : "Give it a name to save it."}
        onSave={async () => {
          const ok = await useLibrary.getState().saveMaterial(mat);
          toast(ok ? `${mat.name} saved to your library` : "Could not save the library", ok ? "ok" : "error");
        }}
        onRevert={() => {
          const entry = [...builtins, ...saved].find((m) => m.name === mat.name);
          if (entry) edit((p) => void (p.material = structuredClone(entry)));
        }}
        onDelete={async () => {
          const ok = await useLibrary.getState().removeMaterial(mat.name);
          toast(ok ? `${mat.name} removed from your library. This project still uses it.` : "Could not update the library", ok ? "ok" : "error");
        }}
      />
    </Section>
  );
}

function ProcessSection({ project }: { project: Project }) {
  const edit = useApp((s) => s.edit);
  const pr = project.process;
  return (
    <Section title="Process" defaultOpen={false}>
      <div className="grid grid-cols-2 gap-x-2.5 gap-y-2.5">
        <Field label="Turnaround" span hint="How the fibre reverses at each end">
          <Seg
            fill
            value={pr.turnaround}
            options={[
              { value: "friction", label: "Friction", title: "Steer through the turn as fast as friction allows" },
              { value: "pins", label: "Pin ring", title: "Pins hold the fibre so it reverses on the spot" },
            ]}
            onChange={(v) => edit((p) => void (p.process.turnaround = v))}
          />
        </Field>
        <Field label="Friction coefficient" hint="Usable friction between band and surface. Typical: 0.1–0.2 wet, higher for towpreg.">
          <Num value={pr.friction} min={0.01} max={1} step={0.01} onChange={(v) => edit((p) => void (p.process.friction = v), "mu")} />
        </Field>
        <Field label="Minimum dwell" hint="Minimum hoop rotation at each end before the fibre heads back">
          <Num value={pr.minDwellDeg} unit="°" min={0} max={720} step={5} onChange={(v) => edit((p) => void (p.process.minDwellDeg = v), "dwell")} />
        </Field>
        <Field label="Fibre speed" hint="Target lay-down speed. Axis limits may slow individual moves.">
          <Num value={pr.fiberSpeed} q="speed" min={1} max={5000} step={10} onChange={(v) => edit((p) => void (p.process.fiberSpeed = v), "speed")} />
        </Field>
      </div>
    </Section>
  );
}

function LayerEditor({ layer, index, tapered }: { layer: Layer; index: number; tapered: boolean }) {
  const edit = useApp((s) => s.edit);
  const update = (fn: (l: Layer) => void, key?: string) =>
    edit((p) => {
      const l = p.layers[index];
      const wasAuto = l.name === autoName(l);
      fn(l);
      if (wasAuto) l.name = autoName(l);
    }, key && `${layer.id}:${key}`);

  return (
    <div className="grid grid-cols-2 gap-x-2.5 gap-y-2.5 px-3 pt-1 pb-3" onClick={(e) => e.stopPropagation()}>
      <Field label="Name" span>
        <Text value={layer.name} maxLength={40} onChange={(v) => edit((p) => void (p.layers[index].name = v), `${layer.id}:name`)} />
      </Field>
      {layer.kind === "helical" ? (
        <>
          <Field label="Winding angle" hint="Angle between fibre and mandrel axis: 0° is axial, 90° is hoop">
            <Num value={layer.angleDeg} unit="°" min={3} max={87} step={1} digits={2} onChange={(v) => update((l) => l.kind === "helical" && (l.angleDeg = v), "angle")} />
          </Field>
          <Field label="Coverage" hint="100% means bands exactly butt at the widest station. Higher values overlap.">
            <Num
              value={Number((layer.coverage * 100).toFixed(1))}
              unit="%"
              min={20}
              max={400}
              step={5}
              onChange={(v) => update((l) => l.kind === "helical" && (l.coverage = v / 100), "cov")}
            />
          </Field>
          <div className="col-span-2 -mt-0.5">
            <input
              type="range"
              className="w-full"
              aria-label="Winding angle"
              min={3}
              max={87}
              step={0.5}
              value={layer.angleDeg}
              style={{ ["--fill" as string]: `${((layer.angleDeg - 3) / 84) * 100}%` }}
              onChange={(e) => update((l) => l.kind === "helical" && (l.angleDeg = Number(e.target.value)), "angle")}
            />
          </div>
          {tapered && (
            <Field label="Path on the taper" span>
              <Seg
                fill
                value={layer.mode}
                options={[
                  { value: "constant", label: "Constant angle", title: "Hold the angle along the taper; relies on friction" },
                  { value: "geodesic", label: "Geodesic", title: "Natural slip-free path; the angle rises towards the small end" },
                ]}
                onChange={(v) => update((l) => l.kind === "helical" && (l.mode = v))}
              />
            </Field>
          )}
        </>
      ) : (
        <Field label="Plies" hint="Passes along the part; each is one ply">
          <Num value={layer.plies} integer min={1} max={50} onChange={(v) => update((l) => l.kind === "hoop" && (l.plies = v), "plies")} />
        </Field>
      )}
    </div>
  );
}

function LayersSection({ project }: { project: Project }) {
  const edit = useApp((s) => s.edit);
  const set = useApp((s) => s.set);
  const selected = useApp((s) => s.selectedLayerId);
  const plan = useApp((s) => s.plan);
  const tapered = Math.abs(project.mandrel.startDiameter - project.mandrel.endDiameter) > 1e-9;

  const add = (kind: "helical" | "hoop") => {
    const id = newLayerId(project.layers);
    edit((p) => {
      const layer: Layer =
        kind === "helical"
          ? { id, name: "Helical ±45°", enabled: true, kind: "helical", angleDeg: 45, mode: "constant", coverage: 1, pattern: "auto" }
          : { id, name: "Hoop", enabled: true, kind: "hoop", plies: 1 };
      p.layers.push(layer);
    });
    set({ selectedLayerId: id });
  };

  return (
    <Section
      title={`Layers · ${project.layers.length}`}
      right={
        <div className="flex gap-1">
          <button className="btn btn-ghost !h-6 !px-2 text-[11px]" onClick={() => add("helical")}>
            <Plus size={12} /> Helical
          </button>
          <button className="btn btn-ghost !h-6 !px-2 text-[11px]" onClick={() => add("hoop")}>
            <Plus size={12} /> Hoop
          </button>
        </div>
      }
    >
      <div className="-mx-1.5 flex flex-col gap-1">
        {project.layers.map((layer, i) => {
          const open = selected === layer.id;
          const issues = plan?.warnings.filter((w) => w.layerId === layer.id && w.level !== "info") ?? [];
          const worst = issues.some((w) => w.level === "error") ? STATUS.critical : issues.length ? STATUS.warning : null;
          return (
            <div
              key={layer.id}
              className={`rounded-[10px] border transition-colors ${open ? "border-white/10 bg-white/[0.05]" : "border-transparent hover:bg-white/[0.035]"}`}
            >
              <div
                className="group flex h-9 cursor-pointer items-center gap-2 pr-1.5 pl-2.5"
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onClick={() => set({ selectedLayerId: open ? null : layer.id })}
                onKeyDown={(e) => e.key === "Enter" && set({ selectedLayerId: open ? null : layer.id })}
              >
                <span className="num w-3 text-[10px] text-ink-4">{i + 1}</span>
                <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: layerColor(i), opacity: layer.enabled ? 1 : 0.3 }} />
                <span className={`min-w-0 flex-1 truncate font-medium ${layer.enabled ? "text-ink" : "text-ink-4 line-through"}`}>{layer.name || "Untitled"}</span>
                {worst && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: worst }} title={issues[0].message} />}
                <span className="num text-[11px] text-ink-3 group-hover:hidden">{describe(layer)}</span>
                <span className="hidden items-center group-hover:flex" onClick={(e) => e.stopPropagation()}>
                  <button className="icon-btn !h-6 !w-6" title="Move up" disabled={i === 0} onClick={() => edit((p) => void p.layers.splice(i - 1, 0, p.layers.splice(i, 1)[0]))}>
                    <ArrowUp size={13} />
                  </button>
                  <button
                    className="icon-btn !h-6 !w-6"
                    title="Move down"
                    disabled={i === project.layers.length - 1}
                    onClick={() => edit((p) => void p.layers.splice(i + 1, 0, p.layers.splice(i, 1)[0]))}
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    className="icon-btn !h-6 !w-6"
                    title="Duplicate"
                    onClick={() => edit((p) => void p.layers.splice(i + 1, 0, { ...structuredClone(p.layers[i]), id: newLayerId(p.layers) }))}
                  >
                    <Copy size={12} />
                  </button>
                  <button className="icon-btn !h-6 !w-6" title={layer.enabled ? "Skip this layer" : "Include this layer"} onClick={() => edit((p) => void (p.layers[i].enabled = !p.layers[i].enabled))}>
                    {layer.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
                  </button>
                  <button className="icon-btn !h-6 !w-6 hover:!text-critical" title="Delete layer" onClick={() => edit((p) => void p.layers.splice(i, 1))}>
                    <Trash2 size={13} />
                  </button>
                </span>
              </div>
              {open && <LayerEditor layer={layer} index={i} tapered={tapered} />}
            </div>
          );
        })}
        {project.layers.length === 0 && <p className="px-2.5 py-3 text-ink-3">No layers yet. Add a helical or hoop layer to start.</p>}
      </div>
    </Section>
  );
}

export function PartPanel() {
  const project = useApp((s) => s.project);
  if (!project) return null;
  return (
    <>
      <MandrelSection project={project} />
      <LayersSection project={project} />
      <MaterialSection project={project} />
      <ProcessSection project={project} />
    </>
  );
}
