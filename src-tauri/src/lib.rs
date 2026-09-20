use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
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
#[tauri::command(async)]
fn read_file(path: String) -> Result<Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

#[tauri::command(async)]
fn file_info(path: String) -> Result<FileInfo, String> {
    info_for(Path::new(&path))
}

fn write_in_place(target: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).truncate(true).open(target)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Writes `bytes` to a new sibling of `target` carrying the mode and owner of `existing`.
fn write_temp(tmp: &Path, bytes: &[u8], existing: Option<&fs::Metadata>) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(tmp)?;
    file.write_all(bytes)?;
    if let Some(meta) = existing {
        fs::set_permissions(tmp, meta.permissions())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let own = file.metadata()?;
            if own.uid() != meta.uid() || own.gid() != meta.gid() {
                std::os::unix::fs::chown(tmp, Some(meta.uid()), Some(meta.gid()))?;
            }
        }
    }
    file.sync_all()
}

#[cfg(unix)]
fn has_other_links(meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    meta.nlink() > 1
}

#[cfg(not(unix))]
fn has_other_links(_: &fs::Metadata) -> bool {
    false
}

/// Replaces the file atomically, writing through symlinks and keeping its mode and owner.
/// Overwrites in place when it isn't permitted to create a sibling or give it the original's owner.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let dir = target
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let existing = fs::metadata(&target).ok();
    if existing.as_ref().is_some_and(has_other_links) {
        return write_in_place(&target, bytes);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(".bedsheet-{}-{stamp}.tmp", std::process::id()));
    let staged =
        write_temp(&tmp, bytes, existing.as_ref()).and_then(|()| fs::rename(&tmp, &target));
    if let Err(e) = staged {
        let _ = fs::remove_file(&tmp);
        return if existing.is_some() && e.kind() == io::ErrorKind::PermissionDenied {
            write_in_place(&target, bytes)
        } else {
            Err(e)
        };
    }
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Writes raw request bytes to the path given in the `x-path` header.
#[tauri::command(async)]
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
    write_atomic(&path, bytes).map_err(|e| e.to_string())?;
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bedsheet-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn leftovers(dir: &Path) -> usize {
        fs::read_dir(dir)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".tmp")
            })
            .count()
    }

    #[test]
    fn creates_a_new_file() {
        let dir = scratch("new");
        let path = dir.join("a.csv");
        write_atomic(&path, b"a,b\n").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"a,b\n");
        assert_eq!(leftovers(&dir), 0);
    }

    #[test]
    fn keeps_the_mode_of_an_existing_file() {
        let dir = scratch("mode");
        let path = dir.join("private.csv");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        write_atomic(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn writes_through_a_symlink() {
        let dir = scratch("link");
        let real = dir.join("real.csv");
        let link = dir.join("link.csv");
        fs::write(&real, "old").unwrap();
        symlink(&real, &link).unwrap();
        write_atomic(&link, b"new").unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&real).unwrap(), b"new");
    }

    #[test]
    fn keeps_hard_links_pointing_at_the_same_file() {
        let dir = scratch("hard");
        let path = dir.join("a.csv");
        let other = dir.join("b.csv");
        fs::write(&path, "old").unwrap();
        fs::hard_link(&path, &other).unwrap();
        write_atomic(&path, b"new").unwrap();
        assert_eq!(fs::read(&other).unwrap(), b"new");
    }

    #[test]
    fn overwrites_in_place_when_the_directory_is_read_only() {
        let dir = scratch("readonly");
        let path = dir.join("a.csv");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        let result = write_atomic(&path, b"new");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        result.unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
    }
}
