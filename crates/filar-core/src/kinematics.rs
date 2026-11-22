//! Inverse kinematics: where the machine has to be for the fibre to touch
//! down at a given point with a given winding angle.
//!
//! The free span of fibre between the delivery eye and the mandrel is a
//! straight line leaving the surface along the path tangent. Intersecting
//! that line with the cylinder the eye lives on gives the eye position; the
//! carriage therefore *leads* the touch-down point by `L cos(alpha)`, and the
//! spindle angle differs from the surface angle by the wrap of the free span.
//!
//! Frame: mandrel axis is `z`; the eye sits at angle zero about that axis, at
//! radial distance `rho`. Spindle angle `a` is the mandrel rotation that
//! brings the free span onto the eye.

use crate::machine::MachineProfile;
use crate::mandrel::Profile;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EyePose {
    /// Axial position of the eye in mandrel coordinates (mm).
    pub x: f64,
    /// Distance from the spindle axis to the eye (mm).
    pub rho: f64,
    /// Spindle angle (rad), continuous with the path's `phi`.
    pub a: f64,
    /// Eye rotation (rad): 0 for hoop, +(90 deg - alpha) heading towards +z.
    pub b: f64,
    /// Free fibre length between mandrel and eye (mm).
    pub free: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum KinError {
    /// The eye would be at or inside the mandrel surface.
    EyeInsideMandrel { needed: f64 },
}

/// Solve the eye pose for a contact point `(z, phi)` with true winding angle
/// `alpha` in `(0, pi)`.
pub fn solve(
    profile: &Profile,
    machine: &MachineProfile,
    z: f64,
    phi: f64,
    alpha: f64,
) -> Result<EyePose, KinError> {
    let (sa, ca) = alpha.sin_cos();
    let dir = if ca >= 0.0 { 1.0 } else { -1.0 };
    let slope = profile.slope(z, dir);
    let cg = 1.0 / (1.0 + slope * slope).sqrt();
    let sg = slope * cg;
    let r = profile.radius(z);

    // Tangent in the local (radial, circumferential, axial) basis.
    let t_r = ca * sg;
    let t_p = sa;
    let t_z = ca * cg;

    // Length along the tangent to reach radial distance rho.
    let span = |rho: f64| -> f64 {
        let qa = t_r * t_r + t_p * t_p;
        let qb = r * t_r;
        let qc = r * r - rho * rho;
        (-qb + (qb * qb - qa * qc).max(0.0).sqrt()) / qa
    };

    let mut rho = if machine.crossfeed.enabled {
        r + machine.clearance
    } else {
        machine.eye_distance
    };
    if rho <= r + 1e-6 {
        return Err(KinError::EyeInsideMandrel { needed: r });
    }
    let mut len = span(rho);
    if machine.crossfeed.enabled {
        // The cross-feed keeps a constant standoff from the surface *under
        // the eye*, which depends on where the eye ends up. A few fixed-point
        // rounds settle it (the taper is gentle, so this contracts quickly).
        for _ in 0..8 {
            let rho_next = profile.radius(z + len * t_z) + machine.clearance;
            let rho_next = rho_next.max(r + 0.5 * machine.clearance.max(1.0));
            if (rho_next - rho).abs() < 1e-9 {
                rho = rho_next;
                len = span(rho);
                break;
            }
            rho = rho_next;
            len = span(rho);
        }
    }

    let q_r = r + len * t_r;
    let q_p = len * t_p;
    let wrap = q_p.atan2(q_r);

    // Fibre direction seen in the plane normal to the cross-feed direction.
    let t_tan = -t_r * wrap.sin() + t_p * wrap.cos();
    let b = t_z.atan2(t_tan);

    Ok(EyePose { x: z + len * t_z, rho, a: phi + wrap, b, free: len })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::FRAC_PI_2;

    fn tube() -> Profile {
        Profile::from_points(vec![(0.0, 25.0), (600.0, 25.0)])
    }

    #[test]
    fn hoop_on_tube_is_plain_tangent() {
        let mut m = MachineProfile::generic_2_axis();
        m.eye_distance = 100.0;
        let p = solve(&tube(), &m, 300.0, 1.0, FRAC_PI_2).unwrap();
        let free = (100.0f64.powi(2) - 25.0f64.powi(2)).sqrt();
        assert!((p.free - free).abs() < 1e-9);
        assert!((p.x - 300.0).abs() < 1e-9, "no lead when winding hoop");
        assert!((p.a - (1.0 + (free / 25.0).atan())).abs() < 1e-9);
        assert!(p.b.abs() < 1e-9);
        assert_eq!(p.rho, 100.0);
    }

    #[test]
    fn carriage_leads_on_the_way_out_and_back() {
        let mut m = MachineProfile::generic_2_axis();
        m.eye_distance = 100.0;
        let a = 45f64.to_radians();
        let out = solve(&tube(), &m, 300.0, 0.0, a).unwrap();
        let back = solve(&tube(), &m, 300.0, 0.0, std::f64::consts::PI - a).unwrap();
        assert!(out.x > 300.0 && back.x < 300.0);
        assert!(((out.x - 300.0) + (back.x - 300.0)).abs() < 1e-9);
        assert!((out.a - back.a).abs() < 1e-9);
        assert!((out.b + back.b).abs() < 1e-9);
        assert!(out.b > 0.0);
        // The eye really is at the commanded radius, on the tangent line.
        let l = out.free;
        let q_r = 25.0;
        let q_p = l * a.sin();
        assert!(((q_r * q_r + q_p * q_p).sqrt() - 100.0).abs() < 1e-9);
    }

    #[test]
    fn crossfeed_tracks_a_taper() {
        let cone = Profile::from_points(vec![(0.0, 40.0), (500.0, 20.0)]);
        let m = MachineProfile::generic_4_axis();
        let p = solve(&cone, &m, 250.0, 0.0, 50f64.to_radians()).unwrap();
        assert!((p.rho - (cone.radius(p.x) + m.clearance)).abs() < 1e-6);
    }

    #[test]
    fn eye_inside_mandrel_is_an_error() {
        let mut m = MachineProfile::generic_2_axis();
        m.eye_distance = 20.0;
        assert!(solve(&tube(), &m, 300.0, 0.0, 1.0).is_err());
    }
}
