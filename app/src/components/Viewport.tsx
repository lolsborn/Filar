import { useEffect, useMemo, useRef, type ComponentRef } from "react";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ContactShadows, Environment, Grid, Html, Lightformer, Line, OrbitControls } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import { activeCase, useApp } from "../lib/store";
import { lowerIndex, stateAt, useClock } from "../lib/sim";
import { buildRibbon, contactHeight, liftPerRepeat, liftWithin, shareGeometry } from "../lib/ribbon";
import { ACCENT, fibreColor, layerColor, RESERVE, reservePosition } from "../lib/theme";
import type { AnalysisStation, Plan, Project } from "../lib/types";
import { useUnits } from "../lib/units";

type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;
type Line2 = ComponentRef<typeof Line>;

const X_AXIS = new THREE.Vector3(1, 0, 0);

/** Standard material that also understands a per-instance radial lift. */
function bandMaterial(params: THREE.MeshPhysicalMaterialParameters): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({ vertexColors: true, ...params });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aLift;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed += objectNormal * aLift;");
  };
  return m;
}

/**
 * Brightness across the band: darker edges so neighbouring bands read as
 * separate, and fine streaks so a band looks like a tow of filaments.
 */
function towTexture(): THREE.CanvasTexture {
  const rows = 64;
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = rows;
  const ctx = canvas.getContext("2d")!;
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < rows; y++) {
    const edge = Math.min(y, rows - 1 - y);
    const v = edge < 2 ? 0.38 : edge < 4 ? 0.7 : 0.8 + 0.2 * rand();
    const c = Math.round(v * 255);
    ctx.fillStyle = `rgb(${c},${c},${c})`;
    ctx.fillRect(0, y, 4, 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** A twisted-strand pattern for rope and cord: diagonal lays that repeat along the strand. */
function ropeTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "rgba(0,0,0,0.42)";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  // Lines of slope 1, spaced so they tile seamlessly in both directions.
  for (let o = -size; o <= size; o += size / 2) {
    ctx.beginPath();
    ctx.moveTo(o, 0);
    ctx.lineTo(o + size, size);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

interface BlockMeshes {
  done: THREE.InstancedMesh;
  live: THREE.InstancedMesh;
  times: Float32Array;
  sections: number;
  indicesPerSection: number;
  dispose(): void;
}

/** GPU objects for every block of the plan. */
type Tint = ((z: number) => [number, number, number]) | null;

function useBlockMeshes(plan: Plan, project: Project, colorMode: "fibre" | "layers", tint: Tint): BlockMeshes[] {
  const { bandWidth, shape, tows, name: materialName, color: materialColor } = project.material;
  const meshes = useMemo(() => {
    const band = { bandWidth, shape, tows };
    const round = shape === "round";
    const fibre = fibreColor({ name: materialName, color: materialColor, shape });
    const tow = round ? ropeTexture() : towTexture();
    const mat4 = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    return plan.blocks.map((block): BlockMeshes => {
      const ribbon = buildRibbon(block, plan, band, tint ?? undefined);
      // Dry rope is matt; a resin-wet fibre band is glossy and streaky.
      const material = tint
        ? bandMaterial({ map: tow, color: "#ffffff", roughness: round ? 0.8 : 0.5, metalness: 0.05, clearcoat: round ? 0 : 0.35, clearcoatRoughness: 0.3 })
        : colorMode === "layers"
          ? bandMaterial({ map: tow, color: layerColor(block.layerIndex), roughness: round ? 0.8 : 0.42, metalness: 0.1, clearcoat: round ? 0 : 0.6, clearcoatRoughness: 0.25 })
          : bandMaterial({
              map: tow,
              color: fibre.color,
              roughness: fibre.roughness,
              metalness: fibre.metalness,
              clearcoat: round ? 0 : 1,
              clearcoatRoughness: 0.18,
              anisotropy: round ? 0 : 0.75,
            });

      // Completed repeats: one instance each, rotated by the pattern step.
      const lifts = new Float32Array(block.repeats);
      const per = liftPerRepeat(block, band);
      for (let k = 0; k < block.repeats; k++) lifts[k] = k * per;
      ribbon.geometry.setAttribute("aLift", new THREE.InstancedBufferAttribute(lifts, 1));
      const done = new THREE.InstancedMesh(ribbon.geometry, material, block.repeats);
      for (let k = 0; k < block.repeats; k++) {
        quat.setFromAxisAngle(X_AXIS, k * block.phiStep);
        done.setMatrixAt(k, mat4.makeRotationFromQuaternion(quat));
      }
      done.instanceMatrix.needsUpdate = true;
      done.castShadow = true;
      done.receiveShadow = true;

      // The repeat being wound right now: same buffers, partial draw range.
      const liveGeometry = shareGeometry(ribbon.geometry);
      liveGeometry.setAttribute("aLift", new THREE.InstancedBufferAttribute(new Float32Array(1), 1));
      const live = new THREE.InstancedMesh(liveGeometry, material, 1);
      live.visible = false;

      return {
        done,
        live,
        times: ribbon.times,
        sections: ribbon.sections,
        indicesPerSection: ribbon.indicesPerSection,
        dispose() {
          ribbon.geometry.dispose();
          liveGeometry.dispose();
          material.dispose();
          done.dispose();
          live.dispose();
        },
      };
    });
  }, [plan, bandWidth, shape, tows, materialName, materialColor, colorMode, tint]);
  useEffect(() => () => meshes.forEach((m) => m.dispose()), [meshes]);
  return meshes;
}

function MandrelMesh({ plan }: { plan: Plan }) {
  const geometry = useMemo(() => {
    const { profile, length } = plan.mandrel;
    const pts: THREE.Vector2[] = [];
    const first = profile[0];
    const last = profile[profile.length - 1];
    // Lathe spins about Y; the mesh is rotated so Y becomes the mandrel axis.
    // Small chamfers stop the ends looking like paper.
    const ch = Math.min(1.5, first[1] * 0.1);
    pts.push(new THREE.Vector2(0.001, first[0]));
    pts.push(new THREE.Vector2(first[1] - ch, first[0]));
    pts.push(new THREE.Vector2(first[1], first[0] + ch));
    for (let i = 1; i < profile.length - 1; i++) pts.push(new THREE.Vector2(profile[i][1], profile[i][0]));
    pts.push(new THREE.Vector2(last[1], last[0] - ch));
    pts.push(new THREE.Vector2(last[1] - ch, last[0]));
    pts.push(new THREE.Vector2(0.001, last[0]));
    const g = new THREE.LatheGeometry(pts, 96);
    g.rotateZ(-Math.PI / 2); // +Y -> +X
    g.translate(-length / 2, 0, 0);
    return g;
  }, [plan.mandrel]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshPhysicalMaterial color="#aeb4bc" metalness={1} roughness={0.28} side={THREE.DoubleSide} />
    </mesh>
  );
}

/** Thin glowing rings marking the ends of the usable part. */
function ZoneMarkers({ plan }: { plan: Plan }) {
  const { partStart, partEnd, length, profile } = plan.mandrel;
  const total = plan.totals.wallThickness;
  return (
    <>
      {[partStart, partEnd].map((z, i) => {
        const r = radius(profile, z) + total + 2.2;
        return (
          <mesh key={i} position={[z - length / 2, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
            <torusGeometry args={[r, 0.35, 8, 96]} />
            <meshBasicMaterial color={ACCENT} toneMapped={false} />
          </mesh>
        );
      })}
    </>
  );
}

/** Ring and label at the station being inspected. */
function StationMarker({ plan, station, rf, lowest }: { plan: Plan; station?: AnalysisStation; rf?: number; lowest: boolean }) {
  const U = useUnits();
  if (!station || rf == null) return null;
  const r = station.outerDiameter / 2 + 2.5;
  const x = station.z - plan.mandrel.length / 2;
  return (
    <group position={[x, 0, 0]}>
      <mesh rotation={[0, Math.PI / 2, 0]}>
        <torusGeometry args={[r, 0.7, 10, 96]} />
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </mesh>
      <Html position={[0, r + 6, 0]} center zIndexRange={[5, 0]} style={{ pointerEvents: "none", transform: "translateY(-70%)" }}>
        <div className="glass rounded-lg px-2.5 py-1.5 text-[11px] whitespace-nowrap">
          <div className="text-ink-3">{lowest ? "Lowest reserve factor" : "Reserve factor"}</div>
          <div className="num text-[13px] font-semibold text-ink">
            {rf >= 99 ? "99+" : rf.toFixed(2)} <span className="font-normal text-ink-3">at {U.fmt("length", station.z, 0)}</span>
          </div>
        </div>
      </Html>
    </group>
  );
}

function radius(profile: [number, number][], z: number) {
  for (let i = 1; i < profile.length; i++) {
    if (z <= profile[i][0]) {
      const [z0, r0] = profile[i - 1];
      const [z1, r1] = profile[i];
      return r0 + ((r1 - r0) * (z - z0)) / (z1 - z0);
    }
  }
  return profile[profile.length - 1][1];
}

interface MachineRefs {
  carriage: THREE.Group | null;
  slide: THREE.Group | null;
  eye: THREE.Group | null;
  fibre: Line2 | null;
}

const DARK = { color: "#17191d", metalness: 0.7, roughness: 0.45 };
const STEEL = { color: "#8d949d", metalness: 1, roughness: 0.25 };

function Machine({ plan, project, refs }: { plan: Plan; project: Project; refs: React.RefObject<MachineRefs> }) {
  const L = plan.mandrel.length;
  const R = plan.mandrel.maxRadius;
  const rhoMax = project.machine.crossfeed.enabled ? R + project.machine.clearance : project.machine.eyeDistance;
  const bedY = -(R + 85);
  const railZ = rhoMax + 95;
  const x0 = -L / 2 - 150;
  const x1 = L / 2 + 150;
  const bedLen = x1 - x0;
  const bedDepth = railZ + 60 + 110;
  const bedZ = (railZ + 60 - 110) / 2;
  const first = plan.mandrel.profile[0][1];
  const last = plan.mandrel.profile[plan.mandrel.profile.length - 1][1];

  return (
    <group>
      {/* Bed */}
      <mesh position={[(x0 + x1) / 2, bedY - 14, bedZ]} receiveShadow castShadow>
        <boxGeometry args={[bedLen, 28, bedDepth]} />
        <meshStandardMaterial {...DARK} />
      </mesh>
      {/* Headstock, chuck and drive shaft */}
      <mesh position={[-L / 2 - 105, bedY / 2 + 12, 0]} castShadow receiveShadow>
        <boxGeometry args={[70, -bedY + 70, 120]} />
        <meshStandardMaterial {...DARK} />
      </mesh>
      <mesh position={[-L / 2 - 52, 0, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[Math.max(first * 0.6, 22), Math.max(first * 0.6, 22), 34, 48]} />
        <meshStandardMaterial {...STEEL} />
      </mesh>
      <mesh position={[-L / 2 - 18, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[Math.min(8, first * 0.5), Math.min(8, first * 0.5), 36, 24]} />
        <meshStandardMaterial {...STEEL} />
      </mesh>
      {/* Tailstock and live centre */}
      <mesh position={[L / 2 + 95, bedY / 2 + 4, 0]} castShadow receiveShadow>
        <boxGeometry args={[50, -bedY + 54, 90]} />
        <meshStandardMaterial {...DARK} />
      </mesh>
      <mesh position={[L / 2 + 35, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[Math.min(7, last * 0.5), Math.min(7, last * 0.5), 70, 24]} />
        <meshStandardMaterial {...STEEL} />
      </mesh>
      {/* Carriage rails */}
      {[-22, 22].map((dz) => (
        <mesh key={dz} position={[(x0 + x1) / 2, bedY + 7, railZ + dz]} rotation={[0, 0, Math.PI / 2]} castShadow>
          <cylinderGeometry args={[5, 5, bedLen - 30, 16]} />
          <meshStandardMaterial {...STEEL} />
        </mesh>
      ))}

      {/* Carriage: moves along X */}
      <group ref={(g) => void (refs.current.carriage = g)}>
        <mesh position={[0, bedY + 22, railZ]} castShadow>
          <boxGeometry args={[84, 22, 78]} />
          <meshStandardMaterial color="#22252b" metalness={0.6} roughness={0.4} />
        </mesh>
        <mesh position={[0, bedY / 2 + 26, railZ]} castShadow>
          <boxGeometry args={[26, -bedY - 14, 26]} />
          <meshStandardMaterial color="#22252b" metalness={0.6} roughness={0.4} />
        </mesh>
        {/* Spool */}
        <mesh position={[0, bedY + 62, railZ + 26]} rotation={[0, 0, Math.PI / 2]} castShadow>
          <cylinderGeometry args={[24, 24, 30, 40]} />
          <meshPhysicalMaterial {...fibreColor(project.material)} clearcoat={project.material.shape === "round" ? 0 : 0.6} />
        </mesh>
        {/* Cross-slide: moves along Z with the cross-feed */}
        <group ref={(g) => void (refs.current.slide = g)}>
          <mesh position={[0, -14, 38]} castShadow>
            <boxGeometry args={[18, 12, 96]} />
            <meshStandardMaterial {...STEEL} />
          </mesh>
          {/* Delivery eye: rotates about the cross-feed direction */}
          <group ref={(g) => void (refs.current.eye = g)}>
            {[-9, 9].map((dx) => (
              <mesh key={dx} position={[dx, -4, 0]}>
                <boxGeometry args={[2.5, 18, 5]} />
                <meshStandardMaterial {...STEEL} />
              </mesh>
            ))}
            <mesh rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[3.2, 3.2, 16, 24]} />
              <meshStandardMaterial color={ACCENT} emissive={ACCENT} emissiveIntensity={0.9} toneMapped={false} />
            </mesh>
          </group>
        </group>
      </group>

      {/* Free fibre: spool -> eye -> touch-down point */}
      <Line
        ref={(l) => void (refs.current.fibre = l)}
        points={[
          [0, 0, 0],
          [0, 1, 0],
          [0, 2, 0],
        ]}
        color="#eef2f6"
        lineWidth={1.8}
        transparent
        opacity={0.95}
        frustumCulled={false}
      />
    </group>
  );
}

function Scene() {
  const plan = useApp((s) => s.plan)!;
  const project = useApp((s) => s.project)!;
  const colorMode = useApp((s) => s.colorMode);
  const showMachine = useApp((s) => s.showMachine);
  const mode = useApp((s) => s.mode);
  const analysis = useApp((s) => s.analysis);
  const analyseView = useApp((s) => s.analyseView);
  const caseId = useApp((s) => s.caseId);
  const stationIndex = useApp((s) => s.stationIndex);
  const caseIndex = activeCase(analysis, caseId);
  const required = project.analysis.requiredRf;
  const shaded = mode === "analyse" && analyseView === "reserve" && !!analysis?.ok;

  // Colour by reserve factor along the axis; turnaround zones (trimmed off
  // the finished part) stay neutral.
  const tint = useMemo<Tint>(() => {
    if (!shaded || !analysis) return null;
    const zs = analysis.stations.map((s) => s.z);
    const rfs = analysis.stations.map((s) => s.cases[caseIndex]?.rf ?? 0);
    const low = new THREE.Color(RESERVE.low);
    const mid = new THREE.Color(RESERVE.mid);
    const high = new THREE.Color(RESERVE.high);
    const none = new THREE.Color(RESERVE.none);
    const c = new THREE.Color();
    const half = zs.length > 1 ? (zs[1] - zs[0]) / 2 : 0;
    return (z: number) => {
      if (z < zs[0] - half || z > zs[zs.length - 1] + half) return [none.r, none.g, none.b];
      const i = Math.min(lowerIndex(zs, z), zs.length - 2);
      const u = Math.min(Math.max((z - zs[i]) / (zs[i + 1] - zs[i] || 1), 0), 1);
      const p = reservePosition(rfs[i] + (rfs[i + 1] - rfs[i]) * u, required);
      c.copy(mid).lerp(p < 0 ? low : high, Math.abs(p));
      return [c.r, c.g, c.b];
    };
  }, [shaded, analysis, caseIndex, required]);

  const meshes = useBlockMeshes(plan, project, colorMode, tint);
  const spin = useRef<THREE.Group>(null);
  const machine = useRef<MachineRefs>({ carriage: null, slide: null, eye: null, fibre: null });
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, invalidate, get } = useThree();

  const L = plan.mandrel.length;
  const R = plan.mandrel.maxRadius;
  const live = mode === "simulate" || mode === "gcode";
  const machineVisible = showMachine && live;

  // Frame the scene in the space the side panels leave free. Runs on first
  // load, when the mandrel changes size a lot, when the machine appears, or
  // on request - but never overrides a view the user has set by hand.
  const autoFramed = useRef(true);
  const fit = useMemo(
    () => () => {
      const { size } = get();
      const app = useApp.getState();
      const withMachine = (app.mode === "simulate" || app.mode === "gcode") && app.showMachine;
      const right = app.mode === "gcode" ? 440 : app.mode === "analyse" && app.stationIndex != null ? 470 : 340;
      const panels = 336 + right + 60;
      const cam = camera as THREE.PerspectiveCamera;
      const aspect = size.width / Math.max(size.height, 1);
      const free = Math.max((size.width - panels) / size.width, 0.3);
      const tan = Math.tan((cam.fov * Math.PI) / 360);
      const span = withMachine ? L + 360 : Math.max(L * 1.12, R * 8, 200);
      const d = span / (2 * tan * aspect * free);
      const dir = new THREE.Vector3(0.3, 0.34, 0.89).normalize();
      // Aim below the axis so the part clears the bottom dock, and nudge
      // sideways when the right-hand panel is the wider one.
      const shift = ((right - 336) / size.width) * d * tan * aspect;
      const target = new THREE.Vector3(shift, -d * tan * (withMachine ? 0.3 : 0.16), 0);
      camera.position.copy(target).addScaledVector(dir, d);
      controls.current?.target.copy(target);
      controls.current?.update();
      autoFramed.current = true;
      invalidate();
    },
    [L, R, camera, invalidate, get],
  );
  const fitKey = `${Math.round(L / 50)}:${Math.round(R / 15)}`;
  useEffect(() => fit(), [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (autoFramed.current) fit();
  }, [mode, machineVisible, stationIndex != null]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    window.addEventListener("filar:fit", fit);
    return () => window.removeEventListener("filar:fit", fit);
  }, [fit]);

  const mat = useMemo(() => new THREE.Matrix4(), []);
  const quat = useMemo(() => new THREE.Quaternion(), []);
  const lastShown = useRef(-1);

  useFrame((_, dt) => {
    // Advance the clock.
    const clock = useClock.getState();
    const total = plan.totals.duration;
    if (live && clock.playing) {
      let t = clock.time + Math.min(dt, 0.1) * clock.speed;
      if (t >= total) {
        t = total;
        clock.set({ playing: false });
      }
      clock.setTime(t);
    }
    const time = live ? Math.min(useClock.getState().time, total) : total;

    // Keep depth precision high enough to separate bands 0.01 mm apart.
    const dist = camera.position.distanceTo(controls.current?.target ?? new THREE.Vector3());
    const near = Math.max(2, dist * 0.06);
    if (Math.abs(camera.near - near) / near > 0.05) {
      camera.near = near;
      camera.far = Math.max(8000, dist * 12);
      camera.updateProjectionMatrix();
    }

    if (time === lastShown.current && !clock.playing) return;
    lastShown.current = time;
    const st = stateAt(plan, time);

    // Reveal fibre up to `time`.
    plan.blocks.forEach((block, i) => {
      const m = meshes[i];
      if (!m) return;
      const end = block.tStart + block.duration * block.repeats;
      if (time >= end - 1e-9) {
        m.done.count = block.repeats;
        m.live.visible = false;
      } else if (time <= block.tStart || !st || st.block !== i) {
        m.done.count = 0;
        m.live.visible = false;
      } else {
        m.done.count = st.repeat;
        const section = lowerIndex(m.times, st.local);
        m.live.geometry.setDrawRange(0, section * m.indicesPerSection);
        quat.setFromAxisAngle(X_AXIS, st.repeat * block.phiStep);
        m.live.setMatrixAt(0, mat.makeRotationFromQuaternion(quat));
        m.live.instanceMatrix.needsUpdate = true;
        const lift = m.live.geometry.getAttribute("aLift") as THREE.InstancedBufferAttribute;
        lift.setX(0, st.repeat * liftPerRepeat(block, project.material));
        lift.needsUpdate = true;
        m.live.visible = section > 0;
      }
    });

    // Pose the machine. In design mode the part is shown finished and still.
    if (spin.current) spin.current.rotation.x = live && st ? -st.a : 0;
    const mr = machine.current;
    if (st && machineVisible && mr.carriage && mr.slide && mr.eye) {
      const ex = st.x - L / 2;
      mr.carriage.position.x = ex;
      mr.slide.position.z = st.y;
      mr.eye.rotation.z = st.b;
      const block = plan.blocks[st.block];
      const band = project.material;
      // The free span meets the mandrel at the strand's centre line.
      const rr = st.r + liftWithin(block, band, st.local / block.duration, st.alpha) + st.repeat * liftPerRepeat(block, band) + contactHeight(band) / 2;
      const world = st.phi - st.a; // touch-down angle in the machine frame
      const rhoMax = project.machine.crossfeed.enabled ? R + project.machine.clearance : project.machine.eyeDistance;
      mr.fibre?.geometry.setPositions([
        ex, -(R + 85) + 86, rhoMax + 95 + 26,
        ex, 3.2, st.y,
        st.z - L / 2, -rr * Math.sin(world), rr * Math.cos(world),
      ]);
    }
  });

  // Re-pose immediately when inputs change, even while paused.
  useEffect(() => {
    lastShown.current = -1;
    invalidate();
  }, [plan, meshes, mode, machineVisible, invalidate]);
  useEffect(() => useClock.subscribe(() => invalidate()), [invalidate]);

  return (
    <>
      <color attach="background" args={["#0a0b0e"]} />
      <fog attach="fog" args={["#0a0b0e", 1800, 5200]} />
      <ambientLight intensity={0.25} />
      <directionalLight
        position={[L * 0.3, 700, 500]}
        intensity={2.2}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-L}
        shadow-camera-right={L}
        shadow-camera-top={500}
        shadow-camera-bottom={-500}
        shadow-camera-far={3000}
        shadow-bias={-0.0005}
      />
      <Environment resolution={256} frames={1}>
        <color attach="background" args={["#050608"]} />
        <Lightformer form="rect" intensity={5} position={[0, 6, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[14, 2.2, 1]} />
        <Lightformer form="rect" intensity={2.2} position={[0, 2.5, 7]} scale={[16, 1.4, 1]} />
        <Lightformer form="rect" intensity={1.4} position={[0, 1, -7]} rotation={[0, Math.PI, 0]} scale={[16, 3, 1]} color="#9fb6ff" />
        <Lightformer form="rect" intensity={1.6} position={[-9, 2, 0]} rotation={[0, Math.PI / 2, 0]} scale={[8, 3, 1]} color="#ffd9b0" />
        <Lightformer form="rect" intensity={1.2} position={[9, 2, 0]} rotation={[0, -Math.PI / 2, 0]} scale={[8, 3, 1]} />
        <Lightformer form="ring" intensity={3} position={[4, 5, 5]} scale={1.6} color={ACCENT} />
      </Environment>

      <group ref={spin}>
        <MandrelMesh plan={plan} />
        {meshes.map((m, i) => (
          <group key={i}>
            <primitive object={m.done} />
            <primitive object={m.live} />
          </group>
        ))}
      </group>
      <ZoneMarkers plan={plan} />
      {mode === "analyse" && analysis?.ok && (
        <StationMarker
          plan={plan}
          station={analysis.stations[stationIndex ?? analysis.cases[caseIndex]?.station ?? 0]}
          rf={analysis.stations[stationIndex ?? analysis.cases[caseIndex]?.station ?? 0]?.cases[caseIndex]?.rf}
          lowest={stationIndex == null}
        />
      )}
      <group visible={machineVisible}>
        <Machine plan={plan} project={project} refs={machine} />
      </group>

      <ContactShadows
        position={[0, -(R + 85) - (machineVisible ? 28.2 : 0), 0]}
        scale={[L * 2.2, 900]}
        far={R + 200}
        blur={2.6}
        opacity={0.55}
        resolution={1024}
        frames={Infinity}
      />
      <Grid
        position={[0, -(R + 85) - (machineVisible ? 28.4 : 0.2), 0]}
        args={[10, 10]}
        infiniteGrid
        cellSize={25}
        sectionSize={100}
        cellThickness={0.6}
        sectionThickness={1}
        cellColor="#20242b"
        sectionColor="#2c323b"
        fadeDistance={3200}
        fadeStrength={2.2}
      />

      <OrbitControls
        ref={controls}
        makeDefault
        enableDamping
        dampingFactor={0.12}
        minDistance={60}
        maxDistance={6000}
        maxPolarAngle={Math.PI * 0.62}
        onStart={() => void (autoFramed.current = false)}
        onChange={() => invalidate()}
      />
      <EffectComposer multisampling={4}>
        <Bloom intensity={0.55} luminanceThreshold={1} luminanceSmoothing={0.2} mipmapBlur radius={0.7} />
        <Vignette offset={0.25} darkness={0.62} />
      </EffectComposer>
    </>
  );
}

export function Viewport() {
  const ready = useApp((s) => !!s.plan && !!s.project);
  const playing = useClock((s) => s.playing);
  const mode = useApp((s) => s.mode);
  return (
    <Canvas
      className="absolute inset-0"
      shadows
      dpr={[1, 2]}
      frameloop={playing && (mode === "simulate" || mode === "gcode") ? "always" : "demand"}
      camera={{ fov: 32, near: 5, far: 9000, position: [300, 300, 700] }}
      gl={{ antialias: false, powerPreference: "high-performance" }}
    >
      {ready && <Scene />}
    </Canvas>
  );
}
