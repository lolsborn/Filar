import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from "lucide-react";
import { useApp } from "../lib/store";
import { deg, duration, fmt } from "../lib/format";
import { layerColor, STATUS } from "../lib/theme";
import type { LayerReport, Pattern, Plan, Project, Warning } from "../lib/types";
import { Chart, type Series } from "./Chart";
import { KV, Section, Stat } from "./ui";
import { useUnits } from "../lib/units";

export function Summary({ plan }: { plan: Plan }) {
  const t = plan.totals;
  const U = useUnits();
  const analysis = useApp((s) => s.analysis);
  const required = useApp((s) => s.project?.analysis.requiredRf ?? 1.5);
  const setMode = useApp((s) => s.setMode);
  const governing = analysis?.ok && analysis.minRf != null ? analysis.cases[analysis.governingCase] : null;
  const round = useApp((s) => s.project?.material.shape === "round");
  return (
    <Section title="Summary">
      <div className="grid grid-cols-3 gap-x-3 gap-y-3.5">
        <Stat label="Wind time" value={duration(t.duration)} />
        <Stat label="Wall" value={U.num("length", t.wallThickness, 2)} unit={U.label("length")} />
        <Stat label="Part mass" value={U.num("mass", t.partMassG, 0)} unit={U.label("mass")} />
        <Stat label={round ? "Length" : "Fibre"} value={U.num("run", t.fiberLengthM, 0)} unit={U.label("run")} />
        <Stat label={round ? "Strand mass" : "Fibre mass"} value={U.num("mass", t.fiberMassG, 0)} unit={U.label("mass")} />
        {round ? <Stat label="Resin" value="none" sub="wound dry" /> : <Stat label="Resin" value={U.num("mass", t.resinMassG, 0)} unit={U.label("mass")} />}
      </div>
      {governing && (
        <button
          className="mt-3.5 flex w-full cursor-pointer items-center gap-2 rounded-[10px] bg-white/[0.04] px-2.5 py-2 text-left hover:bg-white/[0.07]"
          title="Open the Analyse workspace"
          onClick={() => setMode("analyse")}
        >
          {governing.minRf >= required ? <CheckCircle2 size={15} style={{ color: STATUS.good }} /> : <OctagonAlert size={15} style={{ color: STATUS.critical }} />}
          <span className="min-w-0 flex-1 truncate text-ink-2">
            Reserve factor <span className="num font-semibold text-ink">{governing.minRf >= 99 ? "99+" : governing.minRf.toFixed(2)}</span>
            <span className="text-ink-3"> · {governing.name}, estimate</span>
          </span>
          <span className="text-[11px] text-ink-3">Analyse ›</span>
        </button>
      )}
    </Section>
  );
}

const LEVEL = {
  error: { icon: OctagonAlert, color: STATUS.critical, label: "Error" },
  warn: { icon: AlertTriangle, color: STATUS.warning, label: "Warning" },
  info: { icon: Info, color: "#7f838b", label: "Note" },
};

