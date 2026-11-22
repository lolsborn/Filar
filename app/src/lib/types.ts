// Mirrors the serde models in crates/filar-core. Keep the two in step.

export interface Axis {
  enabled: boolean;
  letter: string;
  scale: number;
  offset: number;
  invert: boolean;
  min: number | null;
  max: number | null;
  maxSpeed: number;
}

export type FeedMode = "inverseTime" | "allAxes" | "linearAxes";
export type RotaryMode = "cumulative" | "wrapEachCircuit";
export type CommentStyle = "semicolon" | "parentheses" | "none";

export interface GcodeOptions {
  feedMode: FeedMode;
  rotaryMode: RotaryMode;
  comments: CommentStyle;
  lineNumbers: boolean;
  decimals: number;
  maxMoveTime: number;
  header: string;
  footer: string;
}

export interface MachineProfile {
  name: string;
  note: string;
  carriage: Axis;
  spindle: Axis;
  crossfeed: Axis;
  eye: Axis;
  eyeDistance: number;
  clearance: number;
  gcode: GcodeOptions;
}

export interface Mandrel {
  startDiameter: number;
  endDiameter: number;
  length: number;
  headExtension: number;
  tailExtension: number;
}

export interface Material {
  name: string;
  /** Flat band of tows, or a round strand such as rope, cord or wire. */
  shape: "flat" | "round";
  /** Width laid per pass: band width, or diameter x strands for round. */
  bandWidth: number;
  tows: number;
  tex: number;
  fiberDensity: number;
  resinDensity: number;
  fiberVolumeFraction: number;
  /** Display colour, #rrggbb. */
  color?: string;
  /** Name of the ply-property set that goes with this material. */
  plyName?: string;
}

export interface Process {
  friction: number;
  turnaround: "friction" | "pins";
  minDwellDeg: number;
  fiberSpeed: number;
}

export type AngleMode = "constant" | "geodesic";

export type PatternChoice =
  | { pattern: "auto" }
  | { pattern: "manual"; circuits: number; skip: number };

export type HelicalLayer = {
  kind: "helical";
  angleDeg: number;
  mode: AngleMode;
  coverage: number;
} & PatternChoice;

export interface HoopLayer {
  kind: "hoop";
  plies: number;
}

export type Layer = { id: string; name: string; enabled: boolean } & (HelicalLayer | HoopLayer);

export interface Project {
  version: number;
  name: string;
  mandrel: Mandrel;
  zone: { headMargin: number; tailMargin: number };
  material: Material;
  process: Process;
  layers: Layer[];
  machine: MachineProfile;
  analysis: AnalysisSettings;
  variants: Variant[];
}

export interface PlyProperties {
  name: string;
  e1: number;
  e2: number;
  g12: number;
  nu12: number;
  xt: number;
  xc: number;
  yt: number;
  yc: number;
  s: number;
  referenceVf: number;
}

export interface LoadCase {
  id: string;
  name: string;
  /** bar */
  pressure: number;
  /** N */
  axialForce: number;
  /** N·m */
  bendingMoment: number;
  /** N·m */
  torque: number;
  closedEnds: boolean;
}

export interface AnalysisSettings {
  ply: PlyProperties;
  loadCases: LoadCase[];
  criterion: "tsaiWu" | "maxStress";
  requiredRf: number;
  knockdown: number;
}

export interface Variant {
  id: string;
  name: string;
  layers: Layer[];
}

export type FailureMode = "fibreTension" | "fibreCompression" | "matrixTension" | "matrixCompression" | "shear";

export const FAILURE_MODE: Record<FailureMode, string> = {
  fibreTension: "Fibre tension",
  fibreCompression: "Fibre compression",
  matrixTension: "Matrix cracking",
  matrixCompression: "Matrix crushing",
  shear: "In-plane shear",
};

export interface PlyStress {
  s1: number;
  s2: number;
  t12: number;
  rf: number;
  mode: FailureMode;
}

export interface AnalysisStation {
  z: number;
  wall: number;
  outerDiameter: number;
  plies: { layerIndex: number; angleDeg: number; thickness: number }[];
  cases: { rf: number; critical: number; hoopStress: number; axialStress: number; plies: PlyStress[] }[];
}

export interface Analysis {
  ok: boolean;
  message: string | null;
  stations: AnalysisStation[];
  cases: { id: string; name: string; minRf: number; station: number }[];
  minRf: number | null;
  governingCase: number;
  stiffness: { ex: number; eHoop: number; g: number; ea: number; ei: number; gj: number };
  capacity: { pressureBar: number; nettingBurstBar: number; bendingNm: number; torqueNm: number; bucklingN: number };
  wallThickness: number;
  partMassG: number;
  duration: number;
}

export interface Pattern {
  circuits: number;
  skip: number;
  patternNumber: number;
  leading: boolean;
  dwell: number;
  phiCircuit: number;
  coverage: number;
}

export interface Samples {
  t: number[];
  z: number[];
  r: number[];
  phi: number[];
  alpha: number[];
  x: number[];
  y: number[];
  a: number[];
  b: number[];
  kind: number[];
}

export type BlockKind = "helical" | "hoop" | "link";

export interface Block {
  layerIndex: number;
  layerId: string;
  kind: BlockKind;
  repeats: number;
  phiStep: number;
  duration: number;
  tStart: number;
  fiberLength: number;
  radialBase: number;
  radialBuild: number;
  samples: Samples;
}

export interface LayerReport {
  id: string;
  name: string;
  kind: BlockKind;
  ok: boolean;
  plies: number;
  circuits: number;
  pattern: Pattern | null;
  candidates: Pattern[];
  angleHeadDeg: number;
  angleTailDeg: number;
  turnHead: number;
  turnTail: number;
  maxSlip: number;
  thickness: number;
  coverageHead: number;
  coverageTail: number;
  fiberLength: number;
  duration: number;
  tStart: number;
}

export interface Warning {
  level: "info" | "warn" | "error";
  layerId: string | null;
  message: string;
}

export interface Plan {
  mandrel: {
    profile: [number, number][];
    length: number;
    maxRadius: number;
    partStart: number;
    partEnd: number;
  };
  blocks: Block[];
  layers: LayerReport[];
  stations: {
    z: number[];
    r: number[];
    thickness: number[];
    layers: { layerId: string; thickness: number[]; angle: (number | null)[] }[];
  };
  totals: {
    duration: number;
    fiberLengthM: number;
    fiberMassG: number;
    resinMassG: number;
    partMassG: number;
    wallThickness: number;
    plyThickness: number;
    spindleTurns: number;
    moves: number;
  };
  envelope: {
    carriage: [number, number];
    crossfeed: [number, number];
    eyeDeg: [number, number];
    spindleDeg: number;
  };
  warnings: Warning[];
}

export interface Gcode {
  text: string;
  lines: number;
  moves: number;
  duration: number;
  lineTimes: number[];
}

export interface Defaults {
  tube: Project;
  cone: Project;
  machines: MachineProfile[];
  materials: Material[];
  plies: PlyProperties[];
  version: string;
}

export const SEG_KIND = ["Turn out", "Body", "Turn in", "Dwell", "Hoop", "Link"] as const;
