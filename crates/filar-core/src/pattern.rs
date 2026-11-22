//! Winding pattern selection for helical layers.
//!
//! One *circuit* takes the fibre from the head end to the tail end and back.
//! If the mandrel turns through `Phi` in total during a circuit, the fibre
//! comes back to the head end displaced by `Phi mod 2 pi`. For `n` circuits to
//! tile the circumference evenly and then close on the starting point, that
//! displacement has to be `2 pi k / n` with `k` coprime to `n`.
//!
//! `Phi` is tuned to a legal value by adding hoop dwell at the turnarounds, so
//! the winding angle itself is never compromised.
//!
//! The *pattern number* `p` is the number of circuits after which the band
//! lands right next to the first one (`k p = +-1 mod n`). It is the number of
//! diamonds you see around the circumference: small `p` gives large diamonds
//! and few fibre crossovers, large `p` a tight basket weave.

use std::f64::consts::TAU;

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pattern {
    /// Circuits needed to complete the layer.
    pub circuits: u32,
    /// Band positions the fibre advances per circuit (`k`).
    pub skip: u32,
    /// Diamonds around the circumference (`p`).
    pub pattern_number: u32,
    /// True if each new neighbour lands ahead (in the direction of rotation)
    /// of the band it sits beside.
    pub leading: bool,
    /// Total hoop dwell per circuit, split evenly between the two ends (rad).
    pub dwell: f64,
    /// Total mandrel rotation per circuit including dwell (rad).
    pub phi_circuit: f64,
    /// Band coverage at the widest station (1.0 = bands exactly butt).
    pub coverage: f64,
}

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 { a } else { gcd(b, a % b) }
}

/// Pattern number for a given `(n, k)`, and whether it is leading.
pub fn pattern_number(n: u32, k: u32) -> (u32, bool) {
    if n <= 2 {
        return (1, true);
    }
    for p in 1..=n {
        let m = (k as u64 * p as u64) % n as u64;
        if m == 1 {
            return (p, true);
        }
        if m == n as u64 - 1 {
            return (p, false);
        }
    }
    (n, true)
}

/// Circuits needed for a coverage factor, given the largest value of
/// `2 pi r cos(alpha)` over the part (the circumference measured across the
/// band direction) and the band width.
pub fn circuits_for_coverage(max_normal_circumference: f64, band_width: f64, coverage: f64) -> u32 {
    let n = (coverage * max_normal_circumference / band_width - 1e-9).ceil();
    n.max(1.0) as u32
}

/// Build the pattern for explicit `(n, k)`.
///
/// `phi_natural` is the rotation of one circuit with no dwell at all, and
/// `min_dwell` the minimum dwell per end.
pub fn solve(
    n: u32,
    k: u32,
    phi_natural: f64,
    min_dwell: f64,
    max_normal_circumference: f64,
    band_width: f64,
) -> Pattern {
    let base = phi_natural + 2.0 * min_dwell;
    let target = TAU * k as f64 / n as f64;
    let mut extra = (target - base).rem_euclid(TAU);
    // Treat "a hair under a full extra turn" as zero.
    if TAU - extra < 1e-9 {
        extra = 0.0;
    }
    let dwell = 2.0 * min_dwell + extra;
    let (pattern_number, leading) = pattern_number(n, k);
    Pattern {
        circuits: n,
        skip: k,
        pattern_number,
        leading,
        dwell,
        phi_circuit: phi_natural + dwell,
        coverage: n as f64 * band_width / max_normal_circumference,
    }
}

/// All closed patterns for circuit counts `n_min ..= n_min + extra_circuits`.
pub fn candidates(
    n_min: u32,
    extra_circuits: u32,
    phi_natural: f64,
    min_dwell: f64,
    max_normal_circumference: f64,
    band_width: f64,
) -> Vec<Pattern> {
    let mut out = Vec::new();
    for n in n_min..=n_min + extra_circuits {
        if n == 1 {
            out.push(solve(1, 0, phi_natural, min_dwell, max_normal_circumference, band_width));
            continue;
        }
        for k in 1..n {
            if gcd(n, k) == 1 {
                out.push(solve(n, k, phi_natural, min_dwell, max_normal_circumference, band_width));
            }
        }
    }
    out
}

/// Default choice: the fewest circuits, a moderate diamond count, and of
/// those the least dwell (dwell is wasted fibre piling up at the ends).
pub fn auto_select(cands: &[Pattern], n_min: u32) -> Option<Pattern> {
    let pool: Vec<&Pattern> = cands.iter().filter(|c| c.circuits == n_min).collect();
    let by_dwell = |a: &&&Pattern, b: &&&Pattern| a.dwell.partial_cmp(&b.dwell).unwrap();
    let preferred: Vec<&&Pattern> =
        pool.iter().filter(|c| (2..=8).contains(&c.pattern_number)).collect();
    preferred
        .iter()
        .copied()
        .min_by(by_dwell)
        .or_else(|| pool.iter().min_by(by_dwell))
        .map(|p| (**p).clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pattern_numbers() {
        assert_eq!(pattern_number(40, 1), (1, true));
        assert_eq!(pattern_number(40, 39), (1, false));
        // 13 * 3 = 39 = -1 mod 40
        assert_eq!(pattern_number(40, 13), (3, false));
        // 27 * 3 = 81 = 1 mod 40
        assert_eq!(pattern_number(40, 27), (3, true));
        assert_eq!(pattern_number(41, 8), (5, false)); // 40 = -1 mod 41
    }

    #[test]
    fn dwell_closes_the_pattern() {
        let phi_nat = 37.123;
        for c in candidates(39, 2, phi_nat, 0.1, 150.0, 4.0) {
            assert!(c.dwell >= 0.2 - 1e-12);
            assert!(c.dwell < 0.2 + TAU);
            // After n circuits the fibre is back where it started.
            let total = c.phi_circuit * c.circuits as f64;
            let turns = total / TAU;
            assert!((turns - turns.round()).abs() < 1e-9, "n={} k={}", c.circuits, c.skip);
            // And every circuit lands on a distinct band slot.
            let step = (c.phi_circuit / TAU * c.circuits as f64).round() as u64;
            assert_eq!(gcd(c.circuits, (step % c.circuits as u64) as u32), 1);
        }
    }

    #[test]
    fn coverage_count() {
        // 50 mm tube at 45 deg with a 4 mm band: 2 pi 25 cos45 / 4 = 27.8 -> 28.
        let c = TAU * 25.0 * 45f64.to_radians().cos();
        assert_eq!(circuits_for_coverage(c, 4.0, 1.0), 28);
        assert_eq!(circuits_for_coverage(c, 4.0, 1.1), 31);
    }

    #[test]
    fn auto_prefers_moderate_patterns() {
        let c = candidates(28, 0, 20.0, 0.0, 111.0, 4.0);
        let pick = auto_select(&c, 28).unwrap();
        assert_eq!(pick.circuits, 28);
        assert!((2..=8).contains(&pick.pattern_number));
    }
}
