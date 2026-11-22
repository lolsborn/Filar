//! `filar` - plan a project and write G-code without the GUI.
//!
//! ```text
//! filar new tube|cone > part.filar     write an example project
//! filar info part.filar                print the layer table and warnings
//! filar analyze part.filar             stiffness and reserve-factor estimate
//! filar gcode part.filar [-o out.gcode]
//! filar plan part.filar                dump the full plan as JSON
//! ```

use std::process::ExitCode;

use filar_core::plan::Level;
use filar_core::{Project, api, gcode, plan};

fn load(path: &str) -> Result<Project, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))
}

/// Write to stdout, exiting quietly if the reader has gone away (`| head`).
fn emit(text: &str) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    if out.write_all(text.as_bytes()).and_then(|_| out.flush()).is_err() {
        std::process::exit(0);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let usage = "usage: filar <new tube|cone | info FILE | analyze FILE | gcode FILE [-o OUT] | plan FILE>";
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["new", kind] => {
            let p = match *kind {
                "tube" => Project::example_tube(),
                "cone" => Project::example_cone(),
                _ => return Err(usage.into()),
            };
            println!("{}", serde_json::to_string_pretty(&p).unwrap());
        }
        ["info", file] => {
            let project = load(file)?;
            let plan = plan(&project);
            println!("{}  ({})", project.name, project.machine.name);
            println!(
                "{:<22} {:>8} {:>7} {:>8} {:>8} {:>9} {:>9} {:>8}",
                "layer", "circuits", "pattern", "dwell°", "cover%", "thick mm", "fibre m", "time"
            );
            for l in &plan.layers {
                let (pat, dwell, cov) = match &l.pattern {
                    Some(p) => (
                        p.pattern_number.to_string(),
                        format!("{:.1}", p.dwell.to_degrees()),
                        format!("{:.0}", p.coverage * 100.0),
                    ),
                    None => ("-".into(), "-".into(), "100".into()),
                };
                println!(
                    "{:<22} {:>8} {:>7} {:>8} {:>8} {:>9.3} {:>9.1} {:>7.0}s",
                    l.name, l.circuits, pat, dwell, cov, l.thickness, l.fiber_length / 1000.0, l.duration
                );
            }
            let t = &plan.totals;
            println!(
                "total: {:.1} m fibre, {:.0} g fibre + {:.0} g resin, wall {:.2} mm, {:.0} min, {} moves",
                t.fiber_length_m,
                t.fiber_mass_g,
                t.resin_mass_g,
                t.wall_thickness,
                t.duration / 60.0,
                t.moves
            );
            for w in &plan.warnings {
                let tag = match w.level {
                    Level::Error => "error",
                    Level::Warn => "warning",
                    Level::Info => "note",
                };
                println!("{tag}: {}", w.message);
            }
        }
        ["analyze", file] => {
            let project = load(file)?;
            let plan = plan(&project);
            let a = filar_core::analysis::analyze(&project, &plan);
            if !a.ok {
                return Err(a.message.unwrap_or_else(|| "nothing to analyse".into()));
            }
            println!("{}  ({}, knock-down {})", project.name, project.analysis.ply.name, project.analysis.knockdown);
            for c in &a.cases {
                let st = &a.stations[c.station];
                let idx = project.analysis.load_cases.iter().position(|l| l.id == c.id).unwrap_or(0);
                let sc = &st.cases[idx];
                let ply = &st.plies[sc.critical];
                println!(
                    "{:<22} reserve factor {:>6.2} at {:.0} mm, ply {} ({:+.0} deg), {:?}",
                    c.name,
                    c.min_rf,
                    st.z,
                    sc.critical + 1,
                    ply.angle_deg,
                    sc.plies[sc.critical].mode
                );
            }
            let (s, c) = (&a.stiffness, &a.capacity);
            println!("stiffness: Ex {:.1} GPa, Ehoop {:.1} GPa, G {:.1} GPa, EI {:.0} N.m2, GJ {:.0} N.m2", s.ex, s.e_hoop, s.g, s.ei, s.gj);
            println!(
                "capacity: first-ply pressure {:.0} bar, netting burst {:.0} bar, bending {:.0} N.m, torque {:.0} N.m, buckling {:.1} kN",
                c.pressure_bar,
                c.netting_burst_bar,
                c.bending_nm,
                c.torque_nm,
                c.buckling_n / 1e3
            );
            println!("estimate for comparing layups; not a substitute for testing");
        }
        ["plan", file] => {
            let project = load(file)?;
            emit(&serde_json::to_string(&plan(&project)).unwrap());
        }
        ["gcode", file, rest @ ..] => {
            let project = load(file)?;
            let plan = plan(&project);
            let errors: Vec<_> = plan.warnings.iter().filter(|w| w.level == Level::Error).collect();
            for w in &errors {
                eprintln!("error: {}", w.message);
            }
            if !errors.is_empty() {
                return Err("refusing to write G-code for a plan with errors".into());
            }
            let g = gcode::generate(&project, &plan);
            match rest {
                ["-o", out] => {
                    std::fs::write(out, &g.text).map_err(|e| format!("{out}: {e}"))?;
                    eprintln!("wrote {out}: {} lines, {} moves", g.lines, g.moves);
                }
                [] => emit(&g.text),
                _ => return Err(usage.into()),
            }
        }
        ["defaults"] => println!("{}", api::defaults_json()),
        _ => return Err(usage.into()),
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
