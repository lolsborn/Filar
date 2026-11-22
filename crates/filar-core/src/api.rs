//! A small JSON-in / JSON-out facade used by every front end (desktop shell,
//! WebAssembly build, CLI), so they all share one contract.

use serde::Serialize;

use crate::analysis::{self, Analysis, PlyProperties};
use crate::gcode::{self, Gcode};
use crate::machine::MachineProfile;
use crate::plan::{Plan, plan};
use crate::project::{Material, Project};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Defaults {
    pub tube: Project,
    pub cone: Project,
    pub machines: Vec<MachineProfile>,
    pub materials: Vec<Material>,
    pub plies: Vec<PlyProperties>,
    pub version: &'static str,
}

pub fn defaults() -> Defaults {
    Defaults {
        tube: Project::example_tube(),
        cone: Project::example_cone(),
        machines: MachineProfile::presets(),
        materials: vec![
            Material::carbon_12k(),
            Material::flat("Carbon 3k / epoxy", 1.5, 200.0, 1.78, "Carbon / epoxy"),
            Material::flat("Carbon 24k / epoxy", 7.0, 1600.0, 1.80, "Carbon / epoxy"),
            Material::flat("E-glass 1200 tex / epoxy", 4.0, 1200.0, 2.56, "E-glass / epoxy"),
            Material::flat("E-glass 2400 tex / epoxy", 6.0, 2400.0, 2.56, "E-glass / epoxy"),
            Material::flat("Aramid 1580 dtex / epoxy", 1.5, 158.0, 1.44, "Aramid / epoxy"),
            // Round strands. Weights are typical figures; check your own
            // material and edit them.
            Material::round("Polyester rope 3 mm", 3.0, 7.0, "#d9d6cc"),
            Material::round("Nylon cord 4 mm", 4.0, 8.0, "#3f4a57"),
            Material::round("Jute twine 2 mm", 2.0, 2.6, "#b08d57"),
            Material::round("Copper wire 1 mm", 1.0, 7.04, "#c0733a"),
        ],
        plies: PlyProperties::presets(),
        version: env!("CARGO_PKG_VERSION"),
    }
}

fn parse(project_json: &str) -> Result<Project, String> {
    serde_json::from_str(project_json).map_err(|e| format!("Invalid project: {e}"))
}

pub fn plan_project(project_json: &str) -> Result<Plan, String> {
    Ok(plan(&parse(project_json)?))
}

pub fn gcode_project(project_json: &str) -> Result<Gcode, String> {
    let project = parse(project_json)?;
    let plan = plan(&project);
    Ok(gcode::generate(&project, &plan))
}

pub fn analyze_project(project_json: &str) -> Result<Analysis, String> {
    let project = parse(project_json)?;
    let plan = plan(&project);
    Ok(analysis::analyze(&project, &plan))
}

pub fn analyze_json(project_json: &str) -> Result<String, String> {
    analyze_project(project_json).map(|a| serde_json::to_string(&a).expect("analysis serialises"))
}

pub fn defaults_json() -> String {
    serde_json::to_string(&defaults()).expect("defaults serialise")
}

pub fn plan_json(project_json: &str) -> Result<String, String> {
    plan_project(project_json).map(|p| serde_json::to_string(&p).expect("plan serialises"))
}

pub fn gcode_json(project_json: &str) -> Result<String, String> {
    gcode_project(project_json).map(|g| serde_json::to_string(&g).expect("gcode serialises"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_round_trips_through_json() {
        for p in [Project::example_tube(), Project::example_cone()] {
            let json = serde_json::to_string_pretty(&p).unwrap();
            let back: Project = serde_json::from_str(&json).unwrap();
            assert_eq!(p, back);
        }
    }

    /// Projects saved before the analysis settings existed must still open.
    #[test]
    fn older_project_files_still_load() {
        let mut v = serde_json::to_value(Project::example_tube()).unwrap();
        let obj = v.as_object_mut().unwrap();
        obj.remove("analysis");
        obj.remove("variants");
        // Fields added to the material later: shape, colour, linked ply set.
        let material = obj["material"].as_object_mut().unwrap();
        material.remove("shape");
        material.remove("plyName");
        let p: Project = serde_json::from_value(v).unwrap();
        let mut expected = Project::example_tube();
        expected.material.ply_name = None;
        assert_eq!(p, expected);
    }

    #[test]
    fn built_in_materials_all_plan_and_link_to_real_ply_sets() {
        let d = defaults();
        for m in &d.materials {
            let mut project = Project::example_tube();
            project.material = m.clone();
            let plan = plan(&project);
            assert!(!plan.blocks.is_empty(), "{} did not plan: {:?}", m.name, plan.warnings);
            if let Some(ply) = &m.ply_name {
                assert!(d.plies.iter().any(|p| &p.name == ply), "{} links to unknown ply set {ply}", m.name);
            }
        }
        assert!(d.materials.iter().any(|m| m.shape == crate::project::Shape::Round));
    }

    #[test]
    fn json_facade_works_end_to_end() {
        let d: serde_json::Value = serde_json::from_str(&defaults_json()).unwrap();
        let tube = d["tube"].to_string();
        let plan: serde_json::Value = serde_json::from_str(&plan_json(&tube).unwrap()).unwrap();
        assert!(plan["blocks"].as_array().unwrap().len() >= 3);
        assert!(plan["blocks"][0]["samples"]["kind"][0].is_u64());
        let g: serde_json::Value = serde_json::from_str(&gcode_json(&tube).unwrap()).unwrap();
        assert!(g["text"].as_str().unwrap().contains("G93"));
        let a: serde_json::Value = serde_json::from_str(&analyze_json(&tube).unwrap()).unwrap();
        assert_eq!(a["ok"], true);
        assert!(a["minRf"].as_f64().unwrap() > 0.0);
        assert!(plan_json("{").is_err());
    }
}
