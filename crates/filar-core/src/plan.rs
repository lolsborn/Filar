//! The planner: turns a [`Project`] into a complete, timed winding program.
//!
//! The result is a list of [`Block`]s. A block is a short list of samples
//! (fibre touch-down point plus the machine pose that produces it) that is
//! repeated `repeats` times, each repeat advancing the mandrel by `phi_step`.
//! A helical layer is one block repeated once per circuit; hoop passes and
//! the links between layers are blocks that run once.
//!
//! The same samples drive the 3D preview, the simulation and the G-code, so
//! what is simulated is exactly what is exported: one sample = one G-code
//! move, and the machine is assumed to interpolate linearly between them.

use std::f64::consts::{FRAC_PI_2, PI, TAU};

use serde::{Serialize, Serializer};

use crate::kinematics::{self, KinError};
use crate::mandrel::Profile;
use crate::path::{self, PathError, Prim};
use crate::pattern::{self, Pattern};
use crate::project::{AngleMode, LayerKind, PatternChoice, Project, Turnaround};

// ---------------------------------------------------------------- output --

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SegKind {
    TurnOut = 0,
    Body = 1,
    TurnIn = 2,
    Dwell = 3,
    Hoop = 4,
    Link = 5,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BlockKind {
    Helical,
    Hoop,
    Link,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Info,
    Warn,
    Error,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Warning {
    pub level: Level,
    pub layer_id: Option<String>,
    pub message: String,
}

fn round5<S: Serializer>(v: &[f64], s: S) -> Result<S::Ok, S::Error> {
    s.collect_seq(v.iter().map(|x| (x * 1e5).round() / 1e5))
}
fn round5_vec<S: Serializer>(v: &Vec<f64>, s: S) -> Result<S::Ok, S::Error> {
    round5(v, s)
}
fn kinds<S: Serializer>(v: &Vec<SegKind>, s: S) -> Result<S::Ok, S::Error> {
    s.collect_seq(v.iter().map(|k| *k as u8))
}
fn round5_opt<S: Serializer>(v: &Vec<Option<f64>>, s: S) -> Result<S::Ok, S::Error> {
    s.collect_seq(v.iter().map(|x| x.map(|x| (x * 1e3).round() / 1e3)))
}

/// Samples of one block repeat (struct of arrays). Sample `i` is the state at
/// time `t[i]`; `kind[i]` describes the move that *ends* at sample `i`.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Samples {
    /// Time since the start of the repeat (s).
    #[serde(serialize_with = "round5_vec")]
    pub t: Vec<f64>,
    /// Touch-down point: axial position (mm).
    #[serde(serialize_with = "round5_vec")]
    pub z: Vec<f64>,
    /// Touch-down point: mandrel radius there (mm).
    #[serde(serialize_with = "round5_vec")]
    pub r: Vec<f64>,
    /// Touch-down point: angle around the mandrel, cumulative (rad).
    #[serde(serialize_with = "round5_vec")]
    pub phi: Vec<f64>,
    /// Winding angle from the +z meridian, 0..pi (rad).
    #[serde(serialize_with = "round5_vec")]
    pub alpha: Vec<f64>,
    /// Carriage: eye position along the mandrel (mm).
    #[serde(serialize_with = "round5_vec")]
    pub x: Vec<f64>,
    /// Cross-feed: eye distance from the spindle axis (mm).
    #[serde(serialize_with = "round5_vec")]
    pub y: Vec<f64>,
    /// Spindle angle, cumulative (rad).
    #[serde(serialize_with = "round5_vec")]
    pub a: Vec<f64>,
    /// Eye rotation (rad).
    #[serde(serialize_with = "round5_vec")]
    pub b: Vec<f64>,
    #[serde(serialize_with = "kinds")]
    pub kind: Vec<SegKind>,
}

impl Samples {
    pub fn len(&self) -> usize {
        self.t.len()
    }
    pub fn is_empty(&self) -> bool {
        self.t.is_empty()
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub layer_index: usize,
    pub layer_id: String,
    pub kind: BlockKind,
    /// How many times the samples are run back to back.
    pub repeats: u32,
    /// Mandrel rotation added per repeat (rad); applies to `phi` and `a`.
    pub phi_step: f64,
    /// Duration of one repeat (s).
    pub duration: f64,
    /// Program time at which the block starts (s).
    pub t_start: f64,
    /// Fibre laid per repeat (mm).
    pub fiber_length: f64,
    /// Laminate thickness already on the mandrel under this block (mm).
    pub radial_base: f64,
    /// Thickness this block adds once complete (mm), mid-part.
    pub radial_build: f64,
    pub samples: Samples,
}

impl Block {
    pub fn t_end(&self) -> f64 {
        self.t_start + self.duration * self.repeats as f64
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LayerReport {
    pub id: String,
    pub name: String,
    pub kind: BlockKind,
    /// False if the layer could not be planned (see warnings).
    pub ok: bool,
    pub plies: u32,
    pub circuits: u32,
    pub pattern: Option<Pattern>,
    /// Alternative closed patterns the user may pick from.
    pub candidates: Vec<Pattern>,
    /// Winding angle at the head / tail end of the part (deg).
    pub angle_head_deg: f64,
    pub angle_tail_deg: f64,
    /// Axial length of the head / tail turnaround beyond the part (mm).
    pub turn_head: f64,
    pub turn_tail: f64,
    /// Largest slip tendency in the part zone (friction needed).
    pub max_slip: f64,
    /// Thickness added at mid-part (mm).
    pub thickness: f64,
    /// Coverage at the head / tail end of the part (1.0 = bands butt).
    pub coverage_head: f64,
    pub coverage_tail: f64,
    pub fiber_length: f64,
    pub duration: f64,
    pub t_start: f64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct StationLayer {
    pub layer_id: String,
    /// Thickness this layer adds at each station (mm).
    #[serde(serialize_with = "round5_vec")]
    pub thickness: Vec<f64>,
    /// Winding angle at each station (deg), where the layer exists.
    #[serde(serialize_with = "round5_opt")]
    pub angle: Vec<Option<f64>>,
}

/// Quantities sampled along the mandrel axis.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stations {
    #[serde(serialize_with = "round5_vec")]
    pub z: Vec<f64>,
    #[serde(serialize_with = "round5_vec")]
    pub r: Vec<f64>,
    #[serde(serialize_with = "round5_vec")]
    pub thickness: Vec<f64>,
    pub layers: Vec<StationLayer>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    /// Winding time (s), from axis speed limits; excludes acceleration.
    pub duration: f64,
    pub fiber_length_m: f64,
    pub fiber_mass_g: f64,
    pub resin_mass_g: f64,
    /// Laminate mass inside the part zone only (g).
    pub part_mass_g: f64,
    /// Wall thickness at mid-part (mm).
    pub wall_thickness: f64,
    pub ply_thickness: f64,
    pub spindle_turns: f64,
    pub moves: usize,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MandrelGeom {
    /// Meridian stations `[z, r]`.
    pub profile: Vec<[f64; 2]>,
    pub length: f64,
    pub max_radius: f64,
    pub part_start: f64,
    pub part_end: f64,
}

/// Range each axis travels over the whole program, in physical units
/// (mm, mm, deg, deg).
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub carriage: [f64; 2],
    pub crossfeed: [f64; 2],
    pub eye_deg: [f64; 2],
    pub spindle_deg: f64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub mandrel: MandrelGeom,
    pub blocks: Vec<Block>,
    pub layers: Vec<LayerReport>,
    pub stations: Stations,
    pub totals: Totals,
    pub envelope: Envelope,
    pub warnings: Vec<Warning>,
}

// ------------------------------------------------------------- internals --

/// A densely sampled fibre path in the mandrel frame (true angles).
#[derive(Default, Clone)]
struct Fine {
    z: Vec<f64>,
    phi: Vec<f64>,
    alpha: Vec<f64>,
    s: Vec<f64>,
    kind: Vec<SegKind>,
}

impl Fine {
    fn start(z: f64, alpha: f64, kind: SegKind) -> Self {
        Fine { z: vec![z], phi: vec![0.0], alpha: vec![alpha], s: vec![0.0], kind: vec![kind] }
    }
    fn last_phi(&self) -> f64 {
        *self.phi.last().unwrap()
    }
    fn last_s(&self) -> f64 {
        *self.s.last().unwrap()
    }
    fn push(&mut self, z: f64, phi: f64, alpha: f64, s: f64, kind: SegKind) {
        let n = self.z.len();
        if n > 0
            && (self.z[n - 1] - z).abs() < 1e-9
            && (self.alpha[n - 1] - alpha).abs() < 1e-9
            && (self.phi[n - 1] - phi).abs() < 1e-12
        {
            return; // identical state, nothing to do
        }
        self.z.push(z);
        self.phi.push(phi);
        self.alpha.push(alpha);
        self.s.push(s);
        self.kind.push(kind);
    }

    /// Append a travel-frame primitive. `reverse` plays it backwards (the
    /// mirror-image exit from a turn, or a return pass); `plus` says whether
    /// the fibre is heading towards +z while it does so.
    fn append(&mut self, p: &Prim, reverse: bool, plus: bool, kind: SegKind) {
        let phi0 = self.last_phi();
        let s0 = self.last_s();
        let n = p.len();
        let true_angle = |a: f64| if plus { a } else { PI - a };
        for j in 0..n {
            if reverse {
                let i = n - 1 - j;
                self.push(
                    p.z[i],
                    phi0 + p.total_phi() - p.phi[i],
                    true_angle(p.alpha[i]),
                    s0 + p.total_s() - p.s[i],
                    kind,
                );
            } else {
                self.push(p.z[j], phi0 + p.phi[j], true_angle(p.alpha[j]), s0 + p.s[j], kind);
            }
        }
    }

    fn dwell(&mut self, profile: &Profile, angle: f64) {
        if angle <= 1e-12 {
            return;
        }
        let z = *self.z.last().unwrap();
        let r = profile.radius(z);
        self.push(z, self.last_phi() + angle, FRAC_PI_2, self.last_s() + r * angle, SegKind::Dwell);
    }

    /// Make sure the path ends running purely hoop-wise.
    fn settle(&mut self, kind: SegKind) {
        let z = *self.z.last().unwrap();
        self.push(z, self.last_phi(), FRAC_PI_2, self.last_s(), kind);
    }
}

/// A fine path with machine poses and timing attached.
struct Track {
    fine: Fine,
    x: Vec<f64>,
    rho: Vec<f64>,
    a: Vec<f64>,
    b: Vec<f64>,
    t: Vec<f64>,
}

struct Ctx<'a> {
    project: &'a Project,
    profile: Profile,
    z_a: f64,
    z_b: f64,
    step: f64,
}

fn track(ctx: &Ctx, fine: Fine, phi_offset: f64) -> Result<Track, KinError> {
    let m = &ctx.project.machine;
    let n = fine.z.len();
    let mut tr = Track {
        x: Vec::with_capacity(n),
        rho: Vec::with_capacity(n),
        a: Vec::with_capacity(n),
        b: Vec::with_capacity(n),
        t: Vec::with_capacity(n),
        fine,
    };
    for i in 0..n {
        tr.fine.phi[i] += phi_offset;
        let pose =
            kinematics::solve(&ctx.profile, m, tr.fine.z[i], tr.fine.phi[i], tr.fine.alpha[i])?;
        tr.x.push(pose.x);
        tr.rho.push(pose.rho);
        tr.a.push(pose.a);
        tr.b.push(pose.b);
    }
    // Time: the slowest of "lay fibre at the target speed" and each axis
    // running at its own limit.
    let v_fiber = ctx.project.process.fiber_speed.max(1e-3);
    let lim = |speed: f64| speed.max(1e-6);
    tr.t.push(0.0);
    for i in 1..n {
        let mut dt = (tr.fine.s[i] - tr.fine.s[i - 1]).abs() / v_fiber;
        dt = dt.max((tr.x[i] - tr.x[i - 1]).abs() / lim(m.carriage.max_speed));
        dt = dt.max((tr.a[i] - tr.a[i - 1]).abs().to_degrees() / lim(m.spindle.max_speed));
        if m.crossfeed.enabled {
            dt = dt.max((tr.rho[i] - tr.rho[i - 1]).abs() / lim(m.crossfeed.max_speed));
        }
        if m.eye.enabled {
            dt = dt.max((tr.b[i] - tr.b[i - 1]).abs().to_degrees() / lim(m.eye.max_speed));
        }
        tr.t.push(tr.t[i - 1] + dt.max(1e-4));
    }
    Ok(tr)
}

/// Pick the samples that are needed to reproduce the track to within
/// tolerance when everything is interpolated linearly in time
/// (Ramer-Douglas-Peucker across all channels at once).
fn simplify(tr: &Track, r_max: f64) -> Vec<usize> {
    let n = tr.t.len();
    if n <= 2 {
        return (0..n).collect();
    }
    const LIN_TOL: f64 = 0.03; // mm
    let ang_tol = LIN_TOL / r_max; // rad, same arc length at the surface
    const STEER_TOL: f64 = 0.004; // rad (~0.23 deg) for winding / eye angle
    let chans: [(&[f64], f64); 7] = [
        (&tr.fine.z, LIN_TOL),
        (&tr.fine.phi, ang_tol),
        (&tr.fine.alpha, STEER_TOL),
        (&tr.x, LIN_TOL),
        (&tr.rho, LIN_TOL),
        (&tr.a, ang_tol),
        (&tr.b, STEER_TOL),
    ];
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    // Never merge across a change of segment kind.
    for i in 1..n - 1 {
        if tr.fine.kind[i + 1] != tr.fine.kind[i] {
            keep[i] = true;
        }
    }
    let forced: Vec<usize> = (0..n).filter(|i| keep[*i]).collect();
    let mut stack: Vec<(usize, usize)> = forced.windows(2).map(|w| (w[0], w[1])).collect();
    while let Some((i0, i1)) = stack.pop() {
        if i1 <= i0 + 1 {
            continue;
        }
        let span = tr.t[i1] - tr.t[i0];
        let mut worst = 0.0;
        let mut at = i0;
        for j in i0 + 1..i1 {
            let u = (tr.t[j] - tr.t[i0]) / span;
            for (c, tol) in chans.iter() {
                let e = (c[j] - (c[i0] + (c[i1] - c[i0]) * u)).abs() / tol;
                if e > worst {
                    worst = e;
                    at = j;
                }
            }
        }
        if worst > 1.0 {
            keep[at] = true;
            stack.push((i0, at));
            stack.push((at, i1));
        }
    }
    (0..n).filter(|i| keep[*i]).collect()
}

fn samples(ctx: &Ctx, tr: &Track, idx: &[usize]) -> Samples {
    let pick = |v: &[f64]| idx.iter().map(|i| v[*i]).collect::<Vec<f64>>();
    Samples {
        t: pick(&tr.t),
        z: pick(&tr.fine.z),
        r: idx.iter().map(|i| ctx.profile.radius(tr.fine.z[*i])).collect(),
        phi: pick(&tr.fine.phi),
        alpha: pick(&tr.fine.alpha),
        x: pick(&tr.x),
        y: pick(&tr.rho),
        a: pick(&tr.a),
        b: pick(&tr.b),
        kind: idx.iter().map(|i| tr.fine.kind[*i]).collect(),
    }
}

/// Thickness bookkeeping along the axis.
struct Bins {
    n: usize,
    z0: f64,
    dz: f64,
    /// Strip area of each bin (mm^2).
    area: Vec<f64>,
}

impl Bins {
    fn new(profile: &Profile, n: usize) -> Self {
        let z0 = profile.z_min();
        let dz = (profile.z_max() - z0) / n as f64;
        let area = (0..n)
            .map(|i| {
                let z = z0 + (i as f64 + 0.5) * dz;
                let slope = profile.slope(z, 1.0);
                TAU * profile.radius(z) * dz * (1.0 + slope * slope).sqrt()
            })
            .collect();
        Bins { n, z0, dz, area }
    }
    fn centre(&self, i: usize) -> f64 {
        self.z0 + (i as f64 + 0.5) * self.dz
    }
    fn index(&self, z: f64) -> usize {
        (((z - self.z0) / self.dz).floor().max(0.0) as usize).min(self.n - 1)
    }

    /// Thickness added by `repeats` runs of a fine path (mm per bin).
    ///
    /// Every step deposits its length of band; the band's own width is
    /// spread across the stations it covers, which keeps the pile-up at the
    /// turnaround apex finite and realistic.
    fn deposit(&self, profile: &Profile, f: &Fine, band_area: f64, band_width: f64, repeats: f64) -> Vec<f64> {
        let mut vol = vec![0.0; self.n];
        for i in 1..f.z.len() {
            let ds = f.s[i] - f.s[i - 1];
            if ds <= 0.0 {
                continue;
            }
            let zm = 0.5 * (f.z[i] + f.z[i - 1]);
            let am = 0.5 * (f.alpha[i] + f.alpha[i - 1]);
            let slope = profile.slope(zm, 1.0);
            let cg = 1.0 / (1.0 + slope * slope).sqrt();
            let half = 0.5 * band_width * am.sin().abs() * cg;
            // Clamp to the mandrel so nothing is lost off the ends.
            let z_end = self.z0 + self.n as f64 * self.dz;
            let lo = (f.z[i].min(f.z[i - 1]) - half).clamp(self.z0, z_end - 1e-6);
            let hi = (f.z[i].max(f.z[i - 1]) + half).clamp(lo + 1e-6, z_end);
            let extent = hi - lo;
            let v = ds * band_area * repeats;
            let (b0, b1) = (self.index(lo), self.index(hi));
            for b in b0..=b1 {
                let cell_lo = self.z0 + b as f64 * self.dz;
                let overlap = (hi.min(cell_lo + self.dz) - lo.max(cell_lo)).max(0.0);
                vol[b] += v * overlap / extent;
            }
        }
        vol.iter().zip(&self.area).map(|(v, a)| v / a).collect()
    }
}

fn interp(xs: &[f64], ys: &[f64], x: f64) -> Option<f64> {
    if xs.is_empty() || x < xs[0] - 1e-9 || x > xs[xs.len() - 1] + 1e-9 {
        return None;
    }
    let i = xs.partition_point(|v| *v < x).clamp(1, xs.len() - 1);
    let (x0, x1) = (xs[i - 1], xs[i]);
    if (x1 - x0).abs() < 1e-12 {
        return Some(ys[i]);
    }
    Some(ys[i - 1] + (ys[i] - ys[i - 1]) * (x - x0) / (x1 - x0))
}

struct Built {
    kind: BlockKind,
    fine: Fine,
    repeats: u32,
    phi_step: f64,
    /// Where the fibre is when the block finishes.
    end_z: f64,
    report: LayerReport,
    /// Forward-pass angle law `(z ascending, alpha)` for the station table.
    angle_law: (Vec<f64>, Vec<f64>),
}

fn empty_report(id: &str, name: &str, kind: BlockKind) -> LayerReport {
    LayerReport {
        id: id.into(),
        name: name.into(),
        kind,
        ok: false,
        plies: 0,
        circuits: 0,
        pattern: None,
        candidates: vec![],
        angle_head_deg: 0.0,
        angle_tail_deg: 0.0,
        turn_head: 0.0,
        turn_tail: 0.0,
        max_slip: 0.0,
        thickness: 0.0,
        coverage_head: 0.0,
        coverage_tail: 0.0,
        fiber_length: 0.0,
        duration: 0.0,
        t_start: 0.0,
    }
}

#[allow(clippy::too_many_arguments)]
fn build_helical(
    ctx: &Ctx,
    id: &str,
    name: &str,
    angle_deg: f64,
    mode: AngleMode,
    coverage: f64,
    choice: &PatternChoice,
    z_cur: Option<f64>,
    warn: &mut Vec<Warning>,
) -> Result<Built, String> {
    let p = ctx.project;
    let profile = &ctx.profile;
    if !(angle_deg >= 3.0 && angle_deg <= 87.0) {
        return Err(format!(
            "Helical angle must be between 3° and 87° (got {angle_deg:.1}°). Use a hoop layer for near-90° winding."
        ));
    }
    let alpha = angle_deg.to_radians();
    let mut push = |level, message: String| {
        warn.push(Warning { level, layer_id: Some(id.into()), message })
    };

    // ---- Forward half: head turn, body, tail turn ----
    let body = match mode {
        AngleMode::Constant => path::constant_angle(profile, ctx.z_a, ctx.z_b, ctx.step, alpha),
        AngleMode::Geodesic => match path::geodesic(profile, ctx.z_a, ctx.z_b, ctx.step, alpha) {
            Ok(b) => b,
            Err(PathError::GeodesicTurnsBack { max_angle }) => {
                return Err(format!(
                    "A geodesic at {angle_deg:.1}° turns back before it reaches the small end. \
                     Keep the angle at or below {:.1}°, or switch to constant-angle mode.",
                    max_angle.to_degrees()
                ));
            }
            Err(e) => return Err(format!("{e:?}")),
        },
    };
    let a_head = body.alpha[0];
    let a_tail = *body.alpha.last().unwrap();
    let mu = p.process.friction;
    let make_turn = |z: f64, a: f64, dir: f64| -> Result<Prim, String> {
        match p.process.turnaround {
            Turnaround::Pins => Ok(path::pin_turn(z, a)),
            Turnaround::Friction => path::turn_in(profile, z, a, dir, mu)
                .map_err(|_| "The friction turnaround did not converge; try a pin ring.".to_string()),
        }
    };
    let th = make_turn(ctx.z_a, a_head, -1.0)?;
    let tt = make_turn(ctx.z_b, a_tail, 1.0)?;
    let apex_head = th.end_z();
    let apex_tail = tt.end_z();

    if p.process.turnaround == Turnaround::Friction {
        for (apex, limit, label, over) in [
            (apex_head, profile.z_min(), "head", profile.z_min() - apex_head),
            (apex_tail, profile.z_max(), "tail", apex_tail - profile.z_max()),
        ] {
            let _ = (apex, limit);
            if over > 0.05 {
                push(
                    Level::Error,
                    format!(
                        "The {label} turnaround runs {over:.0} mm off the end of the mandrel. \
                         Increase the {label} margin or extension, raise the winding angle, or use a pin ring."
                    ),
                );
            }
        }
    }
    let slip = body.max_lambda();
    if slip > mu + 1e-9 {
        push(
            Level::Warn,
            format!(
                "Holding {angle_deg:.1}° on this taper needs a friction coefficient of {slip:.2}, \
                 above the available {mu:.2}. The fibre is likely to slip towards the small end; \
                 use geodesic mode or a steeper angle."
            ),
        );
    }

    // ---- Pattern ----
    let band = p.material.band_width;
    let normal_circ = |z: f64, a: f64| TAU * profile.radius(z) * a.cos();
    let max_nc = (0..body.len()).map(|i| normal_circ(body.z[i], body.alpha[i])).fold(0.0, f64::max);
    let n_min = pattern::circuits_for_coverage(max_nc, band, coverage);
    let phi_nat = 2.0 * (th.total_phi() + body.total_phi() + tt.total_phi());
    let min_dwell = p.process.min_dwell_deg.max(0.0).to_radians();
    let mut cands = pattern::candidates(n_min, 3, phi_nat, min_dwell, max_nc, band);
    let chosen = match choice {
        PatternChoice::Manual { circuits, skip }
            if *circuits >= 1
                && (*circuits == 1 || (*skip >= 1 && skip < circuits))
                && cands.iter().any(|c| c.circuits == *circuits && c.skip == *skip) =>
        {
            pattern::solve(*circuits, *skip, phi_nat, min_dwell, max_nc, band)
        }
        PatternChoice::Manual { circuits, skip } => {
            push(
                Level::Info,
                format!(
                    "Pattern {circuits}/{skip} no longer fits this geometry (it needs at least {n_min} circuits); using the automatic pattern."
                ),
            );
            pattern::auto_select(&cands, n_min).ok_or("no closed pattern exists")?
        }
        PatternChoice::Auto => pattern::auto_select(&cands, n_min).ok_or("no closed pattern exists")?,
    };
    // Keep the table readable: modest diamond counts only, best first.
    cands.retain(|c| c.pattern_number <= 16 || (c.circuits == chosen.circuits && c.skip == chosen.skip));
    cands.sort_by(|a, b| {
        (a.circuits, a.pattern_number)
            .cmp(&(b.circuits, b.pattern_number))
            .then(a.dwell.partial_cmp(&b.dwell).unwrap())
    });

    // ---- One circuit ----
    let from_tail = match z_cur {
        Some(z) => (z - apex_tail).abs() < (z - apex_head).abs(),
        None => false,
    };
    let half_dwell = chosen.dwell * 0.5;
    let mut fine;
    if !from_tail {
        fine = Fine::start(apex_head, FRAC_PI_2, SegKind::TurnOut);
        fine.append(&th, true, true, SegKind::TurnOut);
        fine.append(&body, false, true, SegKind::Body);
        fine.append(&tt, false, true, SegKind::TurnIn);
        fine.dwell(profile, half_dwell);
        fine.append(&tt, true, false, SegKind::TurnOut);
        fine.append(&body, true, false, SegKind::Body);
        fine.append(&th, false, false, SegKind::TurnIn);
        fine.dwell(profile, half_dwell);
    } else {
        fine = Fine::start(apex_tail, FRAC_PI_2, SegKind::TurnOut);
        fine.append(&tt, true, false, SegKind::TurnOut);
        fine.append(&body, true, false, SegKind::Body);
        fine.append(&th, false, false, SegKind::TurnIn);
        fine.dwell(profile, half_dwell);
        fine.append(&th, true, true, SegKind::TurnOut);
        fine.append(&body, false, true, SegKind::Body);
        fine.append(&tt, false, true, SegKind::TurnIn);
        fine.dwell(profile, half_dwell);
    }
    fine.settle(SegKind::TurnIn);
    debug_assert!((fine.last_phi() - chosen.phi_circuit).abs() < 1e-6);

    // Angle law over the whole forward pass, ascending in z.
    let mut law_z = Vec::new();
    let mut law_a = Vec::new();
    for i in (0..th.len()).rev() {
        law_z.push(th.z[i]);
        law_a.push(th.alpha[i]);
    }
    for i in 0..body.len() {
        law_z.push(body.z[i]);
        law_a.push(body.alpha[i]);
    }
    for i in 0..tt.len() {
        law_z.push(tt.z[i]);
        law_a.push(tt.alpha[i]);
    }

    let n = chosen.circuits as f64;
    let mut report = empty_report(id, name, BlockKind::Helical);
    report.ok = true;
    report.plies = 2;
    report.circuits = chosen.circuits;
    report.angle_head_deg = a_head.to_degrees();
    report.angle_tail_deg = a_tail.to_degrees();
    report.turn_head = ctx.z_a - apex_head;
    report.turn_tail = apex_tail - ctx.z_b;
    report.max_slip = slip;
    report.coverage_head = n * band / normal_circ(ctx.z_a, a_head);
    report.coverage_tail = n * band / normal_circ(ctx.z_b, a_tail);
    report.pattern = Some(chosen.clone());
    report.candidates = cands;

    Ok(Built {
        kind: BlockKind::Helical,
        end_z: if from_tail { apex_tail } else { apex_head },
        fine,
        repeats: chosen.circuits,
        phi_step: chosen.phi_circuit,
        report,
        angle_law: (law_z, law_a),
    })
}

fn build_hoop(
    ctx: &Ctx,
    id: &str,
    name: &str,
    plies: u32,
    z_cur: Option<f64>,
    warn: &mut Vec<Warning>,
) -> Result<Built, String> {
    if plies == 0 {
        return Err("A hoop layer needs at least one ply.".into());
    }
    let p = ctx.project;
    let profile = &ctx.profile;
    let pitch = p.material.band_width;
    let from_tail = match z_cur {
        Some(z) => (z - ctx.z_b).abs() < (z - ctx.z_a).abs(),
        None => false,
    };
    let fwd = path::hoop(profile, ctx.z_a, ctx.z_b, ctx.step.max(1.0), pitch);
    let back = path::hoop(profile, ctx.z_b, ctx.z_a, ctx.step.max(1.0), pitch);
    let slip = fwd.max_lambda();
    if slip > p.process.friction + 1e-9 {
        warn.push(Warning {
            level: Level::Warn,
            layer_id: Some(id.into()),
            message: format!(
                "Hoop winding on this taper needs a friction coefficient of {slip:.2}, above the available {:.2}; the band will tend to slide towards the small end.",
                p.process.friction
            ),
        });
    }

    let start = if from_tail { ctx.z_b } else { ctx.z_a };
    let mut fine = Fine::start(start, FRAC_PI_2, SegKind::Hoop);
    let mut heading_plus = !from_tail;
    for _ in 0..plies {
        if heading_plus {
            fine.append(&fwd, false, true, SegKind::Hoop);
        } else {
            fine.append(&back, false, false, SegKind::Hoop);
        }
        heading_plus = !heading_plus;
    }
    fine.settle(SegKind::Hoop);
    let end_z = *fine.z.last().unwrap();

    let mut report = empty_report(id, name, BlockKind::Hoop);
    report.ok = true;
    report.plies = plies;
    report.circuits = plies;
    report.angle_head_deg = fwd.alpha[0].to_degrees();
    report.angle_tail_deg = fwd.alpha.last().unwrap().to_degrees();
    report.max_slip = slip;
    report.coverage_head = 1.0;
    report.coverage_tail = 1.0;

    Ok(Built {
        kind: BlockKind::Hoop,
        end_z,
        fine,
        repeats: 1,
        phi_step: 0.0,
        report,
        angle_law: (fwd.z.clone(), fwd.alpha.clone()),
    })
}

fn validate(p: &Project) -> Vec<String> {
    let mut e = Vec::new();
    let m = &p.mandrel;
    if !(m.start_diameter > 1.0 && m.end_diameter > 1.0) {
        e.push("Mandrel diameters must be larger than 1 mm.".into());
    }
    if !(m.length > 1.0) {
        e.push("Mandrel length must be larger than 1 mm.".into());
    }
    if m.head_extension < 0.0 || m.tail_extension < 0.0 {
        e.push("Mandrel extensions cannot be negative.".into());
    }
    if p.zone.head_margin < 0.0 || p.zone.tail_margin < 0.0 {
        e.push("Margins cannot be negative.".into());
    }
    if m.total_length() - p.zone.head_margin - p.zone.tail_margin < 5.0 {
        e.push("The margins leave no room for a part; reduce them or lengthen the mandrel.".into());
    }
    let mat = &p.material;
    if !(mat.band_width > 0.1) {
        e.push("Band width must be larger than 0.1 mm.".into());
    }
    if mat.tows == 0 || !(mat.tex > 0.0) {
        e.push("Strand count and weight must be positive.".into());
    }
    // Densities and volume fraction only describe a flat band.
    if mat.shape == crate::project::Shape::Flat {
        if !(mat.fiber_density > 0.0) || !(mat.resin_density > 0.0) {
            e.push("Fibre and resin densities must be positive.".into());
        }
        if !(mat.fiber_volume_fraction > 0.05 && mat.fiber_volume_fraction <= 0.95) {
            e.push("Fibre volume fraction must be between 0.05 and 0.95.".into());
        }
    }
    if !(p.process.friction > 0.0) {
        e.push("Friction coefficient must be positive.".into());
    }
    if !(p.process.fiber_speed > 0.0) {
        e.push("Fibre speed must be positive.".into());
    }
    let mc = &p.machine;
    for (ax, label) in [(&mc.carriage, "Carriage"), (&mc.spindle, "Spindle")] {
        if !(ax.max_speed > 0.0) {
            e.push(format!("{label} maximum speed must be positive."));
        }
    }
    e
}

// ------------------------------------------------------------------ plan --

pub fn plan(project: &Project) -> Plan {
    let mut out = Plan::default();
    let profile = Profile::from_mandrel(&project.mandrel);
    let length = project.mandrel.total_length();
    let z_a = project.zone.head_margin;
    let z_b = length - project.zone.tail_margin;
    out.mandrel = MandrelGeom {
        profile: profile.points().iter().map(|p| [p.0, p.1]).collect(),
        length,
        max_radius: profile.max_radius(),
        part_start: z_a,
        part_end: z_b,
    };

    let problems = validate(project);
    if !problems.is_empty() {
        out.warnings = problems
            .into_iter()
            .map(|message| Warning { level: Level::Error, layer_id: None, message })
            .collect();
        return out;
    }

    let ctx = Ctx {
        project,
        profile,
        z_a,
        z_b,
        step: ((z_b - z_a) / 400.0).clamp(0.25, 2.0),
    };
    let profile = &ctx.profile;
    let mat = &project.material;
    let machine = &project.machine;
    let r_max = profile.max_radius();
    let bins = Bins::new(profile, 240);
    let mid_bin = bins.index(0.5 * (z_a + z_b));

    out.stations.z = (0..bins.n).map(|i| bins.centre(i)).collect();
    out.stations.r = out.stations.z.iter().map(|z| profile.radius(*z)).collect();
    out.stations.thickness = vec![0.0; bins.n];

    let mut z_cur: Option<f64> = None;
    let mut phi_cur = 0.0;
    let mut t_cur = 0.0;
    let mut kin_failed = false;

    for (layer_index, layer) in project.layers.iter().enumerate() {
        if !layer.enabled {
            continue;
        }
        let built = match &layer.kind {
            LayerKind::Helical { angle_deg, mode, coverage, pattern } => build_helical(
                &ctx,
                &layer.id,
                &layer.name,
                *angle_deg,
                *mode,
                coverage.clamp(0.2, 4.0),
                pattern,
                z_cur,
                &mut out.warnings,
            ),
            LayerKind::Hoop { plies } => {
                build_hoop(&ctx, &layer.id, &layer.name, *plies, z_cur, &mut out.warnings)
            }
        };
        let built = match built {
            Ok(b) => b,
            Err(message) => {
                out.warnings.push(Warning {
                    level: Level::Error,
                    layer_id: Some(layer.id.clone()),
                    message,
                });
                let kind = match layer.kind {
                    LayerKind::Helical { .. } => BlockKind::Helical,
                    LayerKind::Hoop { .. } => BlockKind::Hoop,
                };
                out.layers.push(empty_report(&layer.id, &layer.name, kind));
                out.stations.layers.push(StationLayer {
                    layer_id: layer.id.clone(),
                    thickness: vec![0.0; bins.n],
                    angle: vec![None; bins.n],
                });
                continue;
            }
        };

        let radial_base = out.stations.thickness[mid_bin];
        let layer_t_start = t_cur;
        let mut layer_fiber = 0.0;
        let mut layer_thk = vec![0.0; bins.n];

        // Link from wherever the fibre is to where this layer starts.
        let start_z = built.fine.z[0];
        let mut pieces: Vec<(BlockKind, Fine, u32, f64)> = Vec::new();
        if let Some(z) = z_cur {
            if (z - start_z).abs() > 1e-6 {
                let link = path::hoop(profile, z, start_z, ctx.step.max(1.0), mat.band_width);
                let mut f = Fine::start(z, FRAC_PI_2, SegKind::Link);
                f.append(&link, false, start_z > z, SegKind::Link);
                f.settle(SegKind::Link);
                pieces.push((BlockKind::Link, f, 1, 0.0));
            }
        }
        pieces.push((built.kind, built.fine, built.repeats, built.phi_step));

        for (kind, fine, repeats, phi_step) in pieces {
            let thk = bins.deposit(profile, &fine, mat.band_area(), mat.band_width, repeats as f64);
            for (acc, t) in layer_thk.iter_mut().zip(&thk) {
                *acc += t;
            }
            let tr = match track(&ctx, fine, phi_cur) {
                Ok(tr) => tr,
                Err(KinError::EyeInsideMandrel { needed }) => {
                    if !kin_failed {
                        out.warnings.push(Warning {
                            level: Level::Error,
                            layer_id: None,
                            message: format!(
                                "The delivery eye is inside the mandrel: the eye distance must exceed the mandrel radius ({needed:.1} mm)."
                            ),
                        });
                    }
                    kin_failed = true;
                    continue;
                }
            };
            let idx = simplify(&tr, r_max);
            let s = samples(&ctx, &tr, &idx);
            let duration = *s.t.last().unwrap();
            let fiber_length = tr.fine.last_s();
            let phi_end = tr.fine.last_phi();
            let step = if kind == BlockKind::Helical { phi_step } else { 0.0 };
            let block = Block {
                layer_index,
                layer_id: layer.id.clone(),
                kind,
                repeats,
                phi_step: step,
                duration,
                t_start: t_cur,
                fiber_length,
                radial_base,
                radial_build: 0.0,
                samples: s,
            };
            t_cur = block.t_end();
            layer_fiber += fiber_length * repeats as f64;
            // After all repeats the fibre has advanced by repeats * phi_step
            // in total (the final repeat's own sweep is part of that).
            phi_cur = if kind == BlockKind::Helical {
                phi_cur + step * repeats as f64
            } else {
                phi_end
            };
            out.blocks.push(block);
        }
        z_cur = Some(built.end_z);

        // Reports and station tables.
        let build = layer_thk[mid_bin];
        for b in out.blocks.iter_mut().rev().take_while(|b| b.layer_index == layer_index) {
            b.radial_build = build;
        }
        for (acc, t) in out.stations.thickness.iter_mut().zip(&layer_thk) {
            *acc += t;
        }
        let (law_z, law_a) = &built.angle_law;
        let angle = out
            .stations
            .z
            .iter()
            .map(|z| interp(law_z, law_a, *z).map(f64::to_degrees))
            .collect();
        out.stations.layers.push(StationLayer { layer_id: layer.id.clone(), thickness: layer_thk, angle });

        let mut report = built.report;
        report.thickness = build;
        report.fiber_length = layer_fiber;
        report.duration = t_cur - layer_t_start;
        report.t_start = layer_t_start;
        out.layers.push(report);
    }

    // ---- Totals ----
    let total_fiber: f64 = out.blocks.iter().map(|b| b.fiber_length * b.repeats as f64).sum();
    let part_volume: f64 = (0..bins.n)
        .filter(|i| {
            let z = bins.centre(*i);
            z >= z_a && z <= z_b
        })
        .map(|i| out.stations.thickness[i] * bins.area[i])
        .sum();
    out.totals = Totals {
        duration: t_cur,
        fiber_length_m: total_fiber / 1000.0,
        fiber_mass_g: total_fiber * mat.fiber_mass_per_mm(),
        resin_mass_g: total_fiber * mat.resin_mass_per_mm(),
        part_mass_g: part_volume * mat.deposit_density(),
        wall_thickness: out.stations.thickness[mid_bin],
        ply_thickness: mat.ply_thickness(),
        spindle_turns: phi_cur / TAU,
        moves: out.blocks.iter().map(|b| (b.samples.len().saturating_sub(1)) * b.repeats as usize).sum(),
    };

    // ---- Envelope and soft limits ----
    if !out.blocks.is_empty() {
        let mut env = Envelope {
            carriage: [f64::MAX, f64::MIN],
            crossfeed: [f64::MAX, f64::MIN],
            eye_deg: [f64::MAX, f64::MIN],
            spindle_deg: phi_cur.to_degrees(),
        };
        for b in &out.blocks {
            for i in 0..b.samples.len() {
                env.carriage[0] = env.carriage[0].min(b.samples.x[i]);
                env.carriage[1] = env.carriage[1].max(b.samples.x[i]);
                env.crossfeed[0] = env.crossfeed[0].min(b.samples.y[i]);
                env.crossfeed[1] = env.crossfeed[1].max(b.samples.y[i]);
                env.eye_deg[0] = env.eye_deg[0].min(b.samples.b[i].to_degrees());
                env.eye_deg[1] = env.eye_deg[1].max(b.samples.b[i].to_degrees());
            }
        }
        let mut check = |axis: &crate::machine::Axis, range: [f64; 2], label: &str, unit: &str| {
            if !axis.enabled {
                return;
            }
            let (m0, m1) = (axis.to_machine(range[0]), axis.to_machine(range[1]));
            let (lo, hi) = (m0.min(m1), m0.max(m1));
            let below = axis.min.is_some_and(|min| lo < min - 1e-6);
            let above = axis.max.is_some_and(|max| hi > max + 1e-6);
            if below || above {
                let fmt = |v: Option<f64>| v.map(|v| format!("{v:.1}")).unwrap_or_else(|| "∞".into());
                out.warnings.push(Warning {
                    level: Level::Error,
                    layer_id: None,
                    message: format!(
                        "{label} axis ({}) needs {lo:.1} to {hi:.1} {unit}, outside its limits of {} to {} {unit}.",
                        axis.letter,
                        fmt(axis.min),
                        fmt(axis.max)
                    ),
                });
            }
        };
        check(&machine.carriage, env.carriage, "Carriage", "mm");
        check(&machine.crossfeed, env.crossfeed, "Cross-feed", "mm");
        check(&machine.eye, env.eye_deg, "Eye rotation", "°");
        if !machine.crossfeed.enabled && machine.eye_distance < r_max + 5.0 {
            out.warnings.push(Warning {
                level: Level::Warn,
                layer_id: None,
                message: format!(
                    "The delivery eye clears the mandrel by only {:.1} mm.",
                    machine.eye_distance - r_max
                ),
            });
        }
        out.envelope = env;
    }

    if project.layers.iter().all(|l| !l.enabled) {
        out.warnings.push(Warning {
            level: Level::Info,
            layer_id: None,
            message: "Add a layer to start winding.".into(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::*;

    fn errors(p: &Plan) -> Vec<&Warning> {
        p.warnings.iter().filter(|w| w.level == Level::Error).collect()
    }

    #[test]
    fn example_tube_plans_cleanly() {
        let plan = plan(&Project::example_tube());
        assert!(errors(&plan).is_empty(), "{:?}", plan.warnings);
        assert_eq!(plan.layers.len(), 3);
        assert!(plan.layers.iter().all(|l| l.ok));
        assert!(plan.totals.duration > 60.0);
        assert!(plan.totals.fiber_length_m > 10.0);
    }

    #[test]
    fn example_cone_plans_cleanly() {
        let plan = plan(&Project::example_cone());
        assert!(errors(&plan).is_empty(), "{:?}", plan.warnings);
        assert!(plan.layers.iter().all(|l| l.ok));
    }

    /// Every block must start exactly where the previous one stopped, in
    /// both the fibre's position and every machine axis.
    #[test]
    fn blocks_chain_continuously() {
        for project in [Project::example_tube(), Project::example_cone()] {
            let plan = plan(&project);
            for w in plan.blocks.windows(2) {
                let (p, n) = (&w[0], &w[1]);
                let last = p.samples.len() - 1;
                let adv = p.phi_step * (p.repeats as f64 - 1.0);
                assert!((p.samples.z[last] - n.samples.z[0]).abs() < 1e-4, "z");
                assert!((p.samples.phi[last] + adv - n.samples.phi[0]).abs() < 1e-4, "phi");
                assert!((p.samples.x[last] - n.samples.x[0]).abs() < 1e-4, "x");
                assert!((p.samples.y[last] - n.samples.y[0]).abs() < 1e-4, "y");
                assert!((p.samples.a[last] + adv - n.samples.a[0]).abs() < 1e-4, "a");
                assert!((p.samples.b[last] - n.samples.b[0]).abs() < 1e-4, "b");
                assert!((p.t_end() - n.t_start).abs() < 1e-6, "time");
            }
        }
    }

    /// A helical circuit is periodic: its end pose equals its start pose
    /// plus one pattern step of spindle rotation.
    #[test]
    fn helical_circuits_are_periodic() {
        for project in [Project::example_tube(), Project::example_cone()] {
            let plan = plan(&project);
            for b in plan.blocks.iter().filter(|b| b.kind == BlockKind::Helical) {
                let s = &b.samples;
                let l = s.len() - 1;
                assert!((s.z[l] - s.z[0]).abs() < 1e-6);
                assert!((s.x[l] - s.x[0]).abs() < 1e-6);
                assert!((s.phi[l] - s.phi[0] - b.phi_step).abs() < 1e-6);
                assert!((s.a[l] - s.a[0] - b.phi_step).abs() < 1e-6);
                // Closed pattern: the whole layer is a whole number of turns.
                let turns = b.phi_step * b.repeats as f64 / TAU;
                assert!((turns - turns.round()).abs() < 1e-6);
            }
        }
    }

    /// At full coverage a helical layer is two plies thick mid-part, and a
    /// hoop layer one.
    #[test]
    fn thickness_matches_ply_count() {
        let project = Project::example_tube();
        let plan = plan(&project);
        let ply = project.material.ply_thickness();
        let hoop = &plan.layers[0];
        let helical = &plan.layers[1];
        assert!((hoop.thickness / ply - 1.0).abs() < 0.02, "hoop {}", hoop.thickness / ply);
        let cov = helical.pattern.as_ref().unwrap().coverage;
        assert!(
            (helical.thickness / (2.0 * ply * cov) - 1.0).abs() < 0.02,
            "helical {} vs {}",
            helical.thickness,
            2.0 * ply * cov
        );
    }

    /// Mass must be conserved: everything laid down shows up as thickness.
    #[test]
    fn deposited_volume_equals_fibre_volume() {
        for project in [Project::example_tube(), Project::example_cone()] {
            let plan = plan(&project);
            let profile = Profile::from_mandrel(&project.mandrel);
            let bins = Bins::new(&profile, 240);
            let vol: f64 = (0..bins.n).map(|i| plan.stations.thickness[i] * bins.area[i]).sum();
            let laid = plan.totals.fiber_length_m * 1000.0 * project.material.band_area();
            assert!((vol / laid - 1.0).abs() < 1e-6, "{vol} vs {laid}");
        }
    }

    /// On a taper the same number of bands crowd into a smaller
    /// circumference, so coverage and thickness rise towards the small end.
    #[test]
    fn taper_builds_up_towards_small_end() {
        let plan = plan(&Project::example_cone());
        let l = &plan.layers[0];
        assert!(l.coverage_tail > l.coverage_head * 1.5);
        assert!((l.coverage_head - l.pattern.as_ref().unwrap().coverage).abs() < 1e-9);
    }

    #[test]
    fn geodesic_on_taper_reports_angle_growth() {
        let mut project = Project::example_cone();
        project.layers[0].kind = LayerKind::Helical {
            angle_deg: 20.0,
            mode: AngleMode::Geodesic,
            coverage: 1.0,
            pattern: PatternChoice::Auto,
        };
        let plan = plan(&project);
        let l = &plan.layers[0];
        assert!(l.ok, "{:?}", plan.warnings);
        assert!((l.angle_head_deg - 20.0).abs() < 1e-6);
        // r sin(alpha) constant: 40 sin20 = 20 sin(a) -> a = 43.2 deg
        assert!((l.angle_tail_deg - 43.16).abs() < 0.05, "{}", l.angle_tail_deg);
        assert!(l.max_slip < 1e-9);
    }

    #[test]
    fn impossible_geodesic_is_reported_not_planned() {
        let mut project = Project::example_cone();
        project.layers[0].kind = LayerKind::Helical {
            angle_deg: 45.0,
            mode: AngleMode::Geodesic,
            coverage: 1.0,
            pattern: PatternChoice::Auto,
        };
        let plan = plan(&project);
        assert!(!plan.layers[0].ok);
        assert_eq!(errors(&plan).len(), 1);
        assert!(errors(&plan)[0].message.contains("turns back"));
    }

    #[test]
    fn short_margins_flag_turnaround_overrun() {
        let mut project = Project::example_tube();
        project.zone = WindZone { head_margin: 10.0, tail_margin: 10.0 };
        let plan = plan(&project);
        assert!(errors(&plan).iter().any(|w| w.message.contains("off the end")));
        // A pin ring removes the need for the run-out.
        project.process.turnaround = Turnaround::Pins;
        let plan2 = super::plan(&project);
        assert!(errors(&plan2).is_empty(), "{:?}", plan2.warnings);
    }

    #[test]
    fn manual_pattern_is_honoured() {
        let mut project = Project::example_tube();
        let auto = plan(&project);
        let cands = auto.layers[1].candidates.clone();
        let other = cands
            .iter()
            .find(|c| Some(*c) != auto.layers[1].pattern.as_ref())
            .unwrap()
            .clone();
        if let LayerKind::Helical { pattern, .. } = &mut project.layers[1].kind {
            *pattern = PatternChoice::Manual { circuits: other.circuits, skip: other.skip };
        }
        let manual = plan(&project);
        assert_eq!(manual.layers[1].pattern.as_ref().unwrap(), &other);
    }

    /// Round material keeps its shape: a ply is one diameter thick however
    /// heavy the strand is, it is wound dry, and several strands side by
    /// side lay a proportionally wider band.
    #[test]
    fn round_material_builds_by_diameter() {
        let mut project = Project::example_tube();
        project.material = Material::round("Rope 3 mm", 3.0, 7.0, "#cccccc");
        let plan1 = plan(&project);
        assert!(errors(&plan1).is_empty(), "{:?}", plan1.warnings);
        let (hoop, helical) = (&plan1.layers[0], &plan1.layers[1]);
        assert!((hoop.thickness / 3.0 - 1.0).abs() < 0.02, "hoop {}", hoop.thickness);
        let cov = helical.pattern.as_ref().unwrap().coverage;
        assert!((helical.thickness / (2.0 * 3.0 * cov) - 1.0).abs() < 0.02, "helical {}", helical.thickness);
        assert_eq!(plan1.totals.resin_mass_g, 0.0);
        // 7 g/m of strand.
        assert!((plan1.totals.fiber_mass_g / plan1.totals.fiber_length_m - 7.0).abs() < 1e-9);
        // All the mass laid inside the part zone is strand.
        assert!(plan1.totals.part_mass_g > 0.0 && plan1.totals.part_mass_g < plan1.totals.fiber_mass_g);

        // Heavier strand of the same diameter: same geometry, more mass.
        let mut heavy = project.clone();
        heavy.material.tex *= 2.0;
        let plan2 = plan(&heavy);
        assert!((plan2.totals.wall_thickness - plan1.totals.wall_thickness).abs() < 1e-9);
        assert!((plan2.totals.fiber_mass_g / plan1.totals.fiber_mass_g - 2.0).abs() < 1e-9);

        // Two strands side by side: twice the lay width, so half the hoop turns.
        let mut pair = project.clone();
        pair.material.tows = 2;
        pair.material.band_width = 6.0;
        assert!((pair.material.diameter() - 3.0).abs() < 1e-12);
        let plan3 = plan(&pair);
        assert!((plan3.layers[0].thickness / 3.0 - 1.0).abs() < 0.02);
        let turns = |p: &Plan| p.blocks[0].samples.phi.last().unwrap() - p.blocks[0].samples.phi[0];
        assert!((turns(&plan1) / turns(&plan3) - 2.0).abs() < 0.02);
    }

    #[test]
    fn invalid_project_yields_errors_not_panics() {
        let mut project = Project::example_tube();
        project.mandrel.length = 0.0;
        project.material.band_width = 0.0;
        let plan = plan(&project);
        assert!(plan.blocks.is_empty());
        assert!(errors(&plan).len() >= 2);
    }

    #[test]
    fn simplified_samples_stay_small() {
        let plan = plan(&Project::example_tube());
        for b in &plan.blocks {
            assert!(b.samples.len() < 400, "{:?} has {} samples", b.kind, b.samples.len());
        }
        // A hoop pass on a tube is a single straight move in axis space.
        assert!(plan.blocks[0].samples.len() <= 4);
    }
}
