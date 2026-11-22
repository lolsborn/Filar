//! Fibre paths on a surface of revolution.
//!
//! A path is described by the winding angle `alpha` between the fibre and the
//! meridian. With `s` the arc length along the fibre, `r(z)` the meridian,
//! `gamma = atan(r')` the local half-angle, and `lambda` the slip tendency
//! (ratio of geodesic to normal curvature, i.e. the friction coefficient the
//! fibre needs in order to stay put):
//!
//! ```text
//! dz/ds     = cos(alpha) cos(gamma)
//! dphi/ds   = sin(alpha) / r
//! dalpha/ds = lambda * k_n - sin(gamma) sin(alpha) / r
//! k_n       = sin^2(alpha) cos(gamma) / r          (piecewise-linear meridian)
//! ```
//!
//! `lambda = 0` gives a geodesic and reproduces Clairaut's relation
//! `r sin(alpha) = const`. A fibre is stable while `|lambda| <= mu`.
//!
//! Primitives here are expressed in the *travel frame*: `alpha` is the acute
//! angle to the direction of travel along the axis (`dir = +1` or `-1`), which
//! makes a return pass the exact mirror image of the forward pass.

use std::f64::consts::FRAC_PI_2;

use crate::mandrel::Profile;

/// A piece of fibre path in the travel frame. All vectors have equal length.
#[derive(Clone, Debug, Default)]
pub struct Prim {
    pub z: Vec<f64>,
    /// Acute angle to the direction of travel (rad), in `(0, pi/2]`.
    pub alpha: Vec<f64>,
    /// Mandrel rotation swept since the start of the primitive (rad).
    pub phi: Vec<f64>,
    /// Fibre arc length since the start of the primitive (mm).
    pub s: Vec<f64>,
    /// Slip tendency required at each point (travel frame, signed).
    pub lambda: Vec<f64>,
}

