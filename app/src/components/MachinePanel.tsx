import { useApp } from "../lib/store";
import type { Axis, MachineProfile } from "../lib/types";
import { Field, Num, Section, Select, Text, Toggle } from "./ui";

type AxisKey = "carriage" | "spindle" | "crossfeed" | "eye";

const AXES: { key: AxisKey; label: string; what: string; unit: string; optional: boolean }[] = [
  { key: "carriage", label: "Carriage", what: "Traverse along the mandrel", unit: "mm", optional: false },
  { key: "spindle", label: "Spindle", what: "Mandrel rotation", unit: "°", optional: false },
  { key: "crossfeed", label: "Cross-feed", what: "Eye in and out", unit: "mm", optional: true },
  { key: "eye", label: "Eye rotation", what: "Keeps the band flat", unit: "°", optional: true },
];

function AxisRow({ axisKey, axis, label, what, unit, optional }: { axisKey: AxisKey; axis: Axis; label: string; what: string; unit: string; optional: boolean }) {
  const edit = useApp((s) => s.edit);
  const set = (fn: (a: Axis) => void, key: string) => edit((p) => fn(p.machine[axisKey]), `${axisKey}:${key}`);
  const rotary = unit === "°";
  return (
    <div className={`rounded-[10px] border border-white/[0.06] p-2.5 ${axis.enabled ? "" : "opacity-60"}`}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-ink">{label}</div>
          <div className="truncate text-[11px] text-ink-3">{what}</div>
        </div>
        {optional && <Toggle value={axis.enabled} aria-label={`${label} axis fitted`} onChange={(v) => edit((p) => void (p.machine[axisKey].enabled = v))} />}
      </div>
      {axis.enabled && (
        <div className="mt-2 grid grid-cols-3 gap-2">
          <Field label="Word">
            <Text mono maxLength={1} value={axis.letter} onChange={(v) => set((a) => void (a.letter = v.toUpperCase().replace(/[^A-Z]/g, "")), "letter")} />
          </Field>
          <Field label={rotary ? "Max °/s" : "Max speed"}>
            <Num q={rotary ? undefined : "speed"} value={axis.maxSpeed} min={0.1} max={100000} step={10} onChange={(v) => set((a) => void (a.maxSpeed = v), "speed")} />
          </Field>
          <Field label={`Units per ${unit}`} hint={rotary ? "1 for degrees, 0.002778 for revolutions" : "1 for millimetres"}>
            <Num value={axis.scale} min={0.000001} max={100000} step={0.1} digits={6} onChange={(v) => set((a) => void (a.scale = v), "scale")} />
          </Field>
          {axisKey !== "spindle" && (
            <>
              <Field label="Min">
                <Num value={axis.min ?? 0} step={10} onChange={(v) => set((a) => void (a.min = v), "min")} />
              </Field>
              <Field label="Max">
                <Num value={axis.max ?? 0} step={10} onChange={(v) => set((a) => void (a.max = v), "max")} />
              </Field>
            </>
          )}
          <Field label="Offset" hint="Added to the output, in machine units">
            <Num value={axis.offset} step={1} onChange={(v) => set((a) => void (a.offset = v), "offset")} />
          </Field>
          <label className="col-span-3 flex items-center gap-2 pt-0.5 text-ink-2">
            <Toggle value={axis.invert} aria-label={`Reverse ${label}`} onChange={(v) => edit((p) => void (p.machine[axisKey].invert = v))} />
            Reverse direction
          </label>
        </div>
      )}
    </div>
  );
}

