// Colours shared between CSS, charts and the 3D scene.

/** Categorical series colours (dark-surface steps), assigned to layers in order. */
export const SERIES = [
  "#3987e5", // blue
  "#d95926", // orange
  "#199e70", // aqua
  "#c98500", // yellow
  "#d55181", // magenta
  "#0ca30c", // green
  "#9085e9", // violet
  "#e66767", // red
];

export const layerColor = (index: number) => SERIES[index % SERIES.length];

export const ACCENT = "#c8f542";

export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
};

/** How the material looks in 3D: its own colour if set, else a guess from the name. */
export function fibreColor(material: { name: string; color?: string; shape?: "flat" | "round" }): { color: string; metalness: number; roughness: number } {
  const n = material.name.toLowerCase();
  const metal = /wire|copper|steel|alumin|brass/.test(n);
  const guess = metal
    ? { color: "#b9bcc2", metalness: 0.9, roughness: 0.35 }
    : n.includes("glass")
      ? { color: "#cfd6cf", metalness: 0.0, roughness: 0.32 }
      : n.includes("aramid") || n.includes("kevlar")
        ? { color: "#c9a227", metalness: 0.0, roughness: 0.45 }
        : n.includes("basalt")
          ? { color: "#5a4a32", metalness: 0.1, roughness: 0.4 }
          : /jute|hemp|sisal|manila|cotton|twine/.test(n)
            ? { color: "#b08d57", metalness: 0.0, roughness: 0.9 }
            : material.shape === "round"
              ? { color: "#d9d6cc", metalness: 0.0, roughness: 0.85 }
              : { color: "#23262b", metalness: 0.35, roughness: 0.38 };
  if (material.shape === "round" && !metal) guess.roughness = Math.max(guess.roughness, 0.8);
  return /^#[0-9a-f]{6}$/i.test(material.color ?? "") ? { ...guess, color: material.color! } : guess;
}

/** Diverging scale for reserve factor: red below the requirement, neutral at it, blue above. */
export const RESERVE = { low: "#e34948", mid: "#8d9199", high: "#3987e5", none: "#3a3d44" };

/** Position on the reserve scale: -1 (half the requirement or less) .. 0 (meets it) .. +1 (twice it or more). */
export function reservePosition(rf: number, required: number): number {
  const t = rf / Math.max(required, 1e-9);
  return t < 1 ? Math.max((t - 1) / 0.5, -1) : Math.min(t - 1, 1);
}
