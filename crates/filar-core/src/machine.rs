//! Machine profiles: which axes a winder has, how they map to G-code words,
//! and how the controller expects feed rates and rotary positions.

use serde::{Deserialize, Serialize};

/// One machine axis and its mapping from solver units to G-code.
///
/// The solver works in physical units (mm for linear axes, degrees for rotary
/// axes). The value written to G-code is
/// `(invert ? -1 : 1) * physical * scale + offset`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Axis {
    pub enabled: bool,
    /// G-code axis word, e.g. `"X"` or `"A"`.
    pub letter: String,
    /// Machine units per mm (linear) or per degree (rotary). Use `1/360` for a
    /// rotary axis programmed in revolutions.
    pub scale: f64,
    /// Added after scaling, in machine units.
    pub offset: f64,
    pub invert: bool,
    /// Soft limits in machine units; `None` = unlimited.
    pub min: Option<f64>,
    pub max: Option<f64>,
    /// Maximum speed in physical units per second (mm/s or deg/s).
    pub max_speed: f64,
}

impl Axis {
    pub fn to_machine(&self, physical: f64) -> f64 {
        let v = if self.invert { -physical } else { physical };
        v * self.scale + self.offset
    }

    fn linear(letter: &str, min: f64, max: f64, max_speed: f64) -> Self {
        Axis {
            enabled: true,
            letter: letter.into(),
            scale: 1.0,
            offset: 0.0,
            invert: false,
            min: Some(min),
            max: Some(max),
            max_speed,
        }
    }

    fn rotary(letter: &str, limit: Option<f64>, max_speed: f64) -> Self {
        Axis {
            enabled: true,
            letter: letter.into(),
            scale: 1.0,
            offset: 0.0,
            invert: false,
            min: limit.map(|l| -l),
            max: limit,
            max_speed,
        }
    }