export function MachinePanel() {
  const project = useApp((s) => s.project);
  const presets = useApp((s) => s.defaults?.machines ?? []);
  const edit = useApp((s) => s.edit);
  if (!project) return null;
  const m: MachineProfile = project.machine;
  const g = m.gcode;
  const isPreset = presets.some((p) => p.name === m.name);

  return (
    <>
      <Section title="Machine profile">
        <Field label="Start from" span>
          <Select
            value={isPreset ? m.name : "__custom"}
            options={[...presets.map((p) => ({ value: p.name, label: p.name })), ...(isPreset ? [] : [{ value: "__custom", label: m.name || "Custom" }])]}
            onChange={(name) =>
              edit((p) => {
                const preset = presets.find((x) => x.name === name);
                if (preset) p.machine = structuredClone(preset);
              })
            }
          />
        </Field>
        {m.note && <p className="mt-2 text-[11px] leading-snug text-ink-3">{m.note}</p>}
        <div className="mt-3 grid grid-cols-2 gap-x-2.5 gap-y-2.5">
          <Field label="Profile name" span>
            <Text value={m.name} maxLength={60} onChange={(v) => edit((p) => void (p.machine.name = v), "mname")} />
          </Field>
          {m.crossfeed.enabled ? (
            <Field label="Eye standoff" hint="Gap the cross-feed keeps between the delivery eye and the mandrel surface">
              <Num value={m.clearance} q="length" min={2} max={1000} step={5} onChange={(v) => edit((p) => void (p.machine.clearance = v), "clr")} />
            </Field>
          ) : (
            <Field label="Eye distance" hint="Fixed distance from the spindle axis to the delivery eye">
              <Num value={m.eyeDistance} q="length" min={5} max={2000} step={5} onChange={(v) => edit((p) => void (p.machine.eyeDistance = v), "eye")} />
            </Field>
          )}
        </div>
      </Section>

      <Section title={`Axes · ${2 + Number(m.crossfeed.enabled) + Number(m.eye.enabled)}`}>
        <div className="flex flex-col gap-2">
          {AXES.map((a) => (
            <AxisRow key={a.key} axisKey={a.key} axis={m[a.key]} label={a.label} what={a.what} unit={a.unit} optional={a.optional} />
          ))}
        </div>
      </Section>

      <Section title="G-code dialect">
        <div className="grid grid-cols-2 gap-x-2.5 gap-y-2.5">
          <Field label="Feed rate" span hint="How the controller interprets F on a move that mixes linear and rotary axes">
            <Select
              value={g.feedMode}
              options={[
                { value: "inverseTime", label: "Inverse time (G93)" },
                { value: "linearAxes", label: "G94 — F applies to linear axes" },
                { value: "allAxes", label: "G94 — F applies across all axes" },
              ]}
              onChange={(v) => edit((p) => void (p.machine.gcode.feedMode = v))}
            />
          </Field>
          <Field label="Spindle angle" span hint="Wrapping keeps numbers small on controllers that store positions as 32-bit floats">
            <Select
              value={g.rotaryMode}
              options={[
                { value: "cumulative", label: "Keeps counting up" },
                { value: "wrapEachCircuit", label: "Wrap with G92 each circuit" },
              ]}
              onChange={(v) => edit((p) => void (p.machine.gcode.rotaryMode = v))}
            />
          </Field>
          <Field label="Comments">
            <Select
              value={g.comments}
              options={[
                { value: "semicolon", label: "; semicolon" },
                { value: "parentheses", label: "(parentheses)" },
                { value: "none", label: "None" },
              ]}
              onChange={(v) => edit((p) => void (p.machine.gcode.comments = v))}
            />
          </Field>
          <Field label="Decimals">
            <Num value={g.decimals} integer min={1} max={6} onChange={(v) => edit((p) => void (p.machine.gcode.decimals = v), "dec")} />
          </Field>
          <Field label="Longest move" hint="Moves longer than this are split. 0 disables splitting.">
            <Num value={g.maxMoveTime} unit="s" min={0} max={600} step={0.5} onChange={(v) => edit((p) => void (p.machine.gcode.maxMoveTime = v), "mmt")} />
          </Field>
          <label className="flex items-end gap-2 pb-1.5 text-ink-2">
            <Toggle value={g.lineNumbers} aria-label="Line numbers" onChange={(v) => edit((p) => void (p.machine.gcode.lineNumbers = v))} />
            Line numbers
          </label>
          <Field label="Start of program" span>
            <textarea className="code scroll" rows={3} spellCheck={false} value={g.header} onChange={(e) => edit((p) => void (p.machine.gcode.header = e.target.value), "hdr")} />
          </Field>
          <Field label="End of program" span>
            <textarea className="code scroll" rows={2} spellCheck={false} value={g.footer} onChange={(e) => edit((p) => void (p.machine.gcode.footer = e.target.value), "ftr")} />
          </Field>
        </div>
      </Section>
    </>
  );
}
