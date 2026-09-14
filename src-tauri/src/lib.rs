use std::path::{Path, PathBuf};

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};

#[derive(Serialize)]
struct FileInfo {
    path: String,
    name: String,
    size: u64,
    modified: Option<u64>,
}

fn info_for(path: &Path) -> Result<FileInfo, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    Ok(FileInfo {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        size: meta.len(),
        modified,
    })
}

/// Reads a file and returns its raw bytes, bypassing JSON serialization.
#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

#[tauri::command]
fn file_info(path: String) -> Result<FileInfo, String> {
    info_for(Path::new(&path))
}

/// Writes raw request bytes to the path given in the `x-path` header.
/// Writes to a sibling temp file first, then renames over the target.
#[tauri::command]
fn write_file(request: Request<'_>) -> Result<FileInfo, String> {
    let encoded = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-path header")?;
    let path = PathBuf::from(percent_decode_str(encoded).decode_utf8_lossy().into_owned());
    let bytes: &[u8] = match request.body() {
        InvokeBody::Raw(b) => b,
        InvokeBody::Json(_) => return Err("expected raw body".into()),
    };
    let dir = path.parent().ok_or("invalid path")?;
    let stem = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let tmp = dir.join(format!(".{stem}.bedsheet-{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    info_for(&path)
}

/// File paths passed on the command line, resolved to absolute paths.
#[tauri::command]
fn launch_files() -> Vec<String> {
    std::env::args_os()
        .skip(1)
        .filter_map(|a| {
            let p = PathBuf::from(a);
            if p.is_file() {
                std::fs::canonicalize(&p).ok().or(Some(p))
            } else {
                None
            }
        })
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            file_info,
            launch_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running bedsheet");
}
