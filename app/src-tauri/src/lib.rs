//! Desktop shell. All winding logic lives in `filar-core`; this crate only
//! exposes its JSON facade to the web view and handles file access.

use std::path::{Path, PathBuf};

use filar_core::api;
use tauri::Manager;

/// Set `FILAR_TRACE=1` to log every command the web view makes to stderr.
fn trace(command: &str, detail: impl FnOnce() -> String) {
    if std::env::var_os("FILAR_TRACE").is_some() {
        eprintln!("[filar] {command}: {}", detail());
    }
}

// The planner is CPU-bound, so these run off the main thread (`async`).

#[tauri::command(async)]
fn defaults() -> String {
    trace("defaults", String::new);
    api::defaults_json()
}

#[tauri::command(async)]
fn plan(project_json: String) -> Result<String, String> {
    let out = api::plan_json(&project_json);
    trace("plan", || match &out {
        Ok(json) => format!("ok, {} bytes", json.len()),
        Err(e) => format!("error: {e}"),
    });
    out
}

#[tauri::command(async)]
fn gcode(project_json: String) -> Result<String, String> {
    let out = api::gcode_json(&project_json);
    trace("gcode", || match &out {
        Ok(json) => format!("ok, {} bytes", json.len()),
        Err(e) => format!("error: {e}"),
    });
    out
}

#[tauri::command(async)]
fn analyze(project_json: String) -> Result<String, String> {
    let out = api::analyze_json(&project_json);
    trace("analyze", || match &out {
        Ok(json) => format!("ok, {} bytes", json.len()),
        Err(e) => format!("error: {e}"),
    });
    out
}

/// Write a file at a path the user picked in the native save dialog.
#[tauri::command(async)]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    trace("write_text_file", || path.clone());
    std::fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}

/// Read a file the user picked in the native open dialog.
#[tauri::command(async)]
fn read_text_file(path: String) -> Result<String, String> {
    trace("read_text_file", || path.clone());
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

/// The user's material library lives beside the app's other data, so it is
/// shared by every project.
fn library_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("materials.json"))
}

/// The library file's text, or an empty string if it does not exist yet.
fn read_library(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn write_library(path: &Path, json: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    // Write beside the target and rename, so a crash cannot leave half a file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

#[tauri::command(async)]
fn load_library(app: tauri::AppHandle) -> Result<String, String> {
    let path = library_path(&app)?;
    trace("load_library", || path.display().to_string());
    read_library(&path)
}

#[tauri::command(async)]
fn save_library(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = library_path(&app)?;
    trace("save_library", || format!("{} ({} bytes)", path.display(), json.len()));
    write_library(&path, &json)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            defaults,
            plan,
            gcode,
            analyze,
            load_library,
            save_library,
            write_text_file,
            read_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Filar");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_round_trips_and_starts_empty() {
        let dir = std::env::temp_dir().join(format!("filar-library-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // Nested path: the app data folder may not exist on first run.
        let path = dir.join("nested").join("materials.json");
        assert_eq!(read_library(&path).unwrap(), "", "no file yet is not an error");
        write_library(&path, r#"{"version":1,"materials":[],"plies":[]}"#).unwrap();
        assert!(read_library(&path).unwrap().contains("\"version\":1"));
        // Saving again replaces the file and leaves no temporary behind.
        write_library(&path, "{}").unwrap();
        assert_eq!(read_library(&path).unwrap(), "{}");
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
