//! Mandrel geometry as a piecewise-linear meridian `r(z)`.
//!
//! Tubes and tapers are the only shapes exposed in the project model today,
//! but everything downstream works from this general profile, so adding
//! further axisymmetric shapes only means producing more stations here.

use crate::project::Mandrel;

#[derive(Clone, Debug)]
pub struct Profile {
    /// Stations `(z, r)`, strictly increasing in z.
    pts: Vec<(f64, f64)>,
}

impl Profile {
    pub fn from_mandrel(m: &Mandrel) -> Self {
        let r1 = m.start_diameter * 0.5;
        let r2 = m.end_diameter * 0.5;
        let mut pts = vec![(0.0, r1)];
        let mut push = |z: f64, r: f64| {
            let last = *pts.last().unwrap();
            if z - last.0 > 1e-9 {
                pts.push((z, r));
            }
        };
        push(m.head_extension, r1);
        push(m.head_extension + m.length, r2);
        push(m.head_extension + m.length + m.tail_extension, r2);
        Profile { pts }
    }

    pub fn from_points(pts: Vec<(f64, f64)>) -> Self {
        Profile { pts }
    }

    pub fn points(&self) -> &[(f64, f64)] {
        &self.pts
    }

    pub fn z_min(&self) -> f64 {
        self.pts[0].0
    }

    pub fn z_max(&self) -> f64 {
        self.pts[self.pts.len() - 1].0
    }

    pub fn max_radius(&self) -> f64 {
        self.pts.iter().map(|p| p.1).fold(0.0, f64::max)
    }

    /// Index of the segment containing `z`. At a station the segment on the
    /// `dir` side is chosen (`dir >= 0` looks towards +z), so that a path
    /// crossing a crease sees the slope of the surface it is moving onto.
    fn segment(&self, z: f64, dir: f64) -> usize {
        let n = self.pts.len();
        if n < 2 {
            return 0;
        }
        let mut i = match self.pts.binary_search_by(|p| p.0.partial_cmp(&z).unwrap()) {
            Ok(i) => {
                if dir >= 0.0 {
                    i
                } else {
                    i.saturating_sub(1)
                }
            }
            Err(i) => i.saturating_sub(1),
        };
        if i > n - 2 {
            i = n - 2;
        }
        i
    }

    /// Radius at `z`. Beyond the ends the mandrel is treated as continuing
    /// at its end radius (useful for clearance checks; warnings are raised
    /// separately when a path actually leaves the mandrel).
    pub fn radius(&self, z: f64) -> f64 {
        if z <= self.z_min() {
            return self.pts[0].1;
        }
        if z >= self.z_max() {
            return self.pts[self.pts.len() - 1].1;
        }
        let i = self.segment(z, 1.0);
        let (z0, r0) = self.pts[i];
        let (z1, r1) = self.pts[i + 1];
        r0 + (r1 - r0) * (z - z0) / (z1 - z0)
    }

    /// Slope `dr/dz` on the `dir` side of `z` (zero beyond the ends).
    pub fn slope(&self, z: f64, dir: f64) -> f64 {
        if z < self.z_min() || z > self.z_max() {
            return 0.0;
        }
        if (z <= self.z_min() && dir < 0.0) || (z >= self.z_max() && dir >= 0.0) {
            return 0.0;
        }
        let i = self.segment(z, dir);
        let (z0, r0) = self.pts[i];
        let (z1, r1) = self.pts[i + 1];
        (r1 - r0) / (z1 - z0)
    }

    /// Interior stations strictly inside `(a, b)`.
    pub fn breakpoints_between(&self, a: f64, b: f64) -> Vec<f64> {
        let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
        self.pts
            .iter()
            .map(|p| p.0)
            .filter(|z| *z > lo + 1e-9 && *z < hi - 1e-9)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn taper_profile() {
        let m = Mandrel {
            start_diameter: 80.0,
            end_diameter: 40.0,
            length: 400.0,
            head_extension: 50.0,
            tail_extension: 30.0,
        };
        let p = Profile::from_mandrel(&m);
        assert_eq!(p.points().len(), 4);
        assert!((p.radius(0.0) - 40.0).abs() < 1e-12);
        assert!((p.radius(250.0) - 30.0).abs() < 1e-12);
        assert!((p.radius(480.0) - 20.0).abs() < 1e-12);
        assert!((p.slope(250.0, 1.0) + 0.05).abs() < 1e-12);
        assert_eq!(p.slope(20.0, 1.0), 0.0);
        // At the crease the slope depends on which way you are heading.
        assert_eq!(p.slope(50.0, -1.0), 0.0);
        assert!((p.slope(50.0, 1.0) + 0.05).abs() < 1e-12);
    }

    #[test]
    fn tube_has_two_stations() {
        let m = Mandrel {
            start_diameter: 50.0,
            end_diameter: 50.0,
            length: 600.0,
            head_extension: 0.0,
            tail_extension: 0.0,
        };
        let p = Profile::from_mandrel(&m);
        assert_eq!(p.points().len(), 2);
        assert_eq!(p.radius(-5.0), 25.0);
    }
}
