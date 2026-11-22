//! Laminate stiffness and first-failure estimates for the wound wall.
//!
//! The planner knows the angle and thickness of every ply at every station
//! along the mandrel. This module treats the wall at each station as a thin
//! laminate under membrane loads (classical lamination theory, in-plane
//! terms only) and reports, for each load case, how far each ply is from
//! first failure.
//!
//! These are estimates for comparing layups. They assume a thin wall, perfect
//! bonding and uniform plies, and they ignore fibre crimp at crossovers,
//! voids, end fittings, shell buckling, impact and fatigue. A single
//! knock-down factor stands in for everything that makes a wound laminate
//! weaker than the ply data suggests; it should come from testing.
//!
//! Units: MPa, mm and N internally (so line loads are N/mm). Inputs are in
//! the units an engineer would type: GPa, MPa, bar, N, N·m.

use std::f64::consts::PI;

use serde::{Deserialize, Serialize};

use crate::plan::{BlockKind, Plan};
use crate::project::{Layer, Project};

// ---------------------------------------------------------------- inputs --

/// Unidirectional ply properties, in the ply's own axes (1 = along the
/// fibre, 2 = across it).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlyProperties {
    pub name: String,
    /// Stiffness along the fibre (GPa).
    pub e1: f64,
    /// Stiffness across the fibre (GPa).
    pub e2: f64,
    /// In-plane shear stiffness (GPa).
    pub g12: f64,
    /// Major Poisson's ratio.
    pub nu12: f64,
    /// Strength along the fibre in tension / compression (MPa).
    pub xt: f64,
    pub xc: f64,
    /// Strength across the fibre in tension / compression (MPa).
    pub yt: f64,
    pub yc: f64,
    /// In-plane shear strength (MPa).
    pub s: f64,
    /// Fibre volume fraction the fibre-direction values are quoted at. They
    /// are scaled linearly to the volume fraction of the wound band.
    pub reference_vf: f64,
}

