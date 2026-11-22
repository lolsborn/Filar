import { Plus, Trash2 } from "lucide-react";
import { activeCase, newId, useApp } from "../lib/store";
import { SERIES } from "../lib/theme";
import type { LoadCase, PlyProperties, Project } from "../lib/types";
import { libraryState, samePly, useLibrary } from "../lib/library";
import { useToast } from "../lib/actions";
import { LibraryBar } from "./LibraryBar";
import { useUnits, type Units } from "../lib/units";
import { Field, Num, Section, Seg, Select, Text, Toggle } from "./ui";

/** Line key for a load case: colour plus solid/dashed, matching the chart. */
export function CaseKey({ index }: { index: number }) {
  const color = SERIES[index % SERIES.length];
  return (
    <span
      className="h-[3px] w-3.5 shrink-0 rounded-full"
      style={{ background: index % 2 ? `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 6px)` : color }}
    />
  );
}

type Preset = "pressure" | "airframe" | "shaft" | "custom";

const PRESETS: Record<Exclude<Preset, "custom">, Omit<LoadCase, "id">> = {
  pressure: { name: "Internal pressure", pressure: 20, axialForce: 0, bendingMoment: 0, torque: 0, closedEnds: true },
  airframe: { name: "Flight loads", pressure: 0, axialForce: -500, bendingMoment: 50, torque: 0, closedEnds: false },
  shaft: { name: "Drive torque", pressure: 0, axialForce: 0, bendingMoment: 0, torque: 50, closedEnds: false },
};

function presetOf(c: LoadCase): Preset {
  const has = { p: c.pressure !== 0, f: c.axialForce !== 0, m: c.bendingMoment !== 0, t: c.torque !== 0 };
  if (has.p && !has.f && !has.m && !has.t) return "pressure";
  if (!has.p && !has.t && (has.m || has.f)) return "airframe";
  if (has.t && !has.p && !has.f && !has.m) return "shaft";
  return "custom";
}

function summary(c: LoadCase, U: Units): string {
  const parts: string[] = [];
  if (c.pressure) parts.push(U.fmt("pressure", c.pressure, 0));
  if (c.bendingMoment) parts.push(U.fmt("moment", c.bendingMoment, 0));
  if (c.torque) parts.push(`${U.fmt("moment", c.torque, 0)} torque`);
  if (c.axialForce) parts.push(U.fmt("force", c.axialForce, 0));
  return parts.slice(0, 2).join(" · ") || "no load";
}

