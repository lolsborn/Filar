import { useId, useMemo, useState } from "react";
import { useSize } from "./ui";

export interface Series {
  name: string;
  color: string;
  /** y value per x; null where the series does not exist. */
  values: (number | null)[];
  /** Lower edge for a stacked band (same length); the area is filled between. */
  base?: number[];
  /** Value to show in the tooltip instead of `values` (e.g. un-stacked). */
  display?: (number | null)[];
  /** Draw dashed: a second way to tell lines apart besides colour. */
  dash?: boolean;
}

interface Props {
  title: string;
  subtitle?: string;
  x: number[];
  series: Series[];
  xUnit: string;
  yUnit: string;
  yDigits?: number;
  xDigits?: number;
  yMin?: number;
  yMax?: number;
  /** Shaded x-range with a label (e.g. the part zone). */
  band?: { from: number; to: number; label: string };
  /** A marked x position (e.g. the simulation playhead). */
  cursor?: number;
  /** A horizontal reference level with a label (e.g. a requirement). */
  refLine?: { y: number; label: string };
  /** Extra tooltip line (e.g. a total). */
  total?: { label: string; values: number[] };
  compact?: boolean;
  /** Called with the x value when the plot is clicked. */
  onPick?: (x: number) => void;
}

function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-6; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

const INK = "#f0efec";
const INK_3 = "#7f838b";
const GRID = "#23262c";
const AXIS = "#3a3d44";
const SURFACE = "#111317";