impl PlyProperties {
    /// Representative textbook-range values for standard-modulus carbon in
    /// epoxy. Not data for any particular product.
    pub fn carbon_epoxy() -> Self {
        PlyProperties {
            name: "Carbon / epoxy".into(),
            e1: 135.0,
            e2: 9.5,
            g12: 5.0,
            nu12: 0.30,
            xt: 1500.0,
            xc: 1200.0,
            yt: 40.0,
            yc: 200.0,
            s: 70.0,
            reference_vf: 0.60,
        }
    }
    pub fn glass_epoxy() -> Self {
        PlyProperties {
            name: "E-glass / epoxy".into(),
            e1: 40.0,
            e2: 9.0,
            g12: 4.0,
            nu12: 0.28,
            xt: 1000.0,
            xc: 600.0,
            yt: 35.0,
            yc: 120.0,
            s: 50.0,
            reference_vf: 0.55,
        }
    }
    pub fn aramid_epoxy() -> Self {
        PlyProperties {
            name: "Aramid / epoxy".into(),
            e1: 76.0,
            e2: 5.5,
            g12: 2.2,
            nu12: 0.34,
            xt: 1300.0,
            xc: 280.0,
            yt: 25.0,
            yc: 140.0,
            s: 45.0,
            reference_vf: 0.60,
        }
    }
    pub fn presets() -> Vec<PlyProperties> {
        vec![Self::carbon_epoxy(), Self::glass_epoxy(), Self::aramid_epoxy()]
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Criterion {
    TsaiWu,
    MaxStress,
}

/// A set of loads applied to the tube together.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoadCase {
    pub id: String,
    pub name: String,
    /// Internal pressure (bar).
    pub pressure: f64,
    /// Axial force, tension positive (N).
    pub axial_force: f64,
    /// Bending moment (N·m). Both the tension and compression sides are checked.
    pub bending_moment: f64,
    /// Torque (N·m).
    pub torque: f64,
    /// Closed ends: pressure also pulls the tube apart axially.
    pub closed_ends: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisSettings {
    pub ply: PlyProperties,
    pub load_cases: Vec<LoadCase>,
    pub criterion: Criterion,
    /// The reserve factor the design is required to reach.
    pub required_rf: f64,
    /// Multiplier on every ply strength for wound-laminate effects (0..1].
    pub knockdown: f64,
}

impl Default for AnalysisSettings {
    fn default() -> Self {
        AnalysisSettings {
            ply: PlyProperties::carbon_epoxy(),
            load_cases: vec![LoadCase {
                id: "c1".into(),
                name: "Internal pressure".into(),
                pressure: 20.0,
                axial_force: 0.0,
                bending_moment: 0.0,
                torque: 0.0,
                closed_ends: true,
            }],
            criterion: Criterion::TsaiWu,
            required_rf: 1.5,
            knockdown: 0.75,
        }
    }
}

/// An alternative layup kept alongside the design for comparison.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Variant {
    pub id: String,
    pub name: String,
    pub layers: Vec<Layer>,
}

// --------------------------------------------------------------- outputs --

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    FibreTension,
    FibreCompression,
    MatrixTension,
    MatrixCompression,
    Shear,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlyStress {
    /// Stress along the fibre, across it, and in shear (MPa).
    pub s1: f64,
    pub s2: f64,
    pub t12: f64,
    /// Reserve factor: the multiple of the applied load this ply survives.
    pub rf: f64,
    /// What gives first.
    pub mode: Mode,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlyInfo {
    pub layer_index: usize,
    /// Angle from the mandrel axis (deg), signed.
    pub angle_deg: f64,
    pub thickness: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StationCase {
    /// Lowest reserve factor of any ply here.
    pub rf: f64,
    /// Index into `plies` of the ply that governs.
    pub critical: usize,
    /// Wall-average hoop and axial stress (MPa).
    pub hoop_stress: f64,
    pub axial_stress: f64,
    pub plies: Vec<PlyStress>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Station {
    pub z: f64,
    pub wall: f64,
    pub outer_diameter: f64,
    /// Plies from the mandrel outwards.
    pub plies: Vec<PlyInfo>,
    /// One entry per load case.
    pub cases: Vec<StationCase>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CaseSummary {
    pub id: String,
    pub name: String,
    pub min_rf: f64,
    /// Index into `stations` of the weakest station.
    pub station: usize,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stiffness {
    /// Effective wall moduli at mid-part (GPa).
    pub ex: f64,
    pub e_hoop: f64,
    pub g: f64,
    /// Tube stiffness at mid-part: axial (N), bending and torsion (N·m²).
    pub ea: f64,
    pub ei: f64,
    pub gj: f64,
}

/// The load each basic case could reach before first ply failure, taken at
/// the weakest station, with the knock-down applied.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Capacity {
    /// Internal pressure with closed ends (bar).
    pub pressure_bar: f64,
    /// Fibre-only (netting) burst pressure with closed ends (bar).
    pub netting_burst_bar: f64,
    pub bending_nm: f64,
    pub torque_nm: f64,
    /// Euler column buckling, pinned ends over the part length (N).
    pub buckling_n: f64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    /// False when there is no wall to analyse; `message` says why.
    pub ok: bool,
    pub message: Option<String>,
    /// Stations inside the part zone, head to tail.
    pub stations: Vec<Station>,
    pub cases: Vec<CaseSummary>,
    /// Lowest reserve factor over every case, and which case it is.
    pub min_rf: Option<f64>,
    pub governing_case: usize,
    pub stiffness: Stiffness,
    pub capacity: Capacity,
    /// For side-by-side comparison of layups.
    pub wall_thickness: f64,
    pub part_mass_g: f64,
    pub duration: f64,
}

// ------------------------------------------------------------- mechanics --

/// Reduced stiffness of a ply in its own axes: `[Q11, Q22, Q12, Q66]` (MPa).
fn reduced_stiffness(p: &PlyProperties) -> [f64; 4] {
    let (e1, e2, g12) = (p.e1 * 1e3, p.e2 * 1e3, p.g12 * 1e3);
    let nu21 = p.nu12 * e2 / e1;
    let d = 1.0 - p.nu12 * nu21;
    [e1 / d, e2 / d, p.nu12 * e2 / d, g12]
}

/// Ply stiffness rotated to the tube axes (x axial, y hoop):
/// `[Q11, Q22, Q12, Q66, Q16, Q26]`.
fn rotated(q: &[f64; 4], theta: f64) -> [f64; 6] {
    let (n, m) = theta.sin_cos();
    let (m2, n2) = (m * m, n * n);
    let [q11, q22, q12, q66] = *q;
    [
        q11 * m2 * m2 + 2.0 * (q12 + 2.0 * q66) * m2 * n2 + q22 * n2 * n2,
        q11 * n2 * n2 + 2.0 * (q12 + 2.0 * q66) * m2 * n2 + q22 * m2 * m2,
        (q11 + q22 - 4.0 * q66) * m2 * n2 + q12 * (m2 * m2 + n2 * n2),
        (q11 + q22 - 2.0 * q12 - 2.0 * q66) * m2 * n2 + q66 * (m2 * m2 + n2 * n2),
        (q11 - q12 - 2.0 * q66) * m2 * m * n - (q22 - q12 - 2.0 * q66) * m * n2 * n,
        (q11 - q12 - 2.0 * q66) * m * n2 * n - (q22 - q12 - 2.0 * q66) * m2 * m * n,
    ]
}

/// Inverse of a symmetric 3x3 given as `[a11, a22, a12, a66, a16, a26]`.
fn invert(a: &[f64; 6]) -> Option<[[f64; 3]; 3]> {
    let m = [[a[0], a[2], a[4]], [a[2], a[1], a[5]], [a[4], a[5], a[3]]];
    let c = |i: usize, j: usize| {
        let (r0, r1) = ((i + 1) % 3, (i + 2) % 3);
        let (c0, c1) = ((j + 1) % 3, (j + 2) % 3);
        m[r0][c0] * m[r1][c1] - m[r0][c1] * m[r1][c0]
    };
    let det = m[0][0] * c(0, 0) + m[0][1] * c(0, 1) + m[0][2] * c(0, 2);
    if !(det.abs() > 1e-12) {
        return None;
    }
    let mut inv = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            inv[j][i] = c(i, j) / det;
        }
    }
    Some(inv)
}

struct Ply {
    info: PlyInfo,
    theta: f64,
}

struct Wall {
    z: f64,
    /// Mid-wall radius (mm).
    r: f64,
    t: f64,
    plies: Vec<Ply>,
    /// Membrane compliance (mm/N).
    a_inv: [[f64; 3]; 3],
}

/// Strength ratio of one ply under stresses `(s1, s2, t12)`, before any
/// knock-down, and the mode that governs.
fn ply_reserve(p: &PlyProperties, criterion: Criterion, s1: f64, s2: f64, t12: f64) -> (f64, Mode) {
    const BIG: f64 = 1e6;
    let ratio = |strength: f64, stress: f64| if stress.abs() > 1e-9 { strength / stress.abs() } else { BIG };
    let fibre = if s1 >= 0.0 { (ratio(p.xt, s1), Mode::FibreTension) } else { (ratio(p.xc, s1), Mode::FibreCompression) };
    let matrix = if s2 >= 0.0 { (ratio(p.yt, s2), Mode::MatrixTension) } else { (ratio(p.yc, s2), Mode::MatrixCompression) };
    let shear = (ratio(p.s, t12), Mode::Shear);
    let max_stress = [fibre, matrix, shear].into_iter().min_by(|a, b| a.0.partial_cmp(&b.0).unwrap()).unwrap();
    match criterion {
        Criterion::MaxStress => max_stress,
        Criterion::TsaiWu => {
            let f1 = 1.0 / p.xt - 1.0 / p.xc;
            let f2 = 1.0 / p.yt - 1.0 / p.yc;
            let f11 = 1.0 / (p.xt * p.xc);
            let f22 = 1.0 / (p.yt * p.yc);
            let f66 = 1.0 / (p.s * p.s);
            let f12 = -0.5 * (f11 * f22).sqrt();
            let a = f11 * s1 * s1 + f22 * s2 * s2 + f66 * t12 * t12 + 2.0 * f12 * s1 * s2;
            let b = f1 * s1 + f2 * s2;
            let r = if a > 1e-18 {
                (-b + (b * b + 4.0 * a).sqrt()) / (2.0 * a)
            } else if b > 1e-12 {
                1.0 / b
            } else {
                BIG
            };
            // The interaction criterion gives the margin; the largest single
            // stress ratio names the failure in words.
            (r.min(BIG), max_stress.1)
        }
    }
}

struct Solved {
    rf: f64,
    critical: usize,
    plies: Vec<PlyStress>,
}

/// Solve one wall under line loads `[Nx, Ny, Nxy]` (N/mm).
fn solve(wall: &Wall, q: &[f64; 4], p: &PlyProperties, criterion: Criterion, knockdown: f64, n: [f64; 3]) -> Solved {
    let a = &wall.a_inv;
    let ex = a[0][0] * n[0] + a[0][1] * n[1] + a[0][2] * n[2];
    let ey = a[1][0] * n[0] + a[1][1] * n[1] + a[1][2] * n[2];
    let gxy = a[2][0] * n[0] + a[2][1] * n[1] + a[2][2] * n[2];
    let mut out = Solved { rf: f64::MAX, critical: 0, plies: Vec::with_capacity(wall.plies.len()) };
    for (i, ply) in wall.plies.iter().enumerate() {
        let (s, c) = ply.theta.sin_cos();
        let e1 = ex * c * c + ey * s * s + gxy * s * c;
        let e2 = ex * s * s + ey * c * c - gxy * s * c;
        let g12 = 2.0 * (ey - ex) * s * c + gxy * (c * c - s * s);
        let s1 = q[0] * e1 + q[2] * e2;
        let s2 = q[2] * e1 + q[1] * e2;
        let t12 = q[3] * g12;
        let (r, mode) = ply_reserve(p, criterion, s1, s2, t12);
        let rf = (r * knockdown).min(999.0);
        if rf < out.rf {
            out.rf = rf;
            out.critical = i;
        }
        out.plies.push(PlyStress { s1, s2, t12, rf, mode });
    }
    out
}

/// Line loads for a load case at radius `r`, one entry per side that needs
/// checking (bending puts one side in tension and the other in compression).
fn line_loads(case: &LoadCase, r: f64) -> Vec<[f64; 3]> {
    let p = case.pressure * 0.1; // bar -> MPa
    let hoop = p * r;
    let axial = if case.closed_ends { p * r / 2.0 } else { 0.0 } + case.axial_force / (2.0 * PI * r);
    let bend = case.bending_moment * 1e3 / (PI * r * r);
    let shear = case.torque * 1e3 / (2.0 * PI * r * r);
    if bend.abs() > 0.0 {
        vec![[axial + bend, hoop, shear], [axial - bend, hoop, shear]]
    } else {
        vec![[axial, hoop, shear]]
    }
}

/// Ply properties with the fibre-dominated values scaled to the wound band's
/// fibre volume fraction.
fn scaled(p: &PlyProperties, vf: f64) -> PlyProperties {
    let k = if p.reference_vf > 0.0 { vf / p.reference_vf } else { 1.0 };
    PlyProperties { e1: p.e1 * k, xt: p.xt * k, xc: p.xc * k, ..p.clone() }
}

fn validate(s: &AnalysisSettings) -> Option<String> {
    let p = &s.ply;
    if !(p.e1 > 0.0 && p.e2 > 0.0 && p.g12 > 0.0) {
        return Some("Ply stiffnesses must be positive.".into());
    }
    if !(p.xt > 0.0 && p.xc > 0.0 && p.yt > 0.0 && p.yc > 0.0 && p.s > 0.0) {
        return Some("Ply strengths must be positive.".into());
    }
    if !(p.nu12 >= 0.0 && p.nu12 * p.nu12 * p.e2 / p.e1 < 1.0) {
        return Some("Poisson's ratio is out of range for these stiffnesses.".into());
    }
    if !(s.knockdown > 0.0 && s.knockdown <= 1.0) {
        return Some("The knock-down must be between 0 and 1.".into());
    }
    None
}

pub fn analyze(project: &Project, plan: &Plan) -> Analysis {
    let settings = &project.analysis;
    let mut out = Analysis {
        wall_thickness: plan.totals.wall_thickness,
        part_mass_g: plan.totals.part_mass_g,
        duration: plan.totals.duration,
        ..Analysis::default()
    };
    if project.material.shape == crate::project::Shape::Round {
        out.message = Some(
            "The strength estimate covers flat fibre bands that consolidate into a laminate. \
             Rope, cord and other round material are not analysed."
                .into(),
        );
        return out;
    }
    if let Some(message) = validate(settings) {
        out.message = Some(message);
        return out;
    }
    let props = scaled(&settings.ply, project.material.fiber_volume_fraction);
    let q = reduced_stiffness(&props);
    let st = &plan.stations;
    let (z_a, z_b) = (plan.mandrel.part_start, plan.mandrel.part_end);
    // Layers start and stop at the part boundary, so the last band-width at
    // each end is only partly covered. That is trim allowance, not wall, and
    // would otherwise show up as a false weak spot.
    let spacing = if st.z.len() > 1 { st.z[1] - st.z[0] } else { 0.0 };
    let edge = project.material.band_width + spacing;

    // Which plan layer each station column belongs to, in winding order.
    let layer_index = |id: &str| project.layers.iter().position(|l| l.id == id);

    // ---- Build the wall at every station inside the part ----
    let mut walls: Vec<Wall> = Vec::new();
    for j in 0..st.z.len() {
        let z = st.z[j];
        if z < z_a + edge || z > z_b - edge {
            continue;
        }
        let mut plies = Vec::new();
        for sl in &st.layers {
            let (Some(angle), t) = (sl.angle[j], sl.thickness[j]) else { continue };
            if t <= 1e-6 {
                continue;
            }
            let Some(index) = layer_index(&sl.layer_id) else { continue };
            let helical = plan.layers.iter().any(|r| r.id == sl.layer_id && r.kind == BlockKind::Helical);
            if helical {
                // Every circuit lays one +angle and one -angle band.
                for sign in [1.0, -1.0] {
                    plies.push(Ply {
                        info: PlyInfo { layer_index: index, angle_deg: sign * angle, thickness: t / 2.0 },
                        theta: (sign * angle).to_radians(),
                    });
                }
            } else {
                plies.push(Ply {
                    info: PlyInfo { layer_index: index, angle_deg: angle, thickness: t },
                    theta: angle.to_radians(),
                });
            }
        }
        let t: f64 = plies.iter().map(|p| p.info.thickness).sum();
        if t <= 1e-6 {
            continue;
        }
        let mut a = [0.0; 6];
        for ply in &plies {
            let qb = rotated(&q, ply.theta);
            for k in 0..6 {
                a[k] += qb[k] * ply.info.thickness;
            }
        }
        let Some(a_inv) = invert(&a) else { continue };
        walls.push(Wall { z, r: st.r[j] + t / 2.0, t, plies, a_inv });
    }
    if walls.is_empty() {
        out.message = Some("There is no wound wall in the part zone to analyse yet.".into());
        return out;
    }

    // ---- Load cases ----
    let run = |wall: &Wall, case: &LoadCase| -> (Solved, [f64; 3]) {
        line_loads(case, wall.r)
            .into_iter()
            .map(|n| (solve(wall, &q, &props, settings.criterion, settings.knockdown, n), n))
            .min_by(|a, b| a.0.rf.partial_cmp(&b.0.rf).unwrap())
            .unwrap()
    };
    out.stations = walls
        .iter()
        .map(|w| Station {
            z: w.z,
            wall: w.t,
            outer_diameter: 2.0 * (w.r + w.t / 2.0),
            plies: w.plies.iter().map(|p| p.info.clone()).collect(),
            cases: settings
                .load_cases
                .iter()
                .map(|case| {
                    let (s, n) = run(w, case);
                    StationCase {
                        rf: s.rf,
                        critical: s.critical,
                        hoop_stress: n[1] / w.t,
                        axial_stress: n[0] / w.t,
                        plies: s.plies,
                    }
                })
                .collect(),
        })
        .collect();
    for (c, case) in settings.load_cases.iter().enumerate() {
        let (station, min_rf) = out
            .stations
            .iter()
            .enumerate()
            .map(|(i, s)| (i, s.cases[c].rf))
            .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
            .unwrap();
        out.cases.push(CaseSummary { id: case.id.clone(), name: case.name.clone(), min_rf, station });
    }
    if let Some((i, c)) = out.cases.iter().enumerate().min_by(|a, b| a.1.min_rf.partial_cmp(&b.1.min_rf).unwrap()) {
        out.min_rf = Some(c.min_rf);
        out.governing_case = i;
    }

    // ---- Capacity under each basic load on its own ----
    let unit = |pressure: f64, bending_moment: f64, torque: f64| LoadCase {
        id: String::new(),
        name: String::new(),
        pressure,
        axial_force: 0.0,
        bending_moment,
        torque,
        closed_ends: true,
    };
    let weakest = |case: &LoadCase| walls.iter().map(|w| run(w, case).0.rf).fold(f64::MAX, f64::min);
    // Netting analysis: fibres alone carry the hoop and axial load.
    let netting = walls
        .iter()
        .map(|w| {
            let (mut hoop, mut axial) = (0.0, 0.0);
            for p in &w.plies {
                let (s, c) = p.theta.sin_cos();
                hoop += p.info.thickness * props.xt * s * s;
                axial += p.info.thickness * props.xt * c * c;
            }
            (hoop / w.r).min(2.0 * axial / w.r)
        })
        .fold(f64::MAX, f64::min);
    let length = z_b - z_a;
    let ei_min = walls.iter().map(|w| PI * w.r.powi(3) / w.a_inv[0][0]).fold(f64::MAX, f64::min);
    out.capacity = Capacity {
        // A 10 bar (1 MPa) unit case: reserve factor is then MPa at failure.
        pressure_bar: weakest(&unit(10.0, 0.0, 0.0)) * 10.0,
        netting_burst_bar: netting * settings.knockdown * 10.0,
        bending_nm: weakest(&unit(0.0, 1.0, 0.0)),
        torque_nm: weakest(&unit(0.0, 0.0, 1.0)),
        buckling_n: PI * PI * ei_min / (length * length),
    };

    // ---- Stiffness at mid-part ----
    let mid = 0.5 * (z_a + z_b);
    let w = walls.iter().min_by(|a, b| (a.z - mid).abs().partial_cmp(&(b.z - mid).abs()).unwrap()).unwrap();
    out.stiffness = Stiffness {
        ex: 1.0 / (w.a_inv[0][0] * w.t) / 1e3,
        e_hoop: 1.0 / (w.a_inv[1][1] * w.t) / 1e3,
        g: 1.0 / (w.a_inv[2][2] * w.t) / 1e3,
        ea: 2.0 * PI * w.r / w.a_inv[0][0],
        ei: PI * w.r.powi(3) / w.a_inv[0][0] / 1e6,
        gj: 2.0 * PI * w.r.powi(3) / w.a_inv[2][2] / 1e6,
    };
    out.ok = true;
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::plan;
    use crate::project::{AngleMode, LayerKind, PatternChoice};

    fn close(a: f64, b: f64, rel: f64) -> bool {
        (a - b).abs() <= rel * b.abs().max(1e-12)
    }

    /// A material with no directionality must behave like a metal tube.
    fn isotropic(e_gpa: f64, nu: f64, strength: f64) -> PlyProperties {
        PlyProperties {
            name: "iso".into(),
            e1: e_gpa,
            e2: e_gpa,
            g12: e_gpa / (2.0 * (1.0 + nu)),
            nu12: nu,
            xt: strength,
            xc: strength,
            yt: strength,
            yc: strength,
            s: strength,
            reference_vf: 0.0, // no volume-fraction scaling
        }
    }

    fn pressure_case(bar: f64, closed: bool) -> LoadCase {
        LoadCase {
            id: "p".into(),
            name: "p".into(),
            pressure: bar,
            axial_force: 0.0,
            bending_moment: 0.0,
            torque: 0.0,
            closed_ends: closed,
        }
    }

    #[test]
    fn isotropic_wall_matches_thin_tube_formulas() {
        let mut project = Project::example_tube();
        project.analysis.ply = isotropic(70.0, 0.3, 300.0);
        project.analysis.knockdown = 1.0;
        project.analysis.criterion = Criterion::MaxStress;
        project.analysis.load_cases = vec![pressure_case(20.0, false)];
        let plan = plan(&project);
        let a = analyze(&project, &plan);
        assert!(a.ok, "{:?}", a.message);
        // Moduli are direction-independent and equal to E.
        assert!(close(a.stiffness.ex, 70.0, 1e-9), "{}", a.stiffness.ex);
        assert!(close(a.stiffness.e_hoop, 70.0, 1e-9));
        assert!(close(a.stiffness.g, 70.0 / 2.6, 1e-9));
        // Hoop stress p r / t, and the reserve factor follows from it.
        let s = &a.stations[a.stations.len() / 2];
        let r = s.outer_diameter / 2.0 - s.wall / 2.0;
        let hoop = 2.0 * r / s.wall;
        assert!(close(s.cases[0].hoop_stress, hoop, 1e-9));
        // Principal stresses are (hoop, 0). The hoop ply, a degree or so off
        // 90, sees almost exactly the full hoop stress along its fibres.
        assert!(close(s.cases[0].rf, 300.0 / hoop, 2e-3), "{} vs {}", s.cases[0].rf, 300.0 / hoop);
        // EI of a thin ring: E pi r^3 t.
        assert!(close(a.stiffness.ei, 70e3 * PI * r.powi(3) * s.wall / 1e6, 1e-6));
    }

    #[test]
    fn unidirectional_and_angle_ply_moduli() {
        let p = PlyProperties::carbon_epoxy();
        let q = reduced_stiffness(&p);
        // 0 degree ply: axial modulus is E1, hoop modulus is E2.
        let a_inv = invert(&rotated(&q, 0.0)).unwrap();
        assert!(close(1.0 / a_inv[0][0], p.e1 * 1e3, 1e-9));
        assert!(close(1.0 / a_inv[1][1], p.e2 * 1e3, 1e-9));
        assert!(close(1.0 / a_inv[2][2], p.g12 * 1e3, 1e-9));
        // +-45 pair: shear modulus is (Q11 + Q22 - 2 Q12) / 4.
        let plus = rotated(&q, 45f64.to_radians());
        let minus = rotated(&q, -45f64.to_radians());
        let mut a = [0.0; 6];
        for k in 0..6 {
            a[k] = 0.5 * (plus[k] + minus[k]);
        }
        assert!(a[4].abs() < 1e-6 && a[5].abs() < 1e-6, "balanced: no shear coupling");
        let a_inv = invert(&a).unwrap();
        assert!(close(1.0 / a_inv[2][2], (q[0] + q[1] - 2.0 * q[2]) / 4.0, 1e-9));
    }

    #[test]
    fn failure_criteria_recover_the_uniaxial_strengths() {
        let p = PlyProperties::carbon_epoxy();
        for c in [Criterion::TsaiWu, Criterion::MaxStress] {
            assert!(close(ply_reserve(&p, c, p.xt / 2.0, 0.0, 0.0).0, 2.0, 1e-9));
            assert!(close(ply_reserve(&p, c, -p.xc / 4.0, 0.0, 0.0).0, 4.0, 1e-9));
            assert!(close(ply_reserve(&p, c, 0.0, p.yt, 0.0).0, 1.0, 1e-9));
            assert!(close(ply_reserve(&p, c, 0.0, -p.yc, 0.0).0, 1.0, 1e-9));
            assert!(close(ply_reserve(&p, c, 0.0, 0.0, p.s / 3.0).0, 3.0, 1e-9));
        }
        assert_eq!(ply_reserve(&p, Criterion::TsaiWu, 10.0, 39.0, 5.0).1, Mode::MatrixTension);
        assert_eq!(ply_reserve(&p, Criterion::MaxStress, -1100.0, 1.0, 5.0).1, Mode::FibreCompression);
    }

    fn helical_only(angle: f64) -> Project {
        let mut project = Project::example_tube();
        project.layers.truncate(2);
        project.layers.remove(0);
        project.layers[0].kind = LayerKind::Helical {
            angle_deg: angle,
            mode: AngleMode::Constant,
            coverage: 1.0,
            pattern: PatternChoice::Auto,
        };
        project.process.turnaround = crate::project::Turnaround::Pins;
        project
    }

    /// Netting analysis: at tan^2(a) = 2 (54.7 deg) the fibres carry hoop and
    /// axial pressure loads equally, the classic pressure-vessel angle.
    #[test]
    fn netting_optimum_is_54_7_degrees() {
        let burst = |angle: f64| {
            let project = helical_only(angle);
            analyze(&project, &plan(&project)).capacity.netting_burst_bar
        };
        let best = burst(54.74);
        // Per unit of wall, nothing nearby does better.
        let per_wall = |angle: f64| {
            let project = helical_only(angle);
            let a = analyze(&project, &plan(&project));
            a.capacity.netting_burst_bar / a.wall_thickness
        };
        assert!(best > 0.0);
        assert!(per_wall(54.74) > per_wall(45.0));
        assert!(per_wall(54.74) > per_wall(65.0));
    }

    #[test]
    fn examples_analyse_and_report_sensible_numbers() {
        for project in [Project::example_tube(), Project::example_cone()] {
            let plan = plan(&project);
            let a = analyze(&project, &plan);
            assert!(a.ok, "{:?}", a.message);
            let rf = a.min_rf.unwrap();
            assert!(rf > 0.1 && rf < 999.0, "rf {rf}");
            assert_eq!(a.cases.len(), 1);
            assert!(a.stations.iter().all(|s| s.z >= plan.mandrel.part_start && s.z <= plan.mandrel.part_end));
            // Thicknesses of the plies add up to the wall.
            for s in &a.stations {
                let sum: f64 = s.plies.iter().map(|p| p.thickness).sum();
                assert!(close(sum, s.wall, 1e-9));
            }
            assert!(a.stiffness.ex > 5.0 && a.stiffness.ex < 200.0);
            assert!(a.capacity.pressure_bar > 0.0 && a.capacity.netting_burst_bar > a.capacity.pressure_bar);
        }
    }

    #[test]
    fn capacity_is_consistent_with_a_load_case() {
        // Applying exactly the reported first-failure pressure gives RF = 1.
        let mut project = Project::example_tube();
        let cap = analyze(&project, &plan(&project)).capacity.pressure_bar;
        project.analysis.load_cases = vec![pressure_case(cap, true)];
        let a = analyze(&project, &plan(&project));
        assert!(close(a.min_rf.unwrap(), 1.0, 1e-6), "{}", a.min_rf.unwrap());
    }

    /// With open ends the load is pure hoop, so hoop fibre is what counts.
    /// (With closed ends, first failure is matrix cracking under the axial
    /// load, which extra hoop plies barely change.)
    #[test]
    fn more_hoop_fibre_raises_the_hoop_margin() {
        let mut base = Project::example_tube();
        base.analysis.load_cases = vec![pressure_case(20.0, false)];
        let mut more = base.clone();
        if let LayerKind::Hoop { plies } = &mut more.layers[2].kind {
            *plies = 3;
        }
        let run = |p: &Project| analyze(p, &plan(p));
        let (a, b) = (run(&base), run(&more));
        assert!(b.min_rf.unwrap() > a.min_rf.unwrap() * 1.3, "{:?} vs {:?}", b.min_rf, a.min_rf);
        assert!(b.stiffness.e_hoop > a.stiffness.e_hoop);
    }

    #[test]
    fn bending_checks_both_sides_and_is_sign_independent() {
        let mut project = Project::example_tube();
        let mut case = pressure_case(0.0, false);
        case.bending_moment = 50.0;
        project.analysis.load_cases = vec![case.clone()];
        let plus = analyze(&project, &plan(&project)).min_rf.unwrap();
        case.bending_moment = -50.0;
        project.analysis.load_cases = vec![case];
        let minus = analyze(&project, &plan(&project)).min_rf.unwrap();
        assert!(close(plus, minus, 1e-9));
        // Carbon is weaker in compression, so the compression side governs:
        // the margin is lower than tension alone would give.
        let mut tension = pressure_case(0.0, false);
        let a0 = analyze(&project, &plan(&project));
        let s = &a0.stations[0];
        let r = s.outer_diameter / 2.0 - s.wall / 2.0;
        tension.axial_force = 50.0 * 1e3 / (PI * r * r) * 2.0 * PI * r; // same line load, tension only
        project.analysis.load_cases = vec![tension];
        let tension_only = analyze(&project, &plan(&project)).min_rf.unwrap();
        assert!(plus <= tension_only + 1e-9);
    }

    #[test]
    fn knockdown_scales_the_reserve_factor() {
        let mut project = Project::example_tube();
        project.analysis.knockdown = 1.0;
        let full = analyze(&project, &plan(&project)).min_rf.unwrap();
        project.analysis.knockdown = 0.5;
        let half = analyze(&project, &plan(&project)).min_rf.unwrap();
        assert!(close(half, full * 0.5, 1e-9));
    }

    #[test]
    fn round_material_is_not_analysed() {
        let mut project = Project::example_tube();
        project.material = crate::project::Material::round("Rope", 3.0, 7.0, "#cccccc");
        let a = analyze(&project, &plan(&project));
        assert!(!a.ok);
        assert!(a.message.unwrap().contains("round material"));
        assert!(a.wall_thickness > 5.0, "the wall is still reported for comparison");
    }

    #[test]
    fn bad_inputs_are_reported_not_computed() {
        let mut project = Project::example_tube();
        project.analysis.ply.yt = 0.0;
        let a = analyze(&project, &plan(&project));
        assert!(!a.ok && a.message.is_some());
        let mut project = Project::example_tube();
        project.layers.clear();
        let a = analyze(&project, &plan(&project));
        assert!(!a.ok && a.message.unwrap().contains("no wound wall"));
    }
}