function LoadCases({ project }: { project: Project }) {
  const edit = useApp((s) => s.edit);
  const set = useApp((s) => s.set);
  const analysis = useApp((s) => s.analysis);
  const caseId = useApp((s) => s.caseId);
  const U = useUnits();
  const cases = project.analysis.loadCases;
  const active = Math.min(activeCase(analysis, caseId), Math.max(cases.length - 1, 0));
  const c = cases[active];
  const update = (fn: (c: LoadCase) => void, key: string) => edit((p) => fn(p.analysis.loadCases[active]), `case:${c?.id}:${key}`);

  return (
    <Section
      title={`Load cases · ${cases.length}`}
      right={
        <button
          className="btn btn-ghost !h-6 !px-2 text-[11px]"
          disabled={cases.length >= 4}
          title={cases.length >= 4 ? "Up to four load cases" : "Add a load case"}
          onClick={() => {
            const id = newId("c", cases);
            edit((p) => void p.analysis.loadCases.push({ id, ...PRESETS.airframe }));
            set({ caseId: id });
          }}
        >
          <Plus size={12} /> Add
        </button>
      }
    >
      <div className="-mx-1.5 mb-3 flex flex-col gap-1">
        {cases.map((lc, i) => (
          <div
            key={lc.id}
            role="button"
            tabIndex={0}
            aria-pressed={i === active}
            onClick={() => set({ caseId: lc.id })}
            onKeyDown={(e) => e.key === "Enter" && set({ caseId: lc.id })}
            className={`group flex h-9 cursor-pointer items-center gap-2 rounded-[10px] border pr-1.5 pl-2.5 ${
              i === active ? "border-white/10 bg-white/[0.05]" : "border-transparent hover:bg-white/[0.035]"
            }`}
          >
            <CaseKey index={i} />
            <span className="min-w-0 flex-1 truncate font-medium text-ink">{lc.name || "Untitled"}</span>
            <span className="num truncate text-[11px] text-ink-3 group-hover:hidden">{summary(lc, U)}</span>
            {cases.length > 1 && (
              <span className="hidden group-hover:flex">
                <button
                  className="icon-btn !h-6 !w-6 hover:!text-critical"
                  title="Delete load case"
                  onClick={(e) => {
                    e.stopPropagation();
                    edit((p) => void p.analysis.loadCases.splice(i, 1));
                    set({ caseId: null });
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            )}
          </div>
        ))}
        {cases.length === 0 && <p className="px-2.5 py-2 text-ink-3">Add a load case to see reserve factors.</p>}
      </div>

      {c && (
        <div className="grid grid-cols-2 gap-x-2.5 gap-y-2.5">
          <Field label="Name" span>
            <Text value={c.name} maxLength={40} onChange={(v) => update((x) => void (x.name = v), "name")} />
          </Field>
          <Field label="Start from" span hint="Fills in a typical set of loads to edit">
            <Seg
              fill
              value={presetOf(c)}
              options={[
                { value: "pressure", label: "Pressure", title: "Pressure tube or vessel" },
                { value: "airframe", label: "Airframe", title: "Bending plus axial compression" },
                { value: "shaft", label: "Shaft", title: "Torque" },
                { value: "custom", label: "Custom", title: "Any combination" },
              ]}
              onChange={(v) => v !== "custom" && edit((p) => void (p.analysis.loadCases[active] = { id: c.id, ...PRESETS[v] }))}
            />
          </Field>
          <Field label="Internal pressure">
            <Num value={c.pressure} q="pressure" min={0} max={5000} step={5} onChange={(v) => update((x) => void (x.pressure = v), "p")} />
          </Field>
          <Field label="Axial force" hint="Tension is positive, compression negative">
            <Num value={c.axialForce} q="force" min={-1e7} max={1e7} step={100} onChange={(v) => update((x) => void (x.axialForce = v), "f")} />
          </Field>
          <Field label="Bending moment" hint="Both the tension and compression sides are checked">
            <Num value={c.bendingMoment} q="moment" min={0} max={1e7} step={10} onChange={(v) => update((x) => void (x.bendingMoment = v), "m")} />
          </Field>
          <Field label="Torque">
            <Num value={c.torque} q="moment" min={0} max={1e7} step={10} onChange={(v) => update((x) => void (x.torque = v), "t")} />
          </Field>
          <label className={`col-span-2 flex items-center gap-2 text-ink-2 ${c.pressure ? "" : "opacity-40"}`} title="With closed ends, pressure also pulls the tube apart along its axis">
            <Toggle value={c.closedEnds} aria-label="Closed ends" onChange={(v) => edit((p) => void (p.analysis.loadCases[active].closedEnds = v))} />
            Closed ends (pressure adds axial load)
          </label>
        </div>
      )}
    </Section>
  );
}

function PlySection({ project }: { project: Project }) {
  const edit = useApp((s) => s.edit);
  const builtins = useApp((s) => s.defaults?.plies ?? []);
  const saved = useLibrary((s) => s.plies);
  const toast = useToast((s) => s.show);
  const ply = project.analysis.ply;
  const state = libraryState(ply, builtins, saved, samePly);
  const listed = state !== "new";
  const set = (key: keyof Omit<PlyProperties, "name">) => (v: number) => edit((p) => void (p.analysis.ply[key] = v), `ply:${key}`);
  const vf = project.material.fiberVolumeFraction;
  const scale = ply.referenceVf > 0 ? vf / ply.referenceVf : 1;
  const tag = state === "builtin" ? "Textbook values" : state === "saved" ? "Your values" : "Edited";

  return (
    <Section
      title="Ply properties"
      right={
        <span
          className="rounded-full border border-white/15 px-2 py-px text-[10px] font-medium text-ink-2"
          title={state === "builtin" ? "Representative textbook-range values, not data for a specific product. Replace them with tested values when you have them." : undefined}
        >
          {tag}
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-x-2.5 gap-y-2.5">
        <Field label="Start from" span>
          <Select
            aria-label="Ply property set"
            value={listed ? ply.name : "__custom"}
            options={[
              ...builtins.map((p) => ({ value: p.name, label: p.name, group: "Built in" })),
              ...saved.map((p) => ({ value: p.name, label: p.name, group: "Your ply sets" })),
              ...(listed ? [] : [{ value: "__custom", label: `${ply.name || "Untitled"} (not saved)` }]),
            ]}
            onChange={(name) =>
              edit((p) => {
                const entry = [...builtins, ...saved].find((x) => x.name === name);
                if (entry) p.analysis.ply = structuredClone(entry);
              })
            }
          />
        </Field>
        <Field label="Name" span>
          <Text aria-label="Ply set name" value={ply.name} maxLength={48} onChange={(v) => edit((p) => void (p.analysis.ply.name = v), "ply:name")} />
        </Field>
        <Field label="E₁ along fibre">
          <Num value={ply.e1} q="modulus" min={0.1} max={1000} step={5} onChange={set("e1")} />
        </Field>
        <Field label="E₂ across fibre">
          <Num value={ply.e2} q="modulus" min={0.1} max={1000} step={0.5} onChange={set("e2")} />
        </Field>
        <Field label="G₁₂ shear">
          <Num value={ply.g12} q="modulus" min={0.1} max={500} step={0.5} onChange={set("g12")} />
        </Field>
        <Field label="Poisson's ratio ν₁₂">
          <Num value={ply.nu12} min={0} max={0.9} step={0.01} onChange={set("nu12")} />
        </Field>
        <Field label="Fibre tension" hint="Strength along the fibre in tension">
          <Num value={ply.xt} q="stress" min={1} max={10000} step={50} onChange={set("xt")} />
        </Field>
        <Field label="Fibre compression" hint="Strength along the fibre in compression">
          <Num value={ply.xc} q="stress" min={1} max={10000} step={50} onChange={set("xc")} />
        </Field>
        <Field label="Matrix tension" hint="Strength across the fibre in tension">
          <Num value={ply.yt} q="stress" min={1} max={1000} step={5} onChange={set("yt")} />
        </Field>
        <Field label="Matrix compression" hint="Strength across the fibre in compression">
          <Num value={ply.yc} q="stress" min={1} max={2000} step={10} onChange={set("yc")} />
        </Field>
        <Field label="Shear strength">
          <Num value={ply.s} q="stress" min={1} max={1000} step={5} onChange={set("s")} />
        </Field>
        <Field label="Quoted at fibre volume" hint="The fibre volume fraction these values were measured or quoted at">
          <Num value={Number((ply.referenceVf * 100).toFixed(1))} unit="%" min={10} max={90} step={1} onChange={(v) => set("referenceVf")(v / 100)} />
        </Field>
      </div>
      <p className="mt-2.5 text-[11px] leading-snug text-ink-3">
        Fibre-direction values are scaled by <span className="num text-ink-2">{scale.toFixed(2)}</span> to this band's{" "}
        <span className="num text-ink-2">{(vf * 100).toFixed(0)}%</span> fibre volume.
      </p>
      <LibraryBar
        state={state}
        noun="ply set"
        invalid={ply.name.trim() ? null : "Give it a name to save it."}
        onSave={async () => {
          const ok = await useLibrary.getState().savePly(ply);
          toast(ok ? `${ply.name} saved to your library` : "Could not save the library", ok ? "ok" : "error");
        }}
        onRevert={() => {
          const entry = [...builtins, ...saved].find((x) => x.name === ply.name);
          if (entry) edit((p) => void (p.analysis.ply = structuredClone(entry)));
        }}
        onDelete={async () => {
          const ok = await useLibrary.getState().removePly(ply.name);
          toast(ok ? `${ply.name} removed from your library. This project still uses it.` : "Could not update the library", ok ? "ok" : "error");
        }}
      />
    </Section>
  );
}

function MethodSection({ project }: { project: Project }) {
  const edit = useApp((s) => s.edit);
  const a = project.analysis;
  return (
    <Section title="Method">
      <div className="grid grid-cols-2 gap-x-2.5 gap-y-2.5">
        <Field label="Failure criterion" span>
          <Seg
            fill
            value={a.criterion}
            options={[
              { value: "tsaiWu", label: "Tsai-Wu", title: "Accounts for stresses acting together" },
              { value: "maxStress", label: "Max stress", title: "Each stress checked on its own" },
            ]}
            onChange={(v) => edit((p) => void (p.analysis.criterion = v))}
          />
        </Field>
        <Field label="Required reserve factor" hint="The margin the design has to reach. 1.0 means failure exactly at the applied load.">
          <Num value={a.requiredRf} min={0.1} max={20} step={0.1} onChange={(v) => edit((p) => void (p.analysis.requiredRf = v), "req")} />
        </Field>
        <Field label="Winding knock-down" hint="Multiplies every ply strength to allow for fibre crossovers, voids and resin variation in a wound laminate. Set it from your own test results when you have them.">
          <Num value={a.knockdown} min={0.05} max={1} step={0.05} onChange={(v) => edit((p) => void (p.analysis.knockdown = v), "kd")} />
        </Field>
      </div>
    </Section>
  );
}

export function AnalysePanel() {
  const project = useApp((s) => s.project);
  if (!project) return null;
  return (
    <>
      <LoadCases project={project} />
      <PlySection project={project} />
      <MethodSection project={project} />
    </>
  );
}
