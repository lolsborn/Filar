//! Filar core: filament winding design, simulation and G-code generation
//! for tubes and tapered mandrels.
//!
//! The crate is UI-agnostic. [`plan::plan`] turns a [`project::Project`] into
//! a timed winding program; [`gcode::generate`] posts that program for a
//! particular machine profile.

pub mod analysis;
pub mod api;
pub mod gcode;
pub mod kinematics;
pub mod machine;
pub mod mandrel;
pub mod path;
pub mod pattern;
pub mod plan;
pub mod project;

pub use machine::MachineProfile;
pub use plan::{Plan, plan};
pub use project::Project;
