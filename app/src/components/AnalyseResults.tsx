import { ChevronLeft, ChevronRight, CircleCheck, GitCompareArrows, OctagonAlert } from "lucide-react";
import { activeCase, useApp } from "../lib/store";
import { fmt } from "../lib/format";
import { layerColor, RESERVE, SERIES, STATUS } from "../lib/theme";
import { FAILURE_MODE, type Analysis, type Project } from "../lib/types";
import { CaseKey } from "./AnalysePanel";
import { Chart, type Series } from "./Chart";
import { KV, Section, Select, Stat } from "./ui";
import { useUnits } from "../lib/units";

export const rfText = (rf: number | null | undefined) => (rf == null ? "–" : rf >= 99 ? "99+" : rf.toFixed(2));

/** Pass / fail against the requirement, in words and with an icon. */
export function Verdict({ rf, required }: { rf: number; required: number }) {
  const ok = rf >= required;
  const Icon = ok ? CircleCheck : OctagonAlert;
  return (
    <span className="flex items-center gap-1.5 font-semibold text-ink">
      <Icon size={15} style={{ color: ok ? STATUS.good : STATUS.critical }} />
      {ok ? `Meets required ${required}` : `Below required ${required}`}
    </span>
  );
}

function Disclaimer() {
  return (
    <div className="mx-3 mt-3 rounded-[10px] border border-dashed border-white/15 px-2.5 py-2 text-[11px] leading-snug text-ink-3">
      An estimate for comparing layups, from ply properties and thin-wall laminate theory. It is not a substitute for testing.
    </div>
  );
}

export function AnalyseResults({ analysis, project }: { analysis: Analysis; project: Project }) {
  const caseId = useApp((s) => s.caseId);
  const set = useApp((s) => s.set);
  const setCompare = useApp((s) => s.setCompare);
  const required = project.analysis.requiredRf;
  const U = useUnits();

  if (!analysis.ok) {
    return (
      <>
        <Disclaimer />
        <Section title="Result">
          <p className="text-ink-2">{analysis.message ?? "Nothing to analyse yet."}</p>
        </Section>
      </>
    );
  }
  if (analysis.cases.length === 0) {
    return (
      <>
        <Disclaimer />
        <Section title="Result">
          <p className="text-ink-2">Add a load case on the left to see reserve factors. Stiffness and capacity below do not need one.</p>
        </Section>
        <CapacityAndStiffness analysis={analysis} />
      </>
    );
  }

  const ci = activeCase(analysis, caseId);
  const summary = analysis.cases[ci];
  const station = analysis.stations[summary.station];
  const sc = station.cases[ci];
  const ply = station.plies[sc.critical];
  const layer = project.layers[ply.layerIndex];
  const mode = sc.plies[sc.critical].mode;

  return (
    <>
      <Disclaimer />
      <Section title={`Result · ${summary.name}`} right={<CaseKey index={ci} />}>
        <div className="flex items-center gap-3.5">
          <span className="num text-[38px] leading-none font-semibold tracking-tight text-ink">{rfText(summary.minRf)}</span>
          <span>
            <Verdict rf={summary.minRf} required={required} />
            <span className="text-[11px] text-ink-3">Lowest reserve factor</span>
          </span>
        </div>
        <div className="mt-3">
          <KV k="Where" v={`${U.fmt("length", station.z, 0)} from head`} />
          <KV k="Ply" v={`${sc.critical + 1} of ${station.plies.length} · ${layer?.name ?? "layer"} ${ply.angleDeg > 0 ? "+" : "−"}${fmt(Math.abs(ply.angleDeg), 0)}°`} />
          <KV k="Fails first by" v={FAILURE_MODE[mode]} />
        </div>
        {(mode === "matrixTension" || mode === "shear" || mode === "matrixCompression") && (
          <p className="mt-2 text-[11px] leading-snug text-ink-3">This is first damage in the resin, not rupture. Fibres usually carry load well beyond it.</p>
        )}
        <button className="btn mt-3 w-full" onClick={() => set({ stationIndex: summary.station })}>
          Ply detail at {U.fmt("length", station.z, 0)} <ChevronRight size={14} />
        </button>
      </Section>
      <CapacityAndStiffness analysis={analysis} />
      <div className="px-4 py-3">
        <button className="btn w-full" onClick={() => setCompare(true)}>
          <GitCompareArrows size={14} /> Compare layups…
        </button>
      </div>
    </>
  );
}

