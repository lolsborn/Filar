import { Camera, ChevronLeft, Trash2 } from "lucide-react";
import { newId, useApp } from "../lib/store";
import { duration, fmt } from "../lib/format";
import { SERIES } from "../lib/theme";
import type { Analysis, Layer, Project } from "../lib/types";
import { useToast } from "../lib/actions";
import { rfText } from "./AnalyseResults";
import { useUnits } from "../lib/units";

const MAX_VARIANTS = 3;

/** Compact layup notation, mandrel outwards: "90 / ±45 / 90". */
export function layupText(layers: Layer[]): string {
  const parts = layers
    .filter((l) => l.enabled)
    .map((l) => (l.kind === "helical" ? `±${Number(l.angleDeg.toFixed(1))}` : l.plies > 1 ? `90×${l.plies}` : "90"));
  return parts.join(" / ") || "empty";
}

interface Column {
  key: string;
  title: string;
  variantId: string | null;
  layers: Layer[];
  result: Analysis | null;
}

type Better = "high" | "low" | null;

export function ComparePanel({ project, analysis }: { project: Project; analysis: Analysis }) {
  const edit = useApp((s) => s.edit);
  const setCompare = useApp((s) => s.setCompare);
  const results = useApp((s) => s.variantResults);
  const toast = useToast((s) => s.show);
  const required = project.analysis.requiredRf;
  const U = useUnits();
  const cases = project.analysis.loadCases;

  const columns: Column[] = [
    { key: "now", title: "Current design", variantId: null, layers: project.layers, result: analysis },
    ...project.variants.map((v) => ({ key: v.id, title: v.name, variantId: v.id, layers: v.layers, result: results[v.id] ?? null })),
  ];

  const snapshot = () => {
    const taken = project.variants.map((v) => v.name);
    let n = project.variants.length + 1;
    while (taken.includes(`Variant ${n}`)) n++;
    // Its results arrive with the plan refresh this edit triggers.
    edit((p) => void p.variants.push({ id: newId("v", p.variants), name: `Variant ${n}`, layers: structuredClone(p.layers) }));
  };

  const rows: { label: string; better: Better; value: (c: Column) => number | null; text: (v: number) => string; requireAbove?: number }[] = [
    { label: "Wall thickness", better: null, value: (c) => c.result?.wallThickness ?? null, text: (v) => U.fmt("length", v, 2) },
    { label: "Part mass", better: "low", value: (c) => c.result?.partMassG ?? null, text: (v) => U.fmt("mass", v, 0) },
    { label: "Wind time", better: "low", value: (c) => c.result?.duration ?? null, text: (v) => duration(v) },
  ];
  const strength: typeof rows = cases.map((lc, i) => ({
    label: lc.name || "Load case",
    better: "high" as const,
    value: (c: Column) => (c.result?.ok ? (c.result.cases[i]?.minRf ?? null) : null),
    text: rfText,
    requireAbove: required,
  }));
  const stiffness: typeof rows = [
    { label: "Bending stiffness EI", better: "high", value: (c) => (c.result?.ok ? c.result.stiffness.ei : null), text: (v) => U.fmt("bendStiffness", v, 0) },
    { label: "Torsional stiffness GJ", better: "high", value: (c) => (c.result?.ok ? c.result.stiffness.gj : null), text: (v) => U.fmt("bendStiffness", v, 0) },
    { label: "Axial modulus", better: "high", value: (c) => (c.result?.ok ? c.result.stiffness.ex : null), text: (v) => U.fmt("modulus", v, 1) },
    {
      label: "Lowest reserve factor per 100 g",
      better: "high",
      value: (c) => (c.result?.ok && c.result.minRf != null && c.result.partMassG > 0 ? (c.result.minRf / c.result.partMassG) * 100 : null),
      text: (v) => fmt(v, 2),
    },
  ];

  const renderRow = (row: (typeof rows)[number]) => {
    const values = columns.map(row.value);
    const present = values.filter((v): v is number => v != null);
    const best = row.better && present.length > 1 ? (row.better === "high" ? Math.max(...present) : Math.min(...present)) : null;
    // Values within half a percent of each other are a tie, not a winner.
    const spread = present.length ? Math.max(...present) - Math.min(...present) : 0;
    const distinct = spread > 0.005 * Math.max(...present.map(Math.abs), 1e-9);
    return (
      <tr key={row.label} className="border-t border-white/[0.07]">
        <td className="py-[7px] pr-3 text-left text-ink-2">{row.label}</td>
        {values.map((v, i) => {
          const isBest = best != null && distinct && v != null && Math.abs(v - best) < 1e-9;
          return (
            <td key={columns[i].key} className={`num py-[7px] pl-3 text-right ${isBest ? "font-semibold text-ink" : "text-ink-2"}`}>
              {v == null ? "…" : row.text(v)}
              {isBest && <span className="ml-1 text-[9px] text-accent" title="Best in this row">▲</span>}
              {row.requireAbove != null && v != null && v < row.requireAbove && (
                <span className="ml-1.5 rounded-full border border-critical/60 px-1.5 py-px font-sans text-[10px] font-medium text-ink">below {row.requireAbove}</span>
              )}
            </td>
          );
        })}
      </tr>
    );
  };
  const group = (title: string) => (
    <tr key={title}>
      <td colSpan={columns.length + 1} className="eyebrow border-t border-white/[0.07] pt-4 pb-1.5 text-left">
        {title}
      </td>
    </tr>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="hairline flex items-center gap-3 border-b px-3 py-2.5">
        <button className="btn !px-2" onClick={() => setCompare(false)}>
          <ChevronLeft size={14} /> Results
        </button>
        <span className="text-[13px] font-semibold text-ink">Compare layups</span>
        <span className="flex-1" />
        <span className="text-[11px] text-ink-3">
          <span className="text-accent">▲</span> marks the best in each row
        </span>
        <button
          className="btn"
          disabled={project.variants.length >= MAX_VARIANTS}
          title={project.variants.length >= MAX_VARIANTS ? "Remove a variant to add another" : "Keep the current layup as a variant, then carry on editing in Design"}
          onClick={snapshot}
        >
          <Camera size={14} /> Snapshot current
        </button>
      </div>

      <div className="scroll min-h-0 flex-1 px-5 py-3">
        {project.variants.length === 0 && (
          <div className="mb-4 rounded-[10px] border border-dashed border-white/15 px-3.5 py-3 text-ink-2">
            Take a snapshot of the current layup, then change it in Design. Each snapshot stays here as a column so you can see what the change bought you.
          </div>
        )}
        <table className="w-full text-[12.5px]">
          <thead>
            <tr>
              <th className="w-[24%]" />
              {columns.map((c) => (
                <th key={c.key} className="pb-2 pl-3 text-right align-bottom font-normal">
                  <div className="flex items-center justify-end gap-1">
                    {c.variantId ? (
                      <>
                        <input
                          className="w-full min-w-0 rounded-md bg-transparent px-1.5 py-0.5 text-right font-semibold text-ink outline-none hover:bg-white/[0.06] focus:bg-white/[0.08]"
                          aria-label="Variant name"
                          value={c.title}
                          maxLength={30}
                          onChange={(e) => edit((p) => void (p.variants.find((v) => v.id === c.variantId)!.name = e.target.value), `vname:${c.variantId}`)}
                        />
                        <button className="icon-btn !h-6 !w-6 shrink-0 hover:!text-critical" title="Remove this variant" onClick={() => edit((p) => void (p.variants = p.variants.filter((v) => v.id !== c.variantId)))}>
                          <Trash2 size={13} />
                        </button>
                      </>
                    ) : (
                      <span className="flex items-center gap-2 px-1.5 font-semibold text-ink">
                        <span className="rounded-full bg-accent px-1.5 py-px text-[10px] font-semibold text-accent-ink">Now</span>
                        {c.title}
                      </span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-white/[0.12]">
              <td className="py-[7px] pr-3 text-left text-ink-2">Layup, mandrel outwards</td>
              {columns.map((c) => (
                <td key={c.key} className="num py-[7px] pl-3 text-right text-ink">
                  {layupText(c.layers)}
                </td>
              ))}
            </tr>
            {rows.map(renderRow)}
            {strength.length > 0 && group("Lowest reserve factor")}
            {strength.map(renderRow)}
            {group("Stiffness and efficiency")}
            {stiffness.map(renderRow)}
            <tr className="border-t border-white/[0.12]">
              <td />
              {columns.map((c) => (
                <td key={c.key} className="pt-3 pl-3 text-right">
                  {c.variantId && (
                    <button
                      className="btn"
                      title="Replace the current layup with this one. Undo brings the old one back."
                      onClick={() => {
                        edit((p) => {
                          const v = p.variants.find((x) => x.id === c.variantId);
                          if (v) p.layers = structuredClone(v.layers);
                        });
                        toast(`${c.title} is now the design. Undo to go back.`);
                      }}
                    >
                      Make this the design
                    </button>
                  )}
                </td>
              ))}
            </tr>
          </tbody>
        </table>

        {cases.length > 0 && columns.length > 1 && (
          <>
            <div className="eyebrow mt-6 mb-2">Lowest reserve factor by load case</div>
            <div className="grid gap-x-8 gap-y-5" style={{ gridTemplateColumns: `repeat(${Math.min(cases.length, 2)}, minmax(0, 1fr))` }}>
              {cases.map((lc, i) => {
                const values = columns.map((c) => (c.result?.ok ? (c.result.cases[i]?.minRf ?? null) : null));
                const top = Math.max(required * 1.6, ...values.map((v) => Math.min(v ?? 0, 99))) * 1.12;
                const best = Math.max(...values.map((v) => v ?? -1));
                return (
                  <div key={lc.id}>
                    <div className="mb-1.5 text-[12px] font-semibold text-ink">{lc.name}</div>
                    <div className="relative">
                      <div className="flex flex-col gap-[5px]">
                        {columns.map((c, k) => {
                          const v = values[k];
                          const w = v == null ? 0 : (Math.min(v, top) / top) * 100;
                          const isBest = v != null && v === best && values.some((o) => o != null && best - o > 0.005 * best);
                          return (
                            <div key={c.key} className="flex h-[18px] items-center gap-2.5">
                              <span className="w-[112px] shrink-0 truncate text-right text-[11.5px] text-ink-2">{c.title}</span>
                              <div className="relative h-full flex-1">
                                <div className="absolute top-[3px] left-0 h-3 rounded-r-[4px]" style={{ width: `${w}%`, background: SERIES[0], opacity: isBest ? 1 : 0.55 }} />
                                <span className={`num absolute top-0 pl-1.5 text-[11.5px] ${isBest ? "font-semibold text-ink" : "text-ink-2"}`} style={{ left: `${w}%` }}>
                                  {rfText(v)}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="pointer-events-none absolute top-[-3px] bottom-[-3px]" style={{ left: 122, right: 0 }}>
                        <div className="absolute top-0 bottom-0 w-px bg-ink/80" style={{ left: `${(required / top) * 100}%` }} />
                      </div>
                    </div>
                    <div className="relative mt-1 h-4" style={{ marginLeft: 122 }}>
                      <span className="num absolute -translate-x-1/2 text-[10.5px] text-ink-2" style={{ left: `${(required / top) * 100}%` }}>
                        required {required}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
        <p className="mt-5 text-[11px] text-ink-3">Variants share this project's mandrel, band, ply properties and load cases, and are saved with the project.</p>
      </div>
    </div>
  );
}
