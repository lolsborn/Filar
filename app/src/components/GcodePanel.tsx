import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, LocateFixed } from "lucide-react";
import { hasErrors, useApp } from "../lib/store";
import { lowerIndex, useClock } from "../lib/sim";
import { duration, fmt } from "../lib/format";
import { useSize } from "./ui";

const ROW = 19;

/** One line of G-code with light syntax colouring. */
const Line = memo(function Line({ text }: { text: string }) {
  const cut = text.search(/[;(]/);
  const code = cut === -1 ? text : text.slice(0, cut);
  const comment = cut === -1 ? "" : text.slice(cut);
  return (
    <>
      {code
        .split(/(\s+)/)
        .filter(Boolean)
        .map((w, i) => {
          if (/^\s+$/.test(w)) return w;
          const letter = w[0];
          if (letter === "G" || letter === "M")
            return (
              <span key={i} className="font-semibold text-accent">
                {w}
              </span>
            );
          if (letter === "N" || letter === "F")
            return (
              <span key={i} className="text-ink-4">
                {w}
              </span>
            );
          return (
            <span key={i}>
              <span className="text-ink-3">{letter}</span>
              <span className="text-ink">{w.slice(1)}</span>
            </span>
          );
        })}
      {comment && <span className="text-ink-4 italic">{comment}</span>}
    </>
  );
});

export function GcodePanel() {
  const gcode = useApp((s) => s.gcode);
  const stale = useApp((s) => s.gcodeStale);
  const plan = useApp((s) => s.plan);
  const time = useClock((s) => s.time);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [attach, size, ref] = useSize<HTMLDivElement>();
  const programmatic = useRef(false);

  const lines = useMemo(() => gcode?.text.split("\n").slice(0, gcode.lines) ?? [], [gcode]);
  const current = useMemo(() => {
    if (!gcode || gcode.lineTimes.length === 0) return 0;
    return Math.min(lowerIndex(gcode.lineTimes, time) + 1, gcode.lines - 1);
  }, [gcode, time]);

  // Keep the executing line in view while following.
  useEffect(() => {
    const el = ref.current;
    if (!el || !follow || size.height === 0) return;
    const y = current * ROW;
    if (y < el.scrollTop + ROW * 2 || y > el.scrollTop + size.height - ROW * 4) {
      programmatic.current = true;
      el.scrollTop = Math.max(0, y - size.height * 0.35);
    }
  }, [current, follow, size.height, ref]);

  if (!gcode) {
    return <div className="flex h-full items-center justify-center text-ink-3">Generating G-code…</div>;
  }

  const first = Math.max(0, Math.floor(scrollTop / ROW) - 8);
  const last = Math.min(lines.length, Math.ceil((scrollTop + size.height) / ROW) + 8);
  const digits = String(lines.length).length;
  const bytes = gcode.text.length;
  const blocked = hasErrors(plan);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="hairline flex items-center gap-3 border-b px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[12px] font-semibold text-ink">
            Program
            {stale && <span className="pulse h-1.5 w-1.5 rounded-full bg-accent" title="Updating" />}
          </div>
          <div className="num truncate text-[11px] text-ink-3">
            {fmt(gcode.lines, 0)} lines · {fmt(gcode.moves, 0)} moves · {bytes > 1e6 ? `${fmt(bytes / 1e6, 1)} MB` : `${fmt(bytes / 1e3, 0)} kB`} · {duration(gcode.duration)}
          </div>
        </div>
        <button className="icon-btn" data-on={follow} title="Follow the simulation" aria-pressed={follow} onClick={() => setFollow(!follow)}>
          <LocateFixed size={15} />
        </button>
        <button
          className="icon-btn"
          title="Copy to clipboard"
          onClick={async () => {
            await navigator.clipboard.writeText(gcode.text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
        >
          {copied ? <Check size={15} className="text-accent" /> : <Copy size={14} />}
        </button>
      </div>
      {blocked && (
        <div className="hairline border-b bg-critical/10 px-4 py-2 text-[12px] text-ink-2">This plan has errors. Export is disabled until they are fixed; the program below is for inspection only.</div>
      )}
      <div
        ref={attach}
        className="scroll selectable num min-h-0 flex-1 text-[11.5px]"
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          // A manual scroll stops following; our own scrolls do not.
          if (programmatic.current) programmatic.current = false;
          else if (useClock.getState().playing) setFollow(false);
        }}
      >
        <div style={{ height: lines.length * ROW, position: "relative" }}>
          {lines.slice(first, last).map((text, k) => {
            const i = first + k;
            const on = i === current;
            return (
              <div
                key={i}
                className={`absolute right-0 left-0 flex cursor-pointer items-center whitespace-pre ${on ? "bg-accent/[0.14]" : "hover:bg-white/[0.04]"}`}
                style={{ top: i * ROW, height: ROW }}
                onClick={() => {
                  setFollow(true);
                  useClock.getState().setTime(gcode.lineTimes[Math.max(i - 1, 0)]);
                }}
              >
                <span className={`w-[3px] self-stretch ${on ? "bg-accent" : ""}`} />
                <span className="shrink-0 pr-3 pl-2 text-right text-ink-4 select-none" style={{ width: `${digits + 2.5}ch` }}>
                  {i + 1}
                </span>
                {/* One wrapper: bare text nodes in a flex row would lose their spaces. */}
                <span>
                  <Line text={text} />
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