export function Chart(props: Props) {
  const { x, series, compact } = props;
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const clipId = useId();

  const m = compact ? { l: 38, r: 10, t: 6, b: 6 } : { l: 40, r: 12, t: 8, b: 22 };
  const w = Math.max(size.width - m.l - m.r, 10);
  const h = Math.max(size.height - m.t - m.b, 10);

  const { yLo, yHi, ticks } = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series)
      for (const v of s.values)
        if (v != null) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 1;
    }
    lo = props.yMin ?? Math.min(lo, 0);
    hi = props.yMax ?? hi;
    if (hi - lo < 1e-9) hi = lo + 1;
    const t = niceTicks(lo, hi, compact ? 2 : 4);
    if (props.yMax == null) hi = Math.max(hi, t[t.length - 1]);
    if (props.yMin == null && lo < 0) lo = Math.min(lo, t[0]);
    return { yLo: lo, yHi: hi, ticks: t };
  }, [series, props.yMin, props.yMax, compact]);

  const x0 = x[0] ?? 0;
  const x1 = x[x.length - 1] ?? 1;
  const sx = (v: number) => m.l + ((v - x0) / (x1 - x0 || 1)) * w;
  const sy = (v: number) => m.t + h - ((v - yLo) / (yHi - yLo)) * h;
  const xTicks = useMemo(() => niceTicks(x0, x1, Math.max(2, Math.floor(w / 80))), [x0, x1, w]);

  const paths = useMemo(
    () =>
      series.map((s) => {
        let line = "";
        let area = "";
        let run: number[] = [];
        const flush = () => {
          if (run.length > 1 && s.base) {
            area += `M${run.map((i) => `${sx(x[i]).toFixed(1)},${sy(s.values[i]!).toFixed(1)}`).join("L")}`;
            area += `L${[...run].reverse().map((i) => `${sx(x[i]).toFixed(1)},${sy(s.base![i]).toFixed(1)}`).join("L")}Z`;
          }
          run = [];
        };
        for (let i = 0; i < x.length; i++) {
          const v = s.values[i];
          if (v == null) {
            flush();
            continue;
          }
          line += `${run.length ? "L" : "M"}${sx(x[i]).toFixed(1)},${sy(v).toFixed(1)}`;
          run.push(i);
        }
        flush();
        return { line, area };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, x, w, h, yLo, yHi],
  );

  const nearest = (px: number) => {
    const v = x0 + ((px - m.l) / w) * (x1 - x0);
    let best = 0;
    let lo = 0;
    let hi = x.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (Math.abs(x[mid] - v) < Math.abs(x[best] - v)) best = mid;
      if (x[mid] < v) lo = mid + 1;
      else hi = mid - 1;
    }
    return best;
  };

  const yd = props.yDigits ?? 2;
  const xd = props.xDigits ?? 0;
  const hx = hover != null ? sx(x[hover]) : 0;
  const tipLeft = hover != null && hx > m.l + w * 0.55;
  const cursorX = props.cursor != null ? sx(Math.min(Math.max(props.cursor, x0), x1)) : null;

  return (
    <div className="flex h-full min-w-0 flex-col">
      {!compact && (
        <div className="flex items-baseline justify-between gap-3 px-1 pb-1">
          <div className="min-w-0">
            <span className="text-[12px] font-semibold text-ink">{props.title}</span>
            {props.subtitle && <span className="ml-2 text-[11px] text-ink-3">{props.subtitle}</span>}
          </div>
          {series.length >= 2 && (
            <div className="flex min-w-0 flex-wrap justify-end gap-x-3 gap-y-0.5">
              {series.map((s, i) => (
                <span key={i} className="flex items-center gap-1.5 text-[11px] text-ink-2">
                  <span
                    className="h-[3px] w-3 rounded-full"
                    style={{ background: s.dash ? `repeating-linear-gradient(90deg, ${s.color} 0 4px, transparent 4px 6px)` : s.color }}
                  />
                  <span className="max-w-[92px] truncate">{s.name}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <div ref={ref} className="relative min-h-0 flex-1">
        {size.width > 0 && (
          <svg
            width={size.width}
            height={size.height}
            className="block"
            role="img"
            aria-label={props.title}
            style={{ cursor: props.onPick ? "pointer" : "crosshair" }}
            onPointerMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const px = e.clientX - rect.left;
              setHover(px >= m.l - 4 && px <= m.l + w + 4 ? nearest(px) : null);
            }}
            onPointerLeave={() => setHover(null)}
            onClick={() => hover != null && props.onPick?.(x[hover])}
          >
            <defs>
              <clipPath id={clipId}>
                <rect x={m.l} y={m.t - 1} width={w} height={h + 2} />
              </clipPath>
            </defs>
            {props.band && (
              <>
                <rect x={sx(props.band.from)} y={m.t} width={Math.max(sx(props.band.to) - sx(props.band.from), 0)} height={h} fill="#ffffff" opacity={0.035} />
                {!compact && (
                  <text x={(sx(props.band.from) + sx(props.band.to)) / 2} y={m.t + 11} textAnchor="middle" fontSize={10} fill={INK_3}>
                    {props.band.label}
                  </text>
                )}
              </>
            )}
            {ticks.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={m.l + w} y1={sy(t)} y2={sy(t)} stroke={t === yLo ? AXIS : GRID} strokeWidth={1} />
                <text x={m.l - 6} y={sy(t) + 3.5} textAnchor="end" fontSize={10} fill={INK_3} style={{ fontVariantNumeric: "tabular-nums" }}>
                  {Number(t.toFixed(4))}
                </text>
              </g>
            ))}
            {!compact &&
              xTicks.map((t) => (
                <text key={t} x={sx(t)} y={m.t + h + 15} textAnchor="middle" fontSize={10} fill={INK_3} style={{ fontVariantNumeric: "tabular-nums" }}>
                  {Number(t.toFixed(4))}
                </text>
              ))}
            {!compact && (
              <text x={m.l + w} y={m.t + h + 15} textAnchor="end" fontSize={10} fill={INK_3} dx={10}>
                {props.xUnit}
              </text>
            )}
            {paths.map((p, i) => p.area && <path key={`a${i}`} d={p.area} fill={series[i].color} opacity={0.16} />)}
            {paths.map((p, i) => (
              <path
                key={`l${i}`}
                d={p.line}
                fill="none"
                stroke={series[i].color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={series[i].dash ? "6 4" : undefined}
                clipPath={`url(#${clipId})`}
              />
            ))}
            {props.refLine && props.refLine.y >= yLo && props.refLine.y <= yHi && (
              <>
                <line x1={m.l} x2={m.l + w} y1={sy(props.refLine.y)} y2={sy(props.refLine.y)} stroke={INK} strokeWidth={1} opacity={0.7} />
                <text x={m.l + 4} y={sy(props.refLine.y) + 12} fontSize={10} fill={INK}>
                  {props.refLine.label}
                </text>
              </>
            )}
            {cursorX != null && <line x1={cursorX} x2={cursorX} y1={m.t} y2={m.t + h} stroke={INK} strokeWidth={1} opacity={0.55} />}
            {hover != null && (
              <>
                <line x1={hx} x2={hx} y1={m.t} y2={m.t + h} stroke={INK_3} strokeWidth={1} />
                {series.map((s, i) => {
                  const v = s.values[hover];
                  return v == null || v > yHi ? null : <circle key={i} cx={hx} cy={sy(v)} r={4} fill={s.color} stroke={SURFACE} strokeWidth={2} />;
                })}
              </>
            )}
          </svg>
        )}
        {hover != null && (
          <div
            className="glass pointer-events-none absolute top-1 z-10 rounded-lg px-2.5 py-1.5 text-[11px] whitespace-nowrap"
            style={tipLeft ? { right: size.width - hx + 10 } : { left: hx + 10 }}
          >
            <div className="num mb-0.5 text-ink-3">
              {x[hover].toFixed(xd)} {props.xUnit}
            </div>
            {series.map((s, i) => {
              const v = (s.display ?? s.values)[hover];
              if (v == null) return null;
              return (
                <div key={i} className="flex items-center gap-2">
                  <span className="h-[3px] w-2.5 rounded-full" style={{ background: s.color }} />
                  <span className="text-ink-2">{s.name}</span>
                  <span className="num ml-auto pl-3 text-ink">
                    {v.toFixed(yd)} {props.yUnit}
                  </span>
                </div>
              );
            })}
            {props.total && (
              <div className="hairline mt-1 flex items-center gap-2 border-t pt-1">
                <span className="text-ink-2">{props.total.label}</span>
                <span className="num ml-auto pl-3 font-semibold text-ink">
                  {props.total.values[hover].toFixed(yd)} {props.yUnit}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
