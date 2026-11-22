//! The user-facing project model: everything that is saved to a `.filar` file.
//!
//! Units throughout: millimetres, degrees (in the project file), seconds, grams.
//! Internally the solver works in radians; conversion happens at the boundary.

use serde::{Deserialize, Serialize};

use crate::analysis::{AnalysisSettings, Variant};
use crate::machine::MachineProfile;

pub const PROJECT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub version: u32,
    pub name: String,
    pub mandrel: Mandrel,
    pub zone: WindZone,
    pub material: Material,
    pub process: Process,
    pub layers: Vec<Layer>,
    pub machine: MachineProfile,
    /// Loads and ply properties for the strength estimate.
    #[serde(default)]
    pub analysis: AnalysisSettings,
    /// Alternative layups kept for comparison.
    #[serde(default)]
    pub variants: Vec<Variant>,
}

/// An axisymmetric mandrel: a straight or tapered section with optional
/// cylindrical extensions at either end (extra room for turnarounds).
///
/// `z = 0` is the head end of the mandrel (including the head extension).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mandrel {
    /// Diameter at the head end of the main section (mm).
    pub start_diameter: f64,
    /// Diameter at the tail end of the main section (mm). Equal to
    /// `start_diameter` for a tube.
    pub end_diameter: f64,
    /// Length of the main (straight or tapered) section (mm).
    pub length: f64,
    /// Cylindrical extension before the main section, at `start_diameter` (mm).
    #[serde(default)]
    pub head_extension: f64,
    /// Cylindrical extension after the main section, at `end_diameter` (mm).
    #[serde(default)]
    pub tail_extension: f64,
}

impl Mandrel {
    pub fn total_length(&self) -> f64 {
        self.head_extension + self.length + self.tail_extension
    }
    pub fn is_tapered(&self) -> bool {
        (self.start_diameter - self.end_diameter).abs() > 1e-9
    }
    /// Half-angle of the taper in radians (positive when the diameter grows
    /// towards the tail).
    pub fn half_angle(&self) -> f64 {
        ((self.end_diameter - self.start_diameter) * 0.5).atan2(self.length)
    }
}

/// The part zone: the stretch of mandrel over which the requested winding
/// angle is held. Turnarounds happen outside it, in the margins.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindZone {
    /// Distance from the head end of the mandrel to the start of the part (mm).
    pub head_margin: f64,
    /// Distance from the end of the part to the tail end of the mandrel (mm).
    pub tail_margin: f64,
}

/// Cross-section of what is being wound.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Shape {
    /// A flat band of fibre tows that consolidates into a thin ply.
    #[default]
    Flat,
    /// A round strand that keeps its shape: rope, cord, twine, wire.
    Round,
}

/// The band (or strand) being wound.
///
/// `band_width` is always the width laid down per pass: for a flat band its
/// width, for round material the diameter times the number of strands laid
/// side by side.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Material {
    pub name: String,
    #[serde(default)]
    pub shape: Shape,
    /// Width laid on the mandrel per pass (mm).
    pub band_width: f64,
    /// Number of tows in the band, or strands laid side by side.
    pub tows: u32,
    /// Linear density of one tow or strand (tex = g/km).
    pub tex: f64,
    /// Fibre density (g/cm^3). Flat bands only.
    pub fiber_density: f64,
    /// Cured resin density (g/cm^3). Flat bands only.
    pub resin_density: f64,
    /// Fibre volume fraction of the laminate (0..1). Flat bands only.
    pub fiber_volume_fraction: f64,
    /// Display colour as `#rrggbb`; guessed from the name when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Name of the ply-property set that goes with this material, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ply_name: Option<String>,
}