function CapacityAndStiffness({ analysis }: { analysis: Analysis }) {
  const c = analysis.capacity;
  const s = analysis.stiffness;
  const U = useUnits();
  return (
    <>
      <Section title="Capacity of this layup">
        <KV k="First-ply failure pressure" v={U.fmt("pressure", c.pressureBar, 0)} title="Closed ends, at the weakest station, knock-down applied" />
        <KV k="Fibre burst (netting)" v={U.fmt("pressure", c.nettingBurstBar, 0)} title="Fibres alone carrying hoop and axial load, closed ends, knock-down applied" />
        <KV k="Bending at first failure" v={U.fmt("moment", c.bendingNm, 0)} />
        <KV k="Torque at first failure" v={U.fmt("moment", c.torqueNm, 0)} />
        <KV k="Column buckling, pinned" v={U.fmt("bigForce", c.bucklingN / 1000, 1)} title="Euler buckling over the part length using the least stiff station. Thin-wall shell buckling is not checked." />
      </Section>
      <Section title="Stiffness at mid-part">
        <div className="grid grid-cols-3 gap-x-3">
          <Stat label="Axial" value={U.num("modulus", s.ex, 1)} unit={U.label("modulus")} />
          <Stat label="Hoop" value={U.num("modulus", s.eHoop, 1)} unit={U.label("modulus")} />
          <Stat label="Shear" value={U.num("modulus", s.g, 1)} unit={U.label("modulus")} />
        </div>
        <div className="mt-3">
          <KV k="Bending stiffness EI" v={U.fmt("bendStiffness", s.ei, 0)} />
          <KV k="Torsional stiffness GJ" v={U.fmt("bendStiffness", s.gj, 0)} />
          <KV k="Axial stiffness EA" v={U.fmt("axialStiffness", s.ea / 1e6, 2)} />
        </div>
      </Section>
    </>
  );
}

