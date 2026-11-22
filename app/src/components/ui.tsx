import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { trim } from "../lib/format";
import { niceStep, useUnits, type Quantity } from "../lib/units";

interface NumProps {
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  digits?: number;
  integer?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
}

/**
 * Numeric field. Give it a quantity (`q`) and `value`, `min`, `max` and
 * `step` stay in base units while the field shows and reads the user's
 * chosen unit.
 */
export function Num(props: NumProps & { q?: Quantity }) {
  const U = useUnits();
  const { q, ...rest } = props;
  if (!q) return <NumField {...rest} />;
  const u = U.unit(q);
  // Finer units get more decimals, but never more than is meaningful to type.
  const digits = u.extra > 0 ? Math.min((rest.digits ?? 3) + u.extra, 4) : (rest.digits ?? 3);
  const round = (v: number) => Number(v.toFixed(digits + 2));
  return (
    <NumField
      {...rest}
      unit={u.label}
      digits={digits}
      value={round(rest.value * u.k)}
      min={rest.min == null ? undefined : rest.min * u.k}
      max={rest.max == null ? undefined : rest.max * u.k}
      step={u.k === 1 ? rest.step : niceStep((rest.step ?? 1) * u.k)}
      onChange={(v) => rest.onChange(v / u.k)}
    />
  );
}

/** Numeric field: commits valid values as you type, steps with the arrow keys. */
function NumField(props: NumProps) {
  const { value, onChange, unit, min = -Infinity, max = Infinity, step = 1, digits = 3, integer, disabled } = props;
  const [text, setText] = useState(() => trim(value, digits));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(trim(value, digits));
  }, [value, digits, focused]);

  const parsed = Number(text.replace(",", "."));
  const valid = text.trim() !== "" && Number.isFinite(parsed) && parsed >= min && parsed <= max && (!integer || Number.isInteger(parsed));

  const commit = (v: number) => {
    const c = Math.min(max, Math.max(min, integer ? Math.round(v) : v));
    setText(trim(c, digits));
    if (c !== value) onChange(c);
  };

  return (
    <div className="field" data-invalid={focused && !valid} style={disabled ? { opacity: 0.45, pointerEvents: "none" } : undefined}>
      <input
        className="num"
        inputMode="decimal"
        spellCheck={false}
        aria-label={props["aria-label"]}
        value={text}
        disabled={disabled}
        onFocus={(e) => {
          setFocused(true);
          e.currentTarget.select();
        }}
        onBlur={() => {
          setFocused(false);
          setText(trim(value, digits));
        }}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          const v = Number(t.replace(",", "."));
          if (t.trim() !== "" && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v)) && v !== value) onChange(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const dir = e.key === "ArrowUp" ? 1 : -1;
            const base = valid ? parsed : value;
            commit(Number((base + dir * step * (e.shiftKey ? 10 : 1)).toFixed(6)));
          } else if (e.key === "Enter") {
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setText(trim(value, digits));
            e.currentTarget.blur();
          }
        }}
      />
      {unit && <span className="unit">{unit}</span>}
    </div>
  );
}

export function Text(props: { value: string; onChange: (v: string) => void; mono?: boolean; maxLength?: number; "aria-label"?: string }) {
  return (
    <div className="field">
      <input
        className={props.mono ? "num" : undefined}
        spellCheck={false}
        maxLength={props.maxLength}
        aria-label={props["aria-label"]}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  );
}

export function Select<T extends string>(props: {
  value: T;
  /** Options sharing a `group` are listed together under that heading. */
  options: { value: T; label: string; group?: string }[];
  onChange: (v: T) => void;
  "aria-label"?: string;
}) {
  const groups: { name: string | undefined; items: typeof props.options }[] = [];
  for (const o of props.options) {
    const g = groups.find((x) => x.name === o.group);
    if (g) g.items.push(o);
    else groups.push({ name: o.group, items: [o] });
  }
  const render = (o: (typeof props.options)[number]) => (
    <option key={o.value} value={o.value}>
      {o.label}
    </option>
  );
  return (
    <div className="field relative">
      <select value={props.value} aria-label={props["aria-label"]} onChange={(e) => props.onChange(e.target.value as T)}>
        {groups.map((g) =>
          g.name ? (
            <optgroup key={g.name} label={g.name}>
              {g.items.map(render)}
            </optgroup>
          ) : (
            g.items.map(render)
          ),
        )}
      </select>
      <ChevronDown size={13} className="pointer-events-none absolute right-2 text-ink-3" />
    </div>
  );
}

export function Seg<T extends string>(props: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  fill?: boolean;
  accent?: boolean;
  "aria-label"?: string;
}) {
  return (
    <div className={`seg ${props.fill ? "seg-fill" : ""} ${props.accent ? "seg-accent" : ""}`} role="radiogroup" aria-label={props["aria-label"]}>
      {props.options.map((o) => (
        <button key={o.value} role="radio" aria-checked={props.value === o.value} data-on={props.value === o.value} title={o.title} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle(props: { value: boolean; onChange: (v: boolean) => void; "aria-label"?: string }) {
  return (
    <button
      role="switch"
      aria-checked={props.value}
      aria-label={props["aria-label"]}
      onClick={() => props.onChange(!props.value)}
      className={`relative h-[18px] w-[30px] shrink-0 cursor-pointer rounded-full transition-colors ${props.value ? "bg-accent" : "bg-white/15"}`}
    >
      <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full shadow transition-all ${props.value ? "left-[14px] bg-accent-ink" : "left-[2px] bg-white/80"}`} />
    </button>
  );
}

/** A label over a control, laid out on a two-column grid by the parent. */
export function Field(props: { label: string; hint?: string; children: ReactNode; span?: boolean }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 ${props.span ? "col-span-2" : ""}`} title={props.hint}>
      <span className="label truncate">{props.label}</span>
      {props.children}
    </label>
  );
}

export function Section(props: { title: string; right?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  return (
    <section className="hairline border-b last:border-b-0">
      <div className="flex h-10 items-center gap-2 px-4">
        <button className="eyebrow flex flex-1 cursor-pointer items-center gap-1.5 text-left hover:text-ink-2" onClick={() => setOpen(!open)} aria-expanded={open}>
          <ChevronDown size={12} className={`transition-transform ${open ? "" : "-rotate-90"}`} />
          {props.title}
        </button>
        {props.right}
      </div>
      {open && <div className="px-4 pb-4">{props.children}</div>}
    </section>
  );
}

/** Headline figure. The value stays in text ink; nothing here wears a data colour. */
export function Stat(props: { label: string; value: string; unit?: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="label truncate">{props.label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="text-[19px] font-semibold tracking-tight text-ink">{props.value}</span>
        {props.unit && <span className="text-[11px] text-ink-3">{props.unit}</span>}
      </div>
      {props.sub && <div className="truncate text-[11px] text-ink-3">{props.sub}</div>}
    </div>
  );
}

export function KV(props: { k: string; v: ReactNode; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]" title={props.title}>
      <span className="text-ink-3">{props.k}</span>
      <span className="num text-[12px] text-ink">{props.v}</span>
    </div>
  );
}

/** Size of an element, tracked from whenever it mounts (callback ref). */
export function useSize<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const ref = useRef<T | null>(null);
  const attach = useCallback((node: T | null) => {
    ref.current = node;
    setEl(node);
  }, []);
  useLayoutEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [attach, size, ref] as const;
}
