//! WebAssembly bindings: the same JSON facade the desktop shell uses, so the
//! UI can run in a plain browser with no backend.

use wasm_bindgen::prelude::*;
use filar_core::api;

#[wasm_bindgen]
pub fn defaults() -> String {
    api::defaults_json()
}

#[wasm_bindgen]
pub fn plan(project_json: &str) -> Result<String, JsError> {
    api::plan_json(project_json).map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub fn gcode(project_json: &str) -> Result<String, JsError> {
    api::gcode_json(project_json).map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub fn analyze(project_json: &str) -> Result<String, JsError> {
    api::analyze_json(project_json).map_err(|e| JsError::new(&e))
}