/** What each ply is carrying at one station. */
export function StationDetail({ analysis, project, index }: { analysis: Analysis; project: Project; index: number }) {
  const caseId = useApp((s) => s.caseId);
  const set = useApp((s) => s.set);
  const U = useUnits();
  const required = project.analysis.requiredRf;
  const ci = activeCase(analysis, caseId);
  const station = analysis.stations[index];
  const sc = station.cases[ci];
  if (!sc) return null;

  // Outside of the wall at the top, as you would look at a cut section.
  const order = station.plies.map((_, i) => i).reverse();
  const scaleMax = Math.max(required * 2, Math.min(sc.rf * 2.5, 99));
  const pct = (rf: number) => `${Math.min(rf / scaleMax, 1) * 100}%`;
  const critical = sc.plies[sc.critical];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="hairline flex items-center gap-2 border-b px-3 py-2.5">
        <button className="btn !px-2" onClick={() => set({ stationIndex: null })}>
          <ChevronLeft size={14} /> Results
        </button>
        <div className="ml-1 flex items-center">
          <button className="icon-btn" title="Previous station" disabled={index === 0} onClick={() => set({ stationIndex: index - 1 })}>
            <ChevronLeft size={15} />
          </button>
          <span className="num w-[92px] text-center text-[13px] font-semibold text-ink">{U.fmt("length", station.z, 0)}</span>
          <button className="icon-btn" title="Next station" disabled={index === analysis.stations.length - 1} onClick={() => set({ stationIndex: index + 1 })}>
            <ChevronRight size={15} />
          </button>
        </div>
        <span className="flex-1" />
        {analysis.cases.length > 1 && (
          <div className="w-[176px]">
            <Select aria-label="Load case" value={analysis.cases[ci].id} options={analysis.cases.map((c) => ({ value: c.id, label: c.name }))} onChange={(v) => set({ caseId: v })} />
          </div>
        )}
      </div>
      <div className="scroll min-h-0 flex-1">
        <div className="hairline grid grid-cols-4 gap-x-3 border-b px-4 py-3.5">
          <Stat label="Wall" value={U.num("length", station.wall, 2)} unit={U.label("length")} />
          <Stat label="Outside dia." value={U.num("length", station.outerDiameter, 1)} unit={U.label("length")} />
          <Stat label="Hoop stress" value={U.num("stress", sc.hoopStress, 0)} unit={U.label("stress")} />
          <Stat label="Axial stress" value={U.num("stress", sc.axialStress, 0)} unit={U.label("stress")} />
        </div>

        <Section title="Through the wall" right={<span className="text-[11px] text-ink-3">outside at top</span>}>
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-ink-3">
            <span>Reserve factor of each ply · {analysis.cases[ci].name}</span>
            <Verdict rf={sc.rf} required={required} />
          </div>
          <div className="relative">
            <div className="flex flex-col gap-[3px]">
              {order.map((i) => {
                const ply = station.plies[i];
                const st = sc.plies[i];
                const low = i === sc.critical;
                return (
                  <div key={i} className="flex h-[26px] items-center gap-2.5">
                    <div className={`flex h-full w-[150px] shrink-0 items-center gap-2 rounded-md px-2 ${low ? "bg-white/[0.11]" : "bg-white/[0.045]"}`}>
                      <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: layerColor(ply.layerIndex) }} />
                      <span className={`num truncate text-[11.5px] ${low ? "font-semibold text-ink" : "text-ink-2"}`}>
                        {i + 1} · {ply.angleDeg > 0 ? "+" : "−"}
                        {fmt(Math.abs(ply.angleDeg), 0)}° · {U.num("length", ply.thickness, 2)}
                      </span>
                    </div>
                    <div className="relative h-full flex-1">
                      <div className="absolute top-[7px] left-0 h-3 rounded-r-[4px]" style={{ width: pct(st.rf), background: SERIES[0], opacity: low ? 1 : 0.55 }} />
                      <span className={`num absolute top-[5px] pl-1.5 text-[11.5px] ${low ? "font-semibold text-ink" : "text-ink-2"}`} style={{ left: pct(st.rf) }}>
                        {rfText(st.rf)}
                        {low && " lowest"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            {/* The requirement, drawn across every bar */}
            <div className="pointer-events-none absolute top-0 bottom-0" style={{ left: 160, right: 0 }}>
              <div className="absolute top-[-2px] bottom-[-2px] w-px bg-ink/80" style={{ left: pct(required) }} />
            </div>
          </div>
          <div className="relative mt-1 h-4" style={{ marginLeft: 160 }}>
            <span className="num absolute -translate-x-1/2 text-[10.5px] text-ink-2" style={{ left: pct(required) }}>
              required {required}
            </span>
          </div>
          <p className="mt-0.5 text-[10.5px] text-ink-4">Each row: ply number · angle from the axis · thickness in {U.label("length")}. Mandrel side at the bottom.</p>
        </Section>

        <Section title="Ply stresses" right={<span className="text-[11px] text-ink-3">{U.label("stress")}, in each ply's fibre direction</span>}>
          <table className="num w-full text-right text-[12px]">
            <thead>
              <tr className="text-[10px] tracking-wide text-ink-3 uppercase">
                <th className="pb-1.5 text-left font-semibold">Ply</th>
                <th className="pb-1.5 font-semibold">Along</th>
                <th className="pb-1.5 font-semibold">Across</th>
                <th className="pb-1.5 font-semibold">Shear</th>
                <th className="pb-1.5 font-semibold">RF</th>
                <th className="pb-1.5 pl-3 text-left font-semibold">Fails by</th>
              </tr>
            </thead>
            <tbody>
              {order.map((i) => {
                const ply = station.plies[i];
                const st = sc.plies[i];
                const low = i === sc.critical;
                return (
                  <tr key={i} className={`border-t border-white/[0.07] ${low ? "bg-white/[0.07] font-semibold text-ink" : "text-ink-2"}`}>
                    <td className="py-[5px] pl-1.5 text-left">
                      {i + 1} · {ply.angleDeg > 0 ? "+" : "−"}
                      {fmt(Math.abs(ply.angleDeg), 0)}°
                    </td>
                    <td>{U.num("stress", st.s1, 0)}</td>
                    <td>{U.num("stress", st.s2, 1)}</td>
                    <td>{U.num("stress", st.t12, 1)}</td>
                    <td>{rfText(st.rf)}</td>
                    <td className="pr-1.5 pl-3 text-left font-sans">{FAILURE_MODE[st.mode]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2.5 text-[11px] leading-snug text-ink-3">
            {critical.mode === "fibreTension" || critical.mode === "fibreCompression"
              ? "The governing ply fails in its fibres, which is rupture of that ply."
              : "The governing ply fails in its resin first. That is cracking, not rupture; the fibres usually carry on well past it."}{" "}
            Fibre burst for the weakest wall is estimated at {U.fmt("pressure", analysis.capacity.nettingBurstBar, 0)}.
          </p>
        </Section>
      </div>
    </div>
  );
}

/** Reserve factor along the part, one line per load case. */
export function ReserveChart({ analysis, project }: { analysis: Analysis; project: Project }) {
  const set = useApp((s) => s.set);
  const stationIndex = useApp((s) => s.stationIndex);
  const caseId = useApp((s) => s.caseId);
  const U = useUnits();
  const required = project.analysis.requiredRf;
  if (!analysis.ok || analysis.cases.length === 0) {
    return <div className="flex h-full items-center justify-center text-ink-3">{analysis.message ?? "Add a load case to chart reserve factor along the part."}</div>;
  }
  const z = analysis.stations.map((s) => U.to("length", s.z));
  const series: Series[] = analysis.cases.map((c, i) => ({
    name: c.name,
    color: SERIES[i % SERIES.length],
    dash: i % 2 === 1,
    values: analysis.stations.map((s) => s.cases[i].rf),
  }));
  const lowest = analysis.minRf ?? required;
  const top = Math.max(required * 2, Math.min(lowest * 2.2, 60));
  const ci = activeCase(analysis, caseId);
  const marked = stationIndex ?? analysis.cases[ci].station;

  return (
    <div className="flex h-full gap-4">
      <div className="min-w-0 flex-1">
        <Chart
          title="Reserve factor along the part"
          subtitle="click to inspect a station"
          x={z}
          series={series}
          xUnit={U.label("length")}
          xDigits={U.unit("length").extra}
          yUnit=""
          yDigits={2}
          yMin={0}
          yMax={top}
          refLine={{ y: required, label: `required ${required}` }}
          cursor={z[marked]}
          onPick={(x) => {
            let best = 0;
            for (let i = 1; i < z.length; i++) if (Math.abs(z[i] - x) < Math.abs(z[best] - x)) best = i;
            set({ stationIndex: best });
          }}
        />
      </div>
      <ReserveLegend required={required} />
    </div>
  );
}

/** Key for the shading on the 3D part. */
function ReserveLegend({ required }: { required: number }) {
  return (
    <div className="flex w-[150px] shrink-0 flex-col justify-center" aria-label="Colour key for the 3D part">
      <div className="label mb-1.5">Shading on the part</div>
      <div className="h-2.5 rounded-full" style={{ background: `linear-gradient(90deg, ${RESERVE.low}, ${RESERVE.mid} 33.3%, ${RESERVE.high})` }} />
      <div className="relative mt-1 h-4 text-[10.5px] text-ink-2">
        <span className="num absolute left-0">{fmt(required / 2, 2)}</span>
        <span className="num absolute left-1/3 -translate-x-1/2">{fmt(required, 2)}</span>
        <span className="num absolute right-0">{fmt(required * 2, 2)}+</span>
      </div>
      <div className="mt-1.5 text-[10.5px] leading-snug text-ink-3">Red is below the requirement, grey meets it, blue has margin. Ends outside the part are left dark.</div>
    </div>
  );
}