impl Prim {
    pub fn len(&self) -> usize {
        self.z.len()
    }
    pub fn is_empty(&self) -> bool {
        self.z.is_empty()
    }
    pub fn total_phi(&self) -> f64 {
        self.phi.last().copied().unwrap_or(0.0)
    }
    pub fn total_s(&self) -> f64 {
        self.s.last().copied().unwrap_or(0.0)
    }
    pub fn end_z(&self) -> f64 {
        *self.z.last().unwrap()
    }
    pub fn max_lambda(&self) -> f64 {
        self.lambda.iter().fold(0.0, |m, l| m.max(l.abs()))
    }
    fn push(&mut self, z: f64, alpha: f64, phi: f64, s: f64, lambda: f64) {
        self.z.push(z);
        self.alpha.push(alpha);
        self.phi.push(phi);
        self.s.push(s);
        self.lambda.push(lambda);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum PathError {
    /// The geodesic reaches 90 degrees (turns back by itself) before the
    /// small end of the part. `max_angle` is the largest nominal angle that
    /// still gets there (rad).
    GeodesicTurnsBack { max_angle: f64 },
    /// A friction turnaround failed to converge.
    TurnDidNotConverge,
    /// The requested angle is outside (0, 90) degrees.
    BadAngle,
}

fn cos_gamma(slope: f64) -> f64 {
    1.0 / (1.0 + slope * slope).sqrt()
}

/// Follow a prescribed angle law `alpha(z, r)` from `z0` to `z1`.
///
/// Works in either direction. `step` is the maximum axial sample spacing.
pub fn prescribed(
    profile: &Profile,
    z0: f64,
    z1: f64,
    step: f64,
    alpha_of: &dyn Fn(f64, f64) -> f64,
) -> Prim {
    let dir = if z1 >= z0 { 1.0 } else { -1.0 };
    let span = (z1 - z0).abs();

    // Sample stations: the ends, every profile crease, and a uniform fill.
    let mut stations = vec![z0];
    let mut creases = profile.breakpoints_between(z0, z1);
    if dir < 0.0 {
        creases.reverse();
    }
    creases.push(z1);
    for target in creases {
        let from = *stations.last().unwrap();
        let seg = (target - from).abs();
        let n = (seg / step).ceil().max(1.0) as usize;
        for i in 1..=n {
            stations.push(from + (target - from) * (i as f64 / n as f64));
        }
    }

    let mut out = Prim::default();
    if span < 1e-12 {
        let r = profile.radius(z0);
        out.push(z0, alpha_of(z0, r), 0.0, 0.0, 0.0);
        return out;
    }

    // Integrands with respect to |dz|.
    let f = |z: f64, slope: f64| {
        let r = profile.radius(z);
        let a = alpha_of(z, r);
        let m = (1.0 + slope * slope).sqrt();
        (a.tan() * m / r, m / a.cos())
    };

    let n = stations.len();
    let mut phi = 0.0;
    let mut s = 0.0;
    let r0 = profile.radius(z0);
    out.push(z0, alpha_of(z0, r0), 0.0, 0.0, 0.0);
    for i in 1..n {
        let (za, zb) = (stations[i - 1], stations[i]);
        let h = (zb - za).abs();
        let slope = profile.slope(0.5 * (za + zb), dir);
        let (fa, ga) = f(za, slope);
        let (fm, gm) = f(0.5 * (za + zb), slope);
        let (fb, gb) = f(zb, slope);
        phi += h / 6.0 * (fa + 4.0 * fm + fb);
        s += h / 6.0 * (ga + 4.0 * gm + gb);
        let r = profile.radius(zb);
        out.push(zb, alpha_of(zb, r), phi, s, 0.0);
    }

    // Slip tendency needed to hold the law:
    //   lambda = (dalpha/ds + dir * sin(gamma) sin(alpha) / r) / k_n
    for i in 0..n {
        let (j0, j1) = if i == 0 {
            (0, 1)
        } else if i == n - 1 {
            (n - 2, n - 1)
        } else {
            (i - 1, i + 1)
        };
        let ds = out.s[j1] - out.s[j0];
        let dalpha_ds = if ds > 1e-12 { (out.alpha[j1] - out.alpha[j0]) / ds } else { 0.0 };
        // Use the slope on the side we have data for.
        let side = if i == n - 1 { -dir } else { dir };
        let slope = profile.slope(out.z[i], side);
        let cg = cos_gamma(slope);
        let sg = slope * cg;
        let r = profile.radius(out.z[i]);
        let a = out.alpha[i];
        let kn = a.sin().powi(2) * cg / r;
        out.lambda[i] = (dalpha_ds + dir * sg * a.sin() / r) / kn;
    }
    out
}

/// Constant-angle body between `z0` and `z1`.
pub fn constant_angle(profile: &Profile, z0: f64, z1: f64, step: f64, alpha: f64) -> Prim {
    prescribed(profile, z0, z1, step, &|_, _| alpha)
}

/// Geodesic body between `z0` and `z1`, with `alpha_ref` applying at the
/// largest radius in the span.
pub fn geodesic(
    profile: &Profile,
    z0: f64,
    z1: f64,
    step: f64,
    alpha_ref: f64,
) -> Result<Prim, PathError> {
    let (r_max, r_min) = radius_range(profile, z0, z1);
    let c = r_max * alpha_ref.sin();
    // Leave a little headroom below 90 degrees at the small end.
    let limit = r_min * (88.0f64).to_radians().sin();
    if c >= limit {
        return Err(PathError::GeodesicTurnsBack { max_angle: (limit / r_max).asin() });
    }
    let mut p = prescribed(profile, z0, z1, step, &|_, r| (c / r).clamp(-1.0, 1.0).asin());
    // A geodesic needs no friction by definition; clear numerical residue.
    p.lambda.iter_mut().for_each(|l| *l = 0.0);
    Ok(p)
}

/// Hoop path: one `pitch` of meridian advance per turn of the mandrel.
pub fn hoop(profile: &Profile, z0: f64, z1: f64, step: f64, pitch: f64) -> Prim {
    let k = std::f64::consts::TAU / pitch;
    prescribed(profile, z0, z1, step, &|_, r| (k * r).atan())
}

/// Smallest and largest radius over `[z0, z1]` → `(max, min)`.
pub fn radius_range(profile: &Profile, z0: f64, z1: f64) -> (f64, f64) {
    let mut zs = vec![z0, z1];
    zs.extend(profile.breakpoints_between(z0, z1));
    let mut hi = f64::MIN;
    let mut lo = f64::MAX;
    for z in zs {
        let r = profile.radius(z);
        hi = hi.max(r);
        lo = lo.min(r);
    }
    (hi, lo)
}

/// Friction-limited turnaround: starting at `z0` with acute angle `alpha0`,
/// travelling in direction `dir`, steer towards 90 degrees using slip
/// tendency `mu` until the fibre runs purely circumferentially.
///
/// The exit from the turn is the mirror image of the entry, so only this half
/// needs integrating.
pub fn turn_in(
    profile: &Profile,
    z0: f64,
    alpha0: f64,
    dir: f64,
    mu: f64,
) -> Result<Prim, PathError> {
    if !(alpha0 > 0.0 && alpha0 <= FRAC_PI_2) {
        return Err(PathError::BadAngle);
    }
    let mut out = Prim::default();
    out.push(z0, alpha0, 0.0, 0.0, mu);
    if alpha0 >= FRAC_PI_2 - 1e-9 {
        return Ok(out);
    }

    // State y = (z, alpha, phi).
    let deriv = |y: [f64; 3]| -> [f64; 3] {
        let slope = profile.slope(y[0], dir);
        let cg = cos_gamma(slope);
        let sg = slope * cg;
        let r = profile.radius(y[0]);
        let (sa, ca) = y[1].sin_cos();
        [
            dir * ca * cg,
            mu * sa * sa * cg / r - dir * sg * sa / r,
            sa / r,
        ]
    };
    let rk4 = |y: [f64; 3], h: f64| -> [f64; 3] {
        let add = |a: [f64; 3], b: [f64; 3], k: f64| [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
        let k1 = deriv(y);
        let k2 = deriv(add(y, k1, h * 0.5));
        let k3 = deriv(add(y, k2, h * 0.5));
        let k4 = deriv(add(y, k3, h));
        [
            y[0] + h / 6.0 * (k1[0] + 2.0 * k2[0] + 2.0 * k3[0] + k4[0]),
            y[1] + h / 6.0 * (k1[1] + 2.0 * k2[1] + 2.0 * k3[1] + k4[1]),
            y[2] + h / 6.0 * (k1[2] + 2.0 * k2[2] + 2.0 * k3[2] + k4[2]),
        ]
    };

    const H_MAX: f64 = 1.0; // mm
    const DALPHA_MAX: f64 = 0.02; // rad per step
    let s_limit = 200.0 * profile.max_radius() / mu.max(1e-3) + 10.0 * (profile.z_max() - profile.z_min());

    let mut y = [z0, alpha0, 0.0];
    let mut s = 0.0;
    loop {
        let d = deriv(y);
        let mut h = H_MAX;
        if d[1].abs() > 1e-12 {
            h = h.min(DALPHA_MAX / d[1].abs());
        }
        // Land on profile creases rather than stepping across them.
        if d[0].abs() > 1e-9 {
            let ahead = if dir > 0.0 {
                profile.breakpoints_between(y[0], f64::MAX).first().copied()
            } else {
                profile.breakpoints_between(f64::MIN, y[0]).last().copied()
            };
            // The outer stations are creases too (the mandrel ends).
            let ends = if dir > 0.0 { profile.z_max() } else { profile.z_min() };
            let next = ahead.unwrap_or(ends);
            let dist = (next - y[0]) * dir;
            if dist > 1e-7 {
                let h_bp = dist / d[0].abs();
                if h_bp < h {
                    h = h_bp;
                }
            }
        }
        let mut yn = rk4(y, h);
        if yn[1] >= FRAC_PI_2 {
            // Refine the final step so it ends exactly at 90 degrees.
            let mut hh = h;
            for _ in 0..8 {
                let over = yn[1] - y[1];
                if over.abs() < 1e-15 {
                    break;
                }
                hh *= (FRAC_PI_2 - y[1]) / over;
                yn = rk4(y, hh);
                if (yn[1] - FRAC_PI_2).abs() < 1e-11 {
                    break;
                }
            }
            s += hh;
            out.push(yn[0], FRAC_PI_2, yn[2], s, mu);
            return Ok(out);
        }
        s += h;
        y = yn;
        if y[1] <= 1e-4 || s > s_limit || !y[1].is_finite() {
            return Err(PathError::TurnDidNotConverge);
        }
        out.push(y[0], y[1], y[2], s, mu);
    }
}

/// A pin-ring turnaround: the fibre hooks the pins and reverses on the spot.
pub fn pin_turn(z0: f64, alpha0: f64) -> Prim {
    let mut out = Prim::default();
    out.push(z0, alpha0, 0.0, 0.0, 0.0);
    out.push(z0, FRAC_PI_2, 0.0, 0.0, 0.0);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tube(r: f64, len: f64) -> Profile {
        Profile::from_points(vec![(0.0, r), (len, r)])
    }
    fn cone(r0: f64, r1: f64, len: f64) -> Profile {
        Profile::from_points(vec![(0.0, r0), (len, r1)])
    }

    #[test]
    fn helix_on_tube_matches_closed_form() {
        let p = tube(25.0, 600.0);
        let a = 45f64.to_radians();
        let b = constant_angle(&p, 100.0, 500.0, 1.0, a);
        // phi = L tan(a) / R, s = L / cos(a)
        assert!((b.total_phi() - 400.0 * a.tan() / 25.0).abs() < 1e-9);
        assert!((b.total_s() - 400.0 / a.cos()).abs() < 1e-9);
        assert!(b.max_lambda() < 1e-9, "a helix on a cylinder is a geodesic");
    }

    #[test]
    fn friction_turn_on_tube_matches_closed_form() {
        // On a cylinder: dalpha/ds = mu sin^2(alpha) / R, which integrates to
        //   z   = (R / mu) (1 / sin(a0) - 1)
        //   phi = (1 / mu) ln(cot(a0 / 2))
        let (r, mu) = (25.0, 0.2);
        let p = tube(r, 2000.0);
        for deg in [20.0f64, 45.0, 70.0] {
            let a0 = deg.to_radians();
            let t = turn_in(&p, 500.0, a0, 1.0, mu).unwrap();
            let dz = t.end_z() - 500.0;
            let z_exact = r / mu * (1.0 / a0.sin() - 1.0);
            let phi_exact = (1.0 / (a0 / 2.0).tan()).ln() / mu;
            assert!((dz - z_exact).abs() < 1e-5, "{deg}: dz {dz} vs {z_exact}");
            assert!((t.total_phi() - phi_exact).abs() < 1e-6, "{deg}: phi");
            assert!((t.alpha.last().unwrap() - FRAC_PI_2).abs() < 1e-12);
        }
    }

    #[test]
    fn turn_is_direction_symmetric_on_tube() {
        let p = tube(30.0, 2000.0);
        let a0 = 50f64.to_radians();
        let f = turn_in(&p, 1000.0, a0, 1.0, 0.15).unwrap();
        let b = turn_in(&p, 1000.0, a0, -1.0, 0.15).unwrap();
        assert!(((f.end_z() - 1000.0) + (b.end_z() - 1000.0)).abs() < 1e-9);
        assert!((f.total_phi() - b.total_phi()).abs() < 1e-9);
    }

    #[test]
    fn geodesic_obeys_clairaut() {
        let p = cone(40.0, 20.0, 500.0);
        let a_ref = 25f64.to_radians();
        let g = geodesic(&p, 0.0, 500.0, 1.0, a_ref).unwrap();
        let c = 40.0 * a_ref.sin();
        for i in 0..g.len() {
            let r = p.radius(g.z[i]);
            assert!((r * g.alpha[i].sin() - c).abs() < 1e-9);
        }
        // Unrolling a cone flattens it, and geodesics become straight lines.
        // With slant distances l = r / sin(gamma) from the apex, the swept
        // angle on the developed sector is (alpha_end - alpha_start), and
        // phi = that angle / sin(gamma).
        let gamma = (20.0f64 / 500.0).atan();
        let a_end = (c / 20.0f64).asin();
        let phi_exact = (a_end - a_ref) / gamma.sin();
        assert!((g.total_phi() - phi_exact).abs() < 1e-6, "{} vs {}", g.total_phi(), phi_exact);
    }

    #[test]
    fn geodesic_that_cannot_reach_small_end_is_rejected() {
        let p = cone(40.0, 20.0, 500.0);
        match geodesic(&p, 0.0, 500.0, 1.0, 45f64.to_radians()) {
            Err(PathError::GeodesicTurnsBack { max_angle }) => {
                assert!(max_angle < 30f64.to_radians());
            }
            other => panic!("expected rejection, got {other:?}"),
        }
    }

    #[test]
    fn constant_angle_on_cone_needs_tan_gamma_over_sin_alpha() {
        let p = cone(40.0, 20.0, 500.0);
        let a = 45f64.to_radians();
        let b = constant_angle(&p, 0.0, 500.0, 1.0, a);
        let expect = (20.0f64 / 500.0) / a.sin(); // |r'| / sin(alpha)
        assert!((b.max_lambda() - expect).abs() < 1e-9);
        // Shrinking radius along +z: the fibre wants to slide to the small end.
        assert!(b.lambda[b.len() / 2] < 0.0);
    }

    #[test]
    fn friction_turn_integrated_as_geodesic_conserves_clairaut() {
        // With mu -> 0 the turn equation is the geodesic equation; heading
        // down a cone the angle must still rise to 90 degrees where
        // r = r0 sin(alpha0).
        let p = cone(40.0, 5.0, 1000.0);
        let a0 = 30f64.to_radians();
        let t = turn_in(&p, 0.0, a0, 1.0, 1e-9).unwrap();
        let r_end = p.radius(t.end_z());
        assert!((r_end - 40.0 * a0.sin()).abs() < 1e-4, "r_end {r_end}");
    }

    #[test]
    fn hoop_advances_one_pitch_per_turn() {
        let p = cone(40.0, 20.0, 500.0);
        let h = hoop(&p, 0.0, 500.0, 2.0, 4.0);
        let slant = (500.0f64.powi(2) + 20.0f64.powi(2)).sqrt();
        assert!((h.total_phi() - std::f64::consts::TAU * slant / 4.0).abs() < 1e-6);
    }
}
