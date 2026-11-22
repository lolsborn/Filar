import { useMemo, useRef } from "react";
import { Pause, Play, SkipBack } from "lucide-react";
import { SPEEDS, stateAt, useClock } from "../lib/sim";
import { clock as fmtClock, deg, fmt } from "../lib/format";
import { layerColor, SERIES } from "../lib/theme";
import { SEG_KIND, type Axis, type Plan, type Project } from "../lib/types";
import { Chart } from "./Chart";
import { Section } from "./ui";
import { useUnits } from "../lib/units";

function Dro({ axis, label, value, unit, digits }: { axis: Axis; label: string; value: number; unit: string; digits: number }) {
  return (
    <div className={`rounded-[10px] bg-white/[0.04] px-3 py-2 ${axis.enabled ? "" : "opacity-35"}`}>
      <div className="flex items-center justify-between">
        <span className="label">{label}</span>
        <span className="num rounded bg-white/10 px-1.5 text-[10px] font-semibold text-ink-2">{axis.enabled ? axis.letter : "–"}</span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="num text-[18px] font-medium tracking-tight text-ink">{axis.enabled ? fmt(value, digits) : "fixed"}</span>
        {axis.enabled && <span className="text-[11px] text-ink-3">{unit}</span>}
      </div>
    </div>
  );
}

export function SimPanel({ plan, project }: { plan: Plan; project: Project }) {
  const time = useClock((s) => s.time);
  const U = useUnits();
  const st = useMemo(() => stateAt(plan, time), [plan, time]);
  if (!st) {
    return (
      <Section title="Simulation">
        <p className="text-ink-3">Nothing to simulate yet. Add a layer in Design.</p>
      </Section>
    );
  }
  const block = plan.blocks[st.block];
  const layer = project.layers[block.layerIndex];
  const m = project.machine;
  const s = block.samples;
  const a0 = plan.blocks[0].samples.a[0];
  const spindleDeg = deg(st.a - a0);
  const out = (axis: Axis, physical: number) => (axis.invert ? -physical : physical) * axis.scale + axis.offset;

  // Fibre laid so far.
  let laid = 0;
  for (let i = 0; i < st.block; i++) laid += plan.blocks[i].fiberLength * plan.blocks[i].repeats;
  laid += block.fiberLength * (st.repeat + st.local / block.duration);

  const len = (v: number) => U.to("length", v);
  const lenDigits = 1 + U.unit("length").extra;
  const strips: { title: string; unit: string; values: number[]; digits: number; show: boolean }[] = [
    { title: "Carriage", unit: U.label("length"), values: s.x.map(len), digits: lenDigits, show: true },
    { title: "Winding angle", unit: "°", values: s.alpha.map(deg), digits: 1, show: true },
    { title: "Eye rotation", unit: "°", values: s.b.map(deg), digits: 1, show: m.eye.enabled },
    { title: "Cross-feed", unit: U.label("length"), values: s.y.map(len), digits: lenDigits, show: m.crossfeed.enabled && s.y.some((v) => Math.abs(v - s.y[0]) > 0.01) },
  ];

  return (
    <>
      <Section title="Now winding">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: layerColor(block.layerIndex) }} />
          <span className="min-w-0 flex-1 truncate font-semibold text-ink">{layer?.name}</span>
          <span className="rounded-md bg-white/[0.07] px-1.5 py-0.5 text-[11px] text-ink-2">{block.kind === "link" ? "Link" : SEG_KIND[st.kind]}</span>
        </div>
        <div className="mt-2.5 grid grid-cols-3 gap-x-3 text-[12px]">
          <div>
            <div className="label">{block.kind === "helical" ? "Circuit" : "Pass"}</div>
            <div className="num text-ink">
              {st.repeat + 1} <span className="text-ink-4">/ {block.repeats}</span>
            </div>
          </div>
          <div>
            <div className="label">Angle</div>
            <div className="num text-ink">{fmt(st.alpha > Math.PI / 2 ? 180 - deg(st.alpha) : deg(st.alpha), 1)}°</div>
          </div>
          <div>
            <div className="label">Fibre laid</div>
            <div className="num text-ink">{U.fmt("run", laid / 1000, 1)}</div>
          </div>
        </div>
      </Section>

      <Section title="Axes">
        <div className="grid grid-cols-2 gap-2">
          <Dro axis={m.carriage} label="Carriage" value={out(m.carriage, st.x)} unit="" digits={2} />
          <Dro axis={m.spindle} label="Spindle" value={out(m.spindle, spindleDeg)} unit={m.spindle.scale === 1 ? "°" : ""} digits={1} />
          <Dro axis={m.crossfeed} label="Cross-feed" value={out(m.crossfeed, st.y)} unit="" digits={2} />
          <Dro axis={m.eye} label="Eye rotation" value={out(m.eye, deg(st.b))} unit="°" digits={2} />
        </div>
        <p className="mt-2 text-[11px] text-ink-3">
          Axis read-outs are in machine units, as they appear in the G-code.
          <br />
          {fmt(spindleDeg / 360, 1)} of {fmt(plan.totals.spindleTurns, 0)} mandrel turns
        </p>
      </Section>

      <Section title={block.kind === "helical" ? "This circuit" : "This pass"}>
        <div className="flex flex-col gap-3">
          {strips
            .filter((x) => x.show)
            .map((x) => (
              <div key={x.title}>
                <div className="label mb-0.5 flex justify-between">
                  <span>
                    {x.title} <span className="text-ink-4">{x.unit}</span>
                  </span>
                </div>
                <div className="h-[58px]">
                  <Chart
                    compact
                    title={`${x.title} over the ${block.kind === "helical" ? "circuit" : "pass"}`}
                    x={s.t}
                    series={[{ name: x.title, color: SERIES[0], values: x.values }]}
                    xUnit="s"
                    xDigits={1}
                    yUnit={x.unit}
                    yDigits={x.digits}
                    yMin={Math.min(...x.values)}
                    yMax={Math.max(...x.values) === Math.min(...x.values) ? Math.min(...x.values) + 1 : Math.max(...x.values)}
                    cursor={st.local}
                    onPick={(t) => useClock.getState().setTime(block.tStart + st.repeat * block.duration + t)}
                  />
                </div>
              </div>
            ))}
        </div>
      </Section>
    </>
  );
}