    fn disabled(mut self) -> Self {
        self.enabled = false;
        self
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FeedMode {
    /// `G93`: every move carries `F = 1 / minutes`. Unambiguous for mixed
    /// linear + rotary moves. Supported by grblHAL and LinuxCNC; check your
    /// controller before relying on it.
    InverseTime,
    /// `G94` where the controller applies `F` to the Euclidean length of the
    /// move across *all* axes, treating degrees like millimetres. This is how
    /// GRBL-family controllers and printer firmware with a rotary axis mapped
    /// onto a "linear" one behave.
    AllAxes,
    /// `G94` where `F` applies to the linear axes only whenever one of them
    /// moves, and to the rotary axes (deg/min) on pure rotary moves. This is
    /// the LinuxCNC / Marlin-with-true-rotary-axes convention.
    LinearAxes,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RotaryMode {
    /// The spindle angle keeps counting up for the whole program.
    Cumulative,
    /// The spindle angle is wrapped back into one turn with `G92` at the
    /// start of every circuit, keeping numbers small on controllers that
    /// store positions as 32-bit floats.
    WrapEachCircuit,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CommentStyle {
    Semicolon,
    Parentheses,
    None,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GcodeOptions {
    pub feed_mode: FeedMode,
    pub rotary_mode: RotaryMode,
    pub comments: CommentStyle,
    pub line_numbers: bool,
    /// Decimal places for axis words.
    pub decimals: u8,
    /// Longest single move (s); longer moves are split. 0 = never split.
    #[serde(default)]
    pub max_move_time: f64,
    /// Lines emitted verbatim before the program body.
    pub header: String,
    /// Lines emitted verbatim after the program body.
    pub footer: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MachineProfile {
    pub name: String,
    /// Free-text note shown in the UI, e.g. a compatibility caveat.
    #[serde(default)]
    pub note: String,
    /// Traverse along the mandrel axis. Physical value: axial position of the
    /// delivery eye in mandrel coordinates (mm).
    pub carriage: Axis,
    /// Mandrel rotation. Physical value: cumulative rotation (degrees).
    pub spindle: Axis,
    /// Cross-feed, moving the delivery eye towards / away from the mandrel.
    /// Physical value: distance from the spindle axis to the eye (mm).
    pub crossfeed: Axis,
    /// Rotation of the delivery eye about the cross-feed direction so the
    /// band stays flat. Physical value: degrees, 0 = hoop winding.
    pub eye: Axis,
    /// Distance from the spindle axis to the eye when there is no cross-feed
    /// axis (mm).
    pub eye_distance: f64,
    /// Standoff the cross-feed keeps between eye and mandrel surface (mm).
    pub clearance: f64,
    pub gcode: GcodeOptions,
}

impl MachineProfile {
    pub fn axis_count(&self) -> usize {
        2 + self.crossfeed.enabled as usize + self.eye.enabled as usize
    }

    /// Four axes with inverse-time feed, as accepted by grblHAL and LinuxCNC.
    pub fn generic_4_axis() -> Self {
        MachineProfile {
            name: "Generic 4-axis (grblHAL)".into(),
            note: "X carriage, A spindle, Y cross-feed, B eye rotation. Inverse-time feed (G93)."
                .into(),
            carriage: Axis::linear("X", -50.0, 1200.0, 300.0),
            spindle: Axis::rotary("A", None, 720.0),
            crossfeed: Axis::linear("Y", 0.0, 250.0, 100.0),
            eye: Axis::rotary("B", Some(85.0), 360.0),
            eye_distance: 120.0,
            clearance: 40.0,
            gcode: GcodeOptions {
                feed_mode: FeedMode::InverseTime,
                rotary_mode: RotaryMode::Cumulative,
                comments: CommentStyle::Semicolon,
                line_numbers: false,
                decimals: 3,
                max_move_time: 2.0,
                header: "G21\nG90".into(),
                footer: "M2".into(),
            },
        }
    }

    /// Two axes on a GRBL-family controller: carriage and spindle only.
    pub fn generic_2_axis() -> Self {
        let mut m = Self::generic_4_axis();
        m.name = "Generic 2-axis (grblHAL)".into();
        m.note = "X carriage, A spindle. Fixed delivery eye. Inverse-time feed (G93).".into();
        m.crossfeed = m.crossfeed.disabled();
        m.eye = m.eye.disabled();
        m
    }

    /// Three axes: carriage, spindle and cross-feed.
    pub fn generic_3_axis() -> Self {
        let mut m = Self::generic_4_axis();
        m.name = "Generic 3-axis (grblHAL)".into();
        m.note = "X carriage, A spindle, Y cross-feed. Inverse-time feed (G93).".into();
        m.eye = m.eye.disabled();
        m
    }

    /// A 3D-printer board running stock Marlin with the rotary axes wired to
    /// the Y and Z drivers and steps-per-unit set to steps per degree. This is
    /// the convention the open-source Cyclone winder uses. Marlin sees three
    /// "linear" axes, so `F` is the combined rate across all of them.
    pub fn marlin_xyz() -> Self {
        let mut m = Self::generic_4_axis();
        m.name = "Marlin, rotary on Y/Z (Cyclone-style)".into();
        m.note = "X carriage, Y spindle, Z eye rotation, with steps/unit set to steps per degree. \
                  Feed is the combined rate over all axes (Marlin has no G93)."
            .into();
        m.spindle.letter = "Y".into();
        m.eye.letter = "Z".into();
        m.crossfeed.letter = "E".into();
        m.crossfeed = m.crossfeed.disabled();
        m.gcode.feed_mode = FeedMode::AllAxes;
        m.gcode.rotary_mode = RotaryMode::WrapEachCircuit;
        m.gcode.header = "G21\nG90\nM211 S0 ; soft endstops off: the spindle axis is endless".into();
        m.gcode.footer = "M400\nM84".into();
        m
    }

    /// Marlin 2.1 built with real rotational axes (`AXIS4_NAME 'A'`,
    /// `AXIS4_ROTATES`), the convention FiberPath uses. `F` follows the
    /// LinuxCNC rule: it applies to the linear axes whenever one moves.
    pub fn marlin_xab() -> Self {
        let mut m = Self::generic_4_axis();
        m.name = "Marlin 2.1, rotary A/B (FiberPath-style)".into();
        m.note = "X carriage, A spindle, B eye rotation as true rotational axes. \
                  Feed applies to the carriage; pure rotations are in deg/min."
            .into();
        m.crossfeed = m.crossfeed.disabled();
        m.gcode.feed_mode = FeedMode::LinearAxes;
        m.gcode.rotary_mode = RotaryMode::WrapEachCircuit;
        m.gcode.header = "G21\nG90".into();
        m.gcode.footer = "M400\nM18".into();
        m
    }

    /// LinuxCNC with a true rotary spindle axis and trivial kinematics.
    pub fn linuxcnc_4_axis() -> Self {
        let mut m = Self::generic_4_axis();
        m.name = "LinuxCNC 4-axis (XYAB)".into();
        m.note = "X carriage, A spindle, Y cross-feed, B eye rotation. Inverse-time feed (G93)."
            .into();
        m.gcode.comments = CommentStyle::Parentheses;
        m.gcode.header = "G21 G90 G64 P0.05".into();
        m.gcode.footer = "G94\nM2".into();
        m
    }

    pub fn presets() -> Vec<MachineProfile> {
        vec![
            Self::generic_4_axis(),
            Self::generic_3_axis(),
            Self::generic_2_axis(),
            Self::linuxcnc_4_axis(),
            Self::marlin_xab(),
            Self::marlin_xyz(),
        ]
    }
}