impl Material {
    /// Diameter of one strand of round material (mm).
    pub fn diameter(&self) -> f64 {
        self.band_width / self.tows.max(1) as f64
    }
    /// Cross-section of the fibres in the band (mm^2).
    pub fn fiber_area(&self) -> f64 {
        // tex is g/km = 1e-6 g/mm; density g/cm^3 = 1e-3 g/mm^3.
        self.tows as f64 * self.tex * 1e-3 / self.fiber_density
    }
    /// Cross-section the band occupies once laid (mm^2): what sets how fast
    /// thickness builds. A flat band consolidates to fibre plus resin; a
    /// round strand keeps its height, so each one takes up a square of its
    /// own diameter.
    pub fn band_area(&self) -> f64 {
        match self.shape {
            Shape::Flat => self.fiber_area() / self.fiber_volume_fraction,
            Shape::Round => self.diameter() * self.band_width,
        }
    }
    /// Thickness of a single ply at exactly 100 % coverage (mm). For round
    /// material this is the strand diameter.
    pub fn ply_thickness(&self) -> f64 {
        self.band_area() / self.band_width
    }
    /// Fibre mass per mm of band (g/mm).
    pub fn fiber_mass_per_mm(&self) -> f64 {
        self.tows as f64 * self.tex * 1e-6
    }
    /// Resin mass per mm of band at the nominal volume fraction (g/mm).
    /// Round material is treated as wound dry.
    pub fn resin_mass_per_mm(&self) -> f64 {
        match self.shape {
            Shape::Flat => (self.band_area() - self.fiber_area()) * self.resin_density * 1e-3,
            Shape::Round => 0.0,
        }
    }
    /// Mass per unit of laid volume (g/mm^3), for turning thickness into mass.
    pub fn deposit_density(&self) -> f64 {
        (self.fiber_mass_per_mm() + self.resin_mass_per_mm()) / self.band_area()
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Turnaround {
    /// The fibre is steered through the turn as fast as friction allows.
    Friction,
    /// A pin ring (or similar) holds the fibre, so it can reverse on the spot.
    Pins,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    /// Usable friction coefficient between band and surface. Typical: 0.1-0.2
    /// for wet winding, 0.3-0.4 for towpreg.
    pub friction: f64,
    pub turnaround: Turnaround,
    /// Minimum hoop dwell at each end, in degrees of mandrel rotation.
    pub min_dwell_deg: f64,
    /// Target fibre lay-down speed (mm/s). Axis speed limits may reduce it.
    pub fiber_speed: f64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AngleMode {
    /// Hold the nominal angle along the whole part. On a taper this needs
    /// friction (the fibre is steered off the geodesic).
    Constant,
    /// Follow the natural geodesic (r * sin(angle) = const). Needs no friction;
    /// the nominal angle applies at the largest diameter and grows towards the
    /// small end.
    Geodesic,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", tag = "pattern")]
pub enum PatternChoice {
    /// Let the solver pick the circuit count and skip.
    Auto,
    /// Use an explicit pattern from the candidate table.
    #[serde(rename_all = "camelCase")]
    Manual { circuits: u32, skip: u32 },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum LayerKind {
    /// A +/- angle helical layer: every circuit lays one +angle and one
    /// -angle band, so a complete layer is two interwoven plies.
    #[serde(rename_all = "camelCase")]
    Helical {
        /// Nominal winding angle from the mandrel axis, in degrees.
        angle_deg: f64,
        mode: AngleMode,
        /// Target coverage, 1.0 = bands exactly butt at the widest station.
        coverage: f64,
        #[serde(flatten)]
        pattern: PatternChoice,
    },
    /// A hoop (circumferential) layer: one band-width of advance per turn.
    #[serde(rename_all = "camelCase")]
    Hoop {
        /// Number of passes along the part; each pass is one ply.
        plies: u32,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub id: String,
    pub name: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(flatten)]
    pub kind: LayerKind,
}

fn yes() -> bool {
    true
}

impl Project {
    /// A sensible starting point: a 50 mm tube with a hoop / +-45 / hoop layup.
    pub fn example_tube() -> Self {
        Project {
            version: PROJECT_VERSION,
            name: "Untitled tube".into(),
            mandrel: Mandrel {
                start_diameter: 50.0,
                end_diameter: 50.0,
                length: 600.0,
                head_extension: 0.0,
                tail_extension: 0.0,
            },
            zone: WindZone { head_margin: 70.0, tail_margin: 70.0 },
            material: Material::carbon_12k(),
            process: Process {
                friction: 0.2,
                turnaround: Turnaround::Friction,
                min_dwell_deg: 0.0,
                fiber_speed: 150.0,
            },
            layers: vec![
                Layer {
                    id: "l1".into(),
                    name: "Hoop".into(),
                    enabled: true,
                    kind: LayerKind::Hoop { plies: 1 },
                },
                Layer {
                    id: "l2".into(),
                    name: "Helical ±45°".into(),
                    enabled: true,
                    kind: LayerKind::Helical {
                        angle_deg: 45.0,
                        mode: AngleMode::Constant,
                        coverage: 1.0,
                        pattern: PatternChoice::Auto,
                    },
                },
                Layer {
                    id: "l3".into(),
                    name: "Hoop".into(),
                    enabled: true,
                    kind: LayerKind::Hoop { plies: 1 },
                },
            ],
            machine: MachineProfile::generic_4_axis(),
            analysis: AnalysisSettings::default(),
            variants: Vec::new(),
        }
    }

    /// A tapered example: 80 mm down to 40 mm over 500 mm.
    pub fn example_cone() -> Self {
        let mut p = Self::example_tube();
        p.name = "Untitled taper".into();
        p.mandrel = Mandrel {
            start_diameter: 80.0,
            end_diameter: 40.0,
            length: 500.0,
            head_extension: 80.0,
            tail_extension: 60.0,
        };
        p.zone = WindZone { head_margin: 80.0, tail_margin: 60.0 };
        p.layers = vec![
            Layer {
                id: "l1".into(),
                name: "Helical ±50°".into(),
                enabled: true,
                kind: LayerKind::Helical {
                    angle_deg: 50.0,
                    mode: AngleMode::Constant,
                    coverage: 1.0,
                    pattern: PatternChoice::Auto,
                },
            },
            Layer {
                id: "l2".into(),
                name: "Hoop".into(),
                enabled: true,
                kind: LayerKind::Hoop { plies: 1 },
            },
        ];
        p
    }
}

impl Material {
    pub fn carbon_12k() -> Self {
        Material {
            name: "Carbon 12k / epoxy".into(),
            shape: Shape::Flat,
            band_width: 4.0,
            tows: 1,
            tex: 800.0,
            fiber_density: 1.80,
            resin_density: 1.20,
            fiber_volume_fraction: 0.55,
            color: None,
            ply_name: Some("Carbon / epoxy".into()),
        }
    }

    /// A flat band preset.
    pub fn flat(name: &str, band_width: f64, tex: f64, fiber_density: f64, ply_name: &str) -> Self {
        Material {
            name: name.into(),
            band_width,
            tex,
            fiber_density,
            ply_name: Some(ply_name.into()),
            ..Self::carbon_12k()
        }
    }

    /// A single round strand: diameter in mm, weight in grams per metre.
    pub fn round(name: &str, diameter: f64, grams_per_metre: f64, color: &str) -> Self {
        Material {
            name: name.into(),
            shape: Shape::Round,
            band_width: diameter,
            tows: 1,
            tex: grams_per_metre * 1000.0,
            fiber_density: 1.0,
            resin_density: 1.0,
            fiber_volume_fraction: 0.5,
            color: Some(color.into()),
            ply_name: None,
        }
    }
}