/** Transport bar: play, speed, and a scrubber segmented by layer. */
export function Timeline({ plan, project }: { plan: Plan; project: Project }) {
  const time = useClock((s) => s.time);
  const playing = useClock((s) => s.playing);
  const speed = useClock((s) => s.speed);
  const total = plan.totals.duration;
  const track = useRef<HTMLDivElement>(null);

  const seek = (clientX: number) => {
    const rect = track.current!.getBoundingClientRect();
    useClock.getState().setTime(Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) * total);
  };
  const toggle = () => {
    const c = useClock.getState();
    if (!c.playing && c.time >= total - 1e-6) c.setTime(0);
    c.toggle();
  };

  // One segment per layer (links are folded into the layer they lead to).
  const segments = useMemo(() => {
    const out: { layerIndex: number; start: number; end: number }[] = [];
    for (const b of plan.blocks) {
      const end = b.tStart + b.duration * b.repeats;
      const last = out[out.length - 1];
      if (last && last.layerIndex === b.layerIndex) last.end = end;
      else out.push({ layerIndex: b.layerIndex, start: b.tStart, end });
    }
    return out;
  }, [plan]);

  const frac = total > 0 ? Math.min(time / total, 1) : 0;
  return (
    <div className="flex h-full items-center gap-4 px-4">
      <div className="flex items-center gap-1">
        <button className="icon-btn" title="Back to start" onClick={() => useClock.getState().setTime(0)}>
          <SkipBack size={15} />
        </button>
        <button
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-accent text-accent-ink shadow-[0_4px_18px_-4px_rgb(200_245_66/0.6)] transition-transform hover:scale-105 active:scale-95"
          title={playing ? "Pause (Space)" : "Play (Space)"}
          aria-label={playing ? "Pause" : "Play"}
          onClick={toggle}
        >
          {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" className="ml-0.5" />}
        </button>
      </div>

      <div className="num w-[104px] shrink-0 text-[12px] text-ink">
        {fmtClock(time)} <span className="text-ink-4">/ {fmtClock(total)}</span>
      </div>

      <div className="min-w-0 flex-1">
        <div
          ref={track}
          className="relative h-7 cursor-pointer touch-none"
          role="slider"
          aria-label="Program time"
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(time)}
          tabIndex={0}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seek(e.clientX);
          }}
          onPointerMove={(e) => e.buttons === 1 && seek(e.clientX)}
          onKeyDown={(e) => {
            const c = useClock.getState();
            if (e.key === "ArrowRight") c.setTime(Math.min(c.time + total / 200, total));
            if (e.key === "ArrowLeft") c.setTime(Math.max(c.time - total / 200, 0));
          }}
        >
          <div className="absolute inset-x-0 top-[9px] flex h-[10px] gap-[2px]">
            {segments.map((sgm, i) => {
              const w = ((sgm.end - sgm.start) / total) * 100;
              const fill = Math.min(Math.max((time - sgm.start) / (sgm.end - sgm.start), 0), 1) * 100;
              const color = layerColor(sgm.layerIndex);
              return (
                <div key={i} className="relative h-full overflow-hidden rounded-[3px]" style={{ width: `${w}%`, background: `${color}40` }} title={project.layers[sgm.layerIndex]?.name}>
                  <div className="h-full" style={{ width: `${fill}%`, background: color }} />
                </div>
              );
            })}
          </div>
          <div className="pointer-events-none absolute top-[3px] h-[22px] w-[2px] -translate-x-1/2 rounded-full bg-white shadow-[0_0_8px_rgb(255_255_255/0.7)]" style={{ left: `${frac * 100}%` }} />
        </div>
        <div className="mt-0.5 flex gap-[2px]">
          {segments.map((sgm, i) => (
            <div key={i} className="truncate text-[10px] text-ink-3" style={{ width: `${((sgm.end - sgm.start) / total) * 100}%` }}>
              {project.layers[sgm.layerIndex]?.name}
            </div>
          ))}
        </div>
      </div>

      <div className="seg shrink-0" role="radiogroup" aria-label="Playback speed">
        {SPEEDS.map((v) => (
          <button key={v} role="radio" aria-checked={speed === v} data-on={speed === v} className="num !px-2 text-[11px]" onClick={() => useClock.getState().set({ speed: v })}>
            {v}×
          </button>
        ))}
      </div>
    </div>
  );
}
