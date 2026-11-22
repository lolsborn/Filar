import { useEffect } from "react";
import { Gauge, Layers, Maximize, Sparkles, Wrench } from "lucide-react";
import { Viewport } from "./components/Viewport";
import { TopBar } from "./components/TopBar";
import { PartPanel } from "./components/PartPanel";
import { MachinePanel } from "./components/MachinePanel";
import { DesignCharts, LayerDetails, Summary, Warnings } from "./components/Inspector";
import { SimPanel, Timeline } from "./components/SimPanel";
import { GcodePanel } from "./components/GcodePanel";
import { AnalysePanel } from "./components/AnalysePanel";
import { AnalyseResults, ReserveChart, StationDetail } from "./components/AnalyseResults";
import { ComparePanel } from "./components/ComparePanel";
import { Seg } from "./components/ui";
import { useApp } from "./lib/store";
import { useLibrary } from "./lib/library";
import { useClock } from "./lib/sim";
import { exportGcode, openProject, saveProject, useToast } from "./lib/actions";

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
      const mod = e.metaKey || e.ctrlKey;
      const app = useApp.getState();
      if (mod && e.key.toLowerCase() === "z") {
        if (typing && el.tagName === "TEXTAREA") return;
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur();
        if (e.shiftKey) app.redo();
        else app.undo();
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveProject();
      } else if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openProject();
      } else if (mod && e.key.toLowerCase() === "e") {
        e.preventDefault();
        void exportGcode();
      } else if (!typing && !mod) {
        if (e.key === "1") app.setMode("design");
        else if (e.key === "2") app.setMode("analyse");
        else if (e.key === "3") app.setMode("simulate");
        else if (e.key === "4") app.setMode("gcode");
        else if (e.key === "Escape" && app.compareOpen) app.setCompare(false);
        else if (e.key === "Escape" && app.stationIndex != null) app.set({ stationIndex: null });
        else if (e.key.toLowerCase() === "f") window.dispatchEvent(new Event("filar:fit"));
        else if (e.key === " " && (app.mode === "simulate" || app.mode === "gcode")) {
          e.preventDefault();
          const c = useClock.getState();
          if (!c.playing && app.plan && c.time >= app.plan.totals.duration - 1e-6) c.setTime(0);
          c.toggle();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function ViewTools() {
  const colorMode = useApp((s) => s.colorMode);
  const showMachine = useApp((s) => s.showMachine);
  const mode = useApp((s) => s.mode);
  const analyseView = useApp((s) => s.analyseView);
  const set = useApp((s) => s.set);
  const live = mode === "simulate" || mode === "gcode";
  return (
    <div className="glass flex items-center gap-1 rounded-xl p-1">
      {mode === "analyse" && (
        <Seg
          aria-label="Shading"
          value={analyseView}
          options={[
            { value: "reserve", label: <Gauge size={14} />, title: "Shade by reserve factor" },
            { value: "fibre", label: <Sparkles size={14} />, title: "Show the fibre" },
          ]}
          onChange={(v) => set({ analyseView: v })}
        />
      )}
      {!(mode === "analyse" && analyseView === "reserve") && (
        <Seg
          aria-label="Fibre colouring"
          value={colorMode}
          options={[
            { value: "fibre", label: <Sparkles size={14} />, title: "Show the real fibre" },
            { value: "layers", label: <Layers size={14} />, title: "Colour by layer" },
          ]}
          onChange={(v) => set({ colorMode: v })}
        />
      )}
      {live && (
        <button className="icon-btn" data-on={showMachine} aria-pressed={showMachine} title="Show the machine" onClick={() => set({ showMachine: !showMachine })}>
          <Wrench size={14} />
        </button>
      )}
      <button className="icon-btn" title="Frame the part (F)" onClick={() => window.dispatchEvent(new Event("filar:fit"))}>
        <Maximize size={14} />
      </button>
    </div>
  );
}

function ToastView() {
  const message = useToast((s) => s.message);
  const tone = useToast((s) => s.tone);
  if (!message) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-[76px] z-50 flex justify-center" role="status">
      <div className={`glass rise rounded-full px-4 py-2 text-[12px] font-medium ${tone === "error" ? "text-serious" : "text-ink"}`}>{message}</div>
    </div>
  );
}

export default function App() {
  const ready = useApp((s) => s.ready);
  const fatal = useApp((s) => s.fatal);
  const plan = useApp((s) => s.plan);
  const project = useApp((s) => s.project);
  const mode = useApp((s) => s.mode);
  const leftTab = useApp((s) => s.leftTab);
  const analysis = useApp((s) => s.analysis);
  const stationIndex = useApp((s) => s.stationIndex);
  const compareOpen = useApp((s) => s.compareOpen);
  const set = useApp((s) => s.set);
  useShortcuts();

  useEffect(() => {
    void useApp.getState().init();
    void useLibrary.getState().load();
  }, []);

  // Editing the design invalidates where the simulation had got to.
  useEffect(() => {
    if (!plan) return;
    const c = useClock.getState();
    if (c.time > plan.totals.duration) c.setTime(plan.totals.duration);
  }, [plan]);
  useEffect(() => {
    if (mode === "design" || mode === "analyse") useClock.getState().set({ playing: false });
  }, [mode]);

  if (fatal) {
    return (
      <div className="flex h-full items-center justify-center p-10">
        <div className="glass max-w-lg rounded-2xl p-6">
          <div className="mb-2 text-[15px] font-semibold">Filar could not start</div>
          <pre className="selectable text-[12px] whitespace-pre-wrap text-ink-2">{fatal}</pre>
        </div>
      </div>
    );
  }

  const station = mode === "analyse" && analysis?.ok && stationIndex != null && stationIndex < analysis.stations.length ? stationIndex : null;
  const rightWidth = mode === "gcode" ? 440 : station != null ? 470 : 340;
  const dockHeight = mode === "design" || mode === "analyse" ? 208 : 76;
  const comparing = mode === "analyse" && compareOpen;

  return (
    <div className="relative h-full w-full overflow-hidden">
      <Viewport />
      {!ready && <div className="absolute inset-0 flex items-center justify-center text-ink-3">Loading…</div>}
      <TopBar />
      <ToastView />

      {ready && plan && project && (
        <>
          <aside className="glass absolute top-[72px] bottom-3 left-3 z-20 flex w-[336px] flex-col overflow-hidden rounded-2xl">
            {mode === "analyse" ? (
              <>
                <div className="hairline flex h-[47px] items-center border-b px-4 text-[13px] font-semibold text-ink">Loads and material</div>
                <div className="scroll min-h-0 flex-1">
                  <AnalysePanel />
                </div>
              </>
            ) : (
              <>
                <div className="hairline border-b p-2">
                  <Seg
                    fill
                    aria-label="Left panel"
                    value={leftTab}
                    options={[
                      { value: "part", label: "Part" },
                      { value: "machine", label: "Machine" },
                    ]}
                    onChange={(v) => set({ leftTab: v })}
                  />
                </div>
                <div className="scroll min-h-0 flex-1">{leftTab === "part" ? <PartPanel /> : <MachinePanel />}</div>
              </>
            )}
          </aside>

          <aside
            className="glass absolute top-[72px] right-3 bottom-3 z-20 flex flex-col overflow-hidden rounded-2xl transition-[width] duration-200"
            style={{ width: rightWidth, visibility: comparing ? "hidden" : undefined }}
          >
            {mode === "gcode" ? (
              <GcodePanel />
            ) : mode === "analyse" && analysis ? (
              station != null ? (
                <StationDetail analysis={analysis} project={project} index={station} />
              ) : (
                <div className="scroll min-h-0 flex-1">
                  <AnalyseResults analysis={analysis} project={project} />
                </div>
              )
            ) : (
              <div className="scroll min-h-0 flex-1">
                {mode === "design" ? (
                  <>
                    <Warnings plan={plan} project={project} />
                    <Summary plan={plan} />
                    <LayerDetails plan={plan} project={project} />
                  </>
                ) : (
                  <SimPanel plan={plan} project={project} />
                )}
              </div>
            )}
          </aside>

          <div className="absolute z-10 transition-[right] duration-200" style={{ left: 360, right: rightWidth + 24, bottom: dockHeight + 24, visibility: comparing ? "hidden" : undefined }}>
            <ViewTools />
          </div>

          <div
            className="glass absolute bottom-3 z-20 rounded-2xl transition-[right,height] duration-200"
            style={{ left: 360, right: rightWidth + 24, height: dockHeight, visibility: comparing ? "hidden" : undefined }}
          >
            {mode === "design" ? (
              <div className="h-full px-4 pt-3 pb-2">
                <DesignCharts plan={plan} project={project} />
              </div>
            ) : mode === "analyse" ? (
              <div className="h-full px-4 pt-3 pb-2">{analysis && <ReserveChart analysis={analysis} project={project} />}</div>
            ) : plan.blocks.length > 0 ? (
              <Timeline plan={plan} project={project} />
            ) : (
              <div className="flex h-full items-center justify-center text-ink-3">Nothing to simulate yet.</div>
            )}
          </div>
          {comparing && analysis && (
            <div className="glass rise absolute top-[72px] right-3 bottom-3 z-30 overflow-hidden rounded-2xl" style={{ left: 360, background: "rgb(13 15 18 / 0.96)" }}>
              <ComparePanel project={project} analysis={analysis} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