export function Warnings({ plan, project }: { plan: Plan; project: Project }) {
  const set = useApp((s) => s.set);
  const list = [...plan.warnings].sort((a, b) => rank(a) - rank(b));
  if (list.length === 0) {
    return (
      <div className="hairline flex items-center gap-2 border-b px-4 py-3 text-ink-2">
        <CheckCircle2 size={15} style={{ color: STATUS.good }} />
        Ready to wind. No issues found.
      </div>
    );
  }
  return (
    <div className="hairline flex flex-col gap-1.5 border-b px-3 py-3">
      {list.map((w, i) => {
        const L = LEVEL[w.level];
        const layer = project.layers.find((l) => l.id === w.layerId);
        return (
          <button
            key={i}
            className={`flex gap-2.5 rounded-[10px] bg-white/[0.035] px-2.5 py-2 text-left ${layer ? "cursor-pointer hover:bg-white/[0.06]" : ""}`}
            onClick={() => layer && set({ selectedLayerId: layer.id, leftTab: "part" })}
          >
            <L.icon size={15} className="mt-px shrink-0" style={{ color: L.color }} />
            <span className="selectable min-w-0 text-[12px] leading-snug text-ink-2">
              <span className="font-semibold text-ink">
                {L.label}
                {layer ? ` · ${layer.name}` : ""}
              </span>
              <br />
              {w.message}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const rank = (w: Warning) => (w.level === "error" ? 0 : w.level === "warn" ? 1 : 2);

function PatternTable({ report, layerIndex }: { report: LayerReport; layerIndex: number }) {
  const edit = useApp((s) => s.edit);
  const project = useApp((s) => s.project)!;
  const layer = project.layers[layerIndex];
  const chosen = report.pattern;
  const isAuto = layer.kind === "helical" && layer.pattern === "auto";
  const pick = (p: Pattern | null) =>
    edit((proj) => {
      const l = proj.layers[layerIndex];
      if (l.kind !== "helical") return;
      const base = { id: l.id, name: l.name, enabled: l.enabled, kind: "helical" as const, angleDeg: l.angleDeg, mode: l.mode, coverage: l.coverage };
      proj.layers[layerIndex] = p ? { ...base, pattern: "manual", circuits: p.circuits, skip: p.skip } : { ...base, pattern: "auto" };
    });

  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="label">Closed patterns · {report.candidates.length}</span>
        <button className={`btn !h-6 !px-2 text-[11px] ${isAuto ? "!bg-accent/15 !text-accent" : ""}`} onClick={() => pick(null)} title="Let Filar choose the pattern">
          Auto{isAuto ? " ✓" : ""}
        </button>
      </div>
      <div className="overflow-hidden rounded-[10px] border border-white/[0.07]">
        <div className="grid grid-cols-[1fr_1fr_1.2fr_1.2fr] bg-white/[0.04] px-2.5 py-1.5 text-[10px] font-semibold tracking-wide text-ink-3 uppercase">
          <span title="Diamonds around the circumference">Pattern</span>
          <span className="text-right">Circuits</span>
          <span className="text-right" title="Band coverage at the widest station">
            Cover
          </span>
          <span className="text-right" title="Extra hoop rotation per circuit needed to close the pattern">
            Dwell
          </span>
        </div>
        <div className="scroll max-h-[190px]">
          {report.candidates.map((c) => {
            const on = !!chosen && c.circuits === chosen.circuits && c.skip === chosen.skip;
            return (
              <button
                key={`${c.circuits}:${c.skip}`}
                aria-pressed={on}
                onClick={() => pick(c)}
                className={`num grid w-full cursor-pointer grid-cols-[1fr_1fr_1.2fr_1.2fr] px-2.5 py-[5px] text-left text-[12px] ${
                  on ? "bg-accent/[0.13] text-ink" : "text-ink-2 hover:bg-white/[0.05]"
                }`}
                title={`${c.circuits} circuits, advancing ${c.skip} band positions per circuit (${c.leading ? "leading" : "lagging"})`}
              >
                <span className="flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-accent" : "bg-transparent"}`} />
                  {c.patternNumber}
                </span>
                <span className="text-right">{c.circuits}</span>
                <span className="text-right">{fmt(c.coverage * 100, 0)}%</span>
                <span className="text-right">{fmt(deg(c.dwell), 1)}°</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function LayerDetails({ plan, project }: { plan: Plan; project: Project }) {
  const selected = useApp((s) => s.selectedLayerId);
  const U = useUnits();
  const index = project.layers.findIndex((l) => l.id === selected);
  const layer = project.layers[index];
  const report = plan.layers.find((l) => l.id === selected);
  if (!layer) {
    return (
      <Section title="Layer">
        <p className="text-ink-3">Select a layer to see its pattern and winding details.</p>
      </Section>
    );
  }
  if (!layer.enabled) {
    return (
      <Section title={layer.name || "Layer"}>
        <p className="text-ink-3">This layer is skipped. Enable it to include it in the wind.</p>
      </Section>
    );
  }
  if (!report || !report.ok) {
    return (
      <Section title={layer.name || "Layer"}>
        <p className="text-ink-3">This layer could not be planned. See the error above.</p>
      </Section>
    );
  }
  const p = report.pattern;
  const mu = project.process.friction;
  const tapered = Math.abs(report.angleHeadDeg - report.angleTailDeg) > 0.05 || Math.abs(report.coverageHead - report.coverageTail) > 0.01;
  return (
    <Section
      title={layer.name || "Layer"}
      right={<span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: layerColor(index) }} />}
    >
      {report.kind === "helical" && p ? (
        <>
          <div className="grid grid-cols-3 gap-x-3">
            <Stat label="Circuits" value={String(p.circuits)} />
            <Stat label="Pattern" value={String(p.patternNumber)} sub="diamonds around" />
            <Stat label="Thickness" value={U.num("length", report.thickness, 2)} unit={U.label("length")} />
          </div>
          <div className="mt-3">
            <KV k="Angle, head → tail" v={tapered ? `${fmt(report.angleHeadDeg, 1)}° → ${fmt(report.angleTailDeg, 1)}°` : `${fmt(report.angleHeadDeg, 1)}°`} />
            <KV
              k="Coverage, head → tail"
              v={tapered ? `${fmt(report.coverageHead * 100, 0)}% → ${fmt(report.coverageTail * 100, 0)}%` : `${fmt(report.coverageHead * 100, 0)}%`}
              title="Above 100% the bands overlap, which is what builds thickness towards the small end of a taper"
            />
            <KV k="Dwell per circuit" v={`${fmt(deg(p.dwell), 1)}°`} title="Hoop rotation added at the ends so the pattern closes exactly" />
            <KV k="Turnaround, head / tail" v={`${U.num("length", report.turnHead, 0)} / ${U.fmt("length", report.turnTail, 0)}`} title="Mandrel length used beyond the part at each end" />
            <KV
              k="Friction needed"
              v={
                <span className="flex items-center gap-1.5">
                  {report.maxSlip > mu + 1e-9 && <AlertTriangle size={12} style={{ color: STATUS.warning }} />}
                  {fmt(report.maxSlip, 2)} <span className="text-ink-4">of {fmt(mu, 2)}</span>
                </span>
              }
              title="Slip tendency in the part zone compared with the available friction coefficient"
            />
            <KV k="Fibre" v={U.fmt("run", report.fiberLength / 1000, 1)} />
            <KV k="Time" v={duration(report.duration)} />
          </div>
          <PatternTable report={report} layerIndex={index} />
        </>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-x-3">
            <Stat label="Plies" value={String(report.plies)} />
            <Stat label="Angle" value={fmt(report.angleHeadDeg, 1)} unit="°" />
            <Stat label="Thickness" value={U.num("length", report.thickness, 2)} unit={U.label("length")} />
          </div>
          <div className="mt-3">
            <KV k="Advance per turn" v={U.fmt("length", project.material.bandWidth, 2)} />
            <KV
              k="Friction needed"
              v={
                <span>
                  {fmt(report.maxSlip, 2)} <span className="text-ink-4">of {fmt(mu, 2)}</span>
                </span>
              }
            />
            <KV k="Fibre" v={U.fmt("run", report.fiberLength / 1000, 1)} />
            <KV k="Time" v={duration(report.duration)} />
          </div>
        </>
      )}
    </Section>
  );
}

/** Thickness build-up and winding angle along the mandrel. */
export function DesignCharts({ plan, project }: { plan: Plan; project: Project }) {
  const st = plan.stations;
  const U = useUnits();
  const len = (v: number) => U.to("length", v);
  const extra = U.unit("length").extra;
  const z = st.z.map(len);
  const band = { from: len(plan.mandrel.partStart), to: len(plan.mandrel.partEnd), label: "part" };
  const order = st.layers.map((sl) => project.layers.findIndex((l) => l.id === sl.layerId));
  const label = (i: number) => `${order[i] + 1} · ${project.layers[order[i]]?.name ?? ""}`;

  // Thickness stacks in winding order: each band sits on the layers below it.
  const running = new Array(st.z.length).fill(0);
  const thickness: Series[] = st.layers.map((sl, i) => {
    const base = [...running];
    const top = sl.thickness.map((t, k) => (running[k] += len(t)));
    return { name: label(i), color: layerColor(order[i]), values: top, base, display: sl.thickness.map(len) };
  });
  const angles: Series[] = st.layers.map((sl, i) => ({ name: label(i), color: layerColor(order[i]), values: sl.angle }));

  return (
    <div className="grid h-full grid-cols-2 gap-5">
      <Chart
        title="Wall build-up"
        subtitle={U.label("length")}
        x={z}
        series={thickness}
        xUnit={U.label("length")}
        xDigits={extra}
        yUnit={U.label("length")}
        yDigits={2 + extra}
        band={band}
        total={{ label: "Wall", values: st.thickness.map(len) }}
      />
      <Chart title="Winding angle" subtitle="° from axis" x={z} series={angles} xUnit={U.label("length")} xDigits={extra} yUnit="°" yDigits={1} yMin={0} yMax={90} band={band} />
    </div>
  );
}
