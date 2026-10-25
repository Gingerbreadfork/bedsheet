use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::Manager;

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
fn has_other_links(_target: &Path, meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    meta.nlink() > 1
}

#[cfg(windows)]
fn has_other_links(target: &Path, _meta: &fs::Metadata) -> bool {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let Ok(file) = File::open(target) else {
        return false;
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) };
    ok != 0 && info.nNumberOfLinks > 1
}

#[cfg(not(any(unix, windows)))]
fn has_other_links(_target: &Path, _meta: &fs::Metadata) -> bool {
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
    if existing
        .as_ref()
        .is_some_and(|meta| has_other_links(&target, meta))
    {
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

#[derive(Serialize)]
struct RecoveryEntry {
    id: String,
    data: String,
}

fn recovery_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("recovery");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// This instance's name in the recovery directory, and the lock it holds there while it runs.
static OWNER: Mutex<Option<(String, File)>> = Mutex::new(None);

fn lock_file(dir: &Path, owner: &str) -> PathBuf {
    dir.join(format!("{owner}.lock"))
}

/// Names this instance and locks its lock file until it exits. A lock rather than a process id
/// shows it is alive, because sandboxed instances can't see each other's processes.
fn recovery_owner(dir: &Path) -> Result<String, String> {
    let mut owner = OWNER.lock().map_err(|e| e.to_string())?;
    if let Some((name, _)) = owner.as_ref() {
        return Ok(name.clone());
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let name = format!("{:x}{nanos:x}", std::process::id());
    let lock = File::create(lock_file(dir, &name)).map_err(|e| e.to_string())?;
    lock.try_lock().map_err(|e| e.to_string())?;
    *owner = Some((name.clone(), lock));
    Ok(name)
}

/// An owner without a lock file, or whose lock is free, has exited.
fn owner_is_running(dir: &Path, owner: &str) -> bool {
    File::open(lock_file(dir, owner)).is_ok_and(|file| file.try_lock().is_err())
}

/// Snapshots are named `<owner>-<id>.json` so a later launch can tell whether their owner is still running.
fn recovery_file(dir: &Path, owner: &str, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("invalid recovery id".into());
    }
    Ok(dir.join(format!("{owner}-{id}.json")))
}

/// Takes over the snapshots left by instances that are no longer running and returns them.
fn claim_recovery_files(dir: &Path, own: &str) -> Vec<RecoveryEntry> {
    let mut found = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return found;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(owner) = name.strip_suffix(".lock") {
            if owner != own && !owner_is_running(dir, owner) {
                let _ = fs::remove_file(entry.path());
            }
            continue;
        }
        let Some((owner, id)) = name
            .strip_suffix(".json")
            .and_then(|stem| stem.split_once('-'))
        else {
            continue;
        };
        if owner == own || owner_is_running(dir, owner) {
            continue;
        }
        let Ok(claimed) = recovery_file(dir, own, id) else {
            continue;
        };
        if fs::rename(entry.path(), &claimed).is_err() {
            continue;
        }
        if let Ok(data) = fs::read_to_string(&claimed) {
            found.push(RecoveryEntry {
                id: id.to_string(),
                data,
            });
        }
    }
    found
}

/// Stores the raw request body as the snapshot named by the `x-id` header.
#[tauri::command(async)]
fn recovery_save(app: tauri::AppHandle, request: Request<'_>) -> Result<(), String> {
    let id = request
        .headers()
        .get("x-id")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-id header")?;
    let bytes: &[u8] = match request.body() {
        InvokeBody::Raw(b) => b,
        InvokeBody::Json(_) => return Err("expected raw body".into()),
    };
    let dir = recovery_dir(&app)?;
    let file = recovery_file(&dir, &recovery_owner(&dir)?, id)?;
    write_atomic(&file, bytes).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn recovery_clear(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let dir = recovery_dir(&app)?;
    let file = recovery_file(&dir, &recovery_owner(&dir)?, &id)?;
    match fs::remove_file(file) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[tauri::command(async)]
fn recovery_pending(app: tauri::AppHandle) -> Result<Vec<RecoveryEntry>, String> {
    let dir = recovery_dir(&app)?;
    Ok(claim_recovery_files(&dir, &recovery_owner(&dir)?))
}

#[derive(Serialize)]
struct ClipContents {
    text: String,
    html: Option<String>,
}

/// Goes through GTK rather than arboard, which needs X11 or a protocol GNOME and sandboxes don't offer.
#[cfg(target_os = "linux")]
mod clip {
    use super::ClipContents;
    use gtk::{gdk, Clipboard, TargetEntry, TargetFlags};
    use std::sync::mpsc;
    use std::time::Duration;

    const TIMEOUT: Duration = Duration::from_secs(5);
    const HTML: u32 = 0;
    const TEXT: u32 = 1;

    fn clipboard() -> Clipboard {
        Clipboard::get(&gdk::SELECTION_CLIPBOARD)
    }

    /// Some browsers offer HTML as UTF-16 with a byte order mark.
    fn decode_html(bytes: &[u8]) -> Option<String> {
        if bytes.is_empty() {
            return None;
        }
        if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
            let units: Vec<u16> = rest
                .as_chunks()
                .0
                .iter()
                .map(|&c| u16::from_le_bytes(c))
                .collect();
            return Some(String::from_utf16_lossy(&units));
        }
        Some(String::from_utf8_lossy(bytes).into_owned())
    }

    pub fn read(app: &tauri::AppHandle) -> Result<ClipContents, String> {
        let (tx, rx) = mpsc::channel();
        app.run_on_main_thread(move || {
            clipboard().request_text(move |board, text| {
                let text = text.unwrap_or_default().to_string();
                board.request_contents(&gdk::Atom::intern("text/html"), move |_, data| {
                    let html = decode_html(&data.data());
                    let _ = tx.send(ClipContents { text, html });
                });
            });
        })
        .map_err(|e| e.to_string())?;
        rx.recv_timeout(TIMEOUT).map_err(|e| e.to_string())
    }

    pub fn write(app: &tauri::AppHandle, text: String, html: Option<String>) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        app.run_on_main_thread(move || {
            let mut targets = vec![
                TargetEntry::new("UTF8_STRING", TargetFlags::empty(), TEXT),
                TargetEntry::new("text/plain;charset=utf-8", TargetFlags::empty(), TEXT),
                TargetEntry::new("text/plain", TargetFlags::empty(), TEXT),
            ];
            if html.is_some() {
                targets.push(TargetEntry::new("text/html", TargetFlags::empty(), HTML));
            }
            // Raw bytes, because GTK's own text setter turns line breaks into CRLF.
            let set = clipboard().set_with_data(&targets, move |_, data, info| {
                let bytes = match (&html, info) {
                    (Some(html), HTML) => html.as_bytes(),
                    _ => text.as_bytes(),
                };
                data.set(&data.target(), 8, bytes);
            });
            let _ = tx.send(set);
        })
        .map_err(|e| e.to_string())?;
        match rx.recv_timeout(TIMEOUT) {
            Ok(true) => Ok(()),
            Ok(false) => Err("could not take the clipboard".into()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod clip {
    use super::ClipContents;

    pub fn read(_app: &tauri::AppHandle) -> Result<ClipContents, String> {
        let mut board = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        let text = board.get_text().unwrap_or_default();
        let html = board.get().html().ok();
        Ok(ClipContents { text, html })
    }

    pub fn write(
        _app: &tauri::AppHandle,
        text: String,
        html: Option<String>,
    ) -> Result<(), String> {
        let mut board = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        match html {
            Some(html) => board.set_html(html, Some(text)),
            None => board.set_text(text),
        }
        .map_err(|e| e.to_string())
    }
}

/// Must stay async: the clipboard is served by the main thread, so waiting there would deadlock.
#[tauri::command(async)]
fn clipboard_read(app: tauri::AppHandle) -> Result<ClipContents, String> {
    clip::read(&app)
}

#[tauri::command(async)]
fn clipboard_write(
    app: tauri::AppHandle,
    text: String,
    html: Option<String>,
) -> Result<(), String> {
    clip::write(&app, text, html)
}

/// File paths passed on the command line, resolved to absolute paths.
fn launch_paths() -> Vec<PathBuf> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .map(|p| dunce::canonicalize(&p).unwrap_or(p))
        .collect()
}

/// The first file is opened in this window; the frontend ignores the rest.
#[tauri::command]
fn launch_files() -> Vec<String> {
    launch_paths()
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// Starts another copy of the app for each file after the first, so every file gets a window.
fn open_extra_files() {
    let files = launch_paths();
    let exe = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok());
    let Some(exe) = exe else { return };
    for file in files.iter().skip(1) {
        let _ = std::process::Command::new(&exe).arg(file).spawn();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    open_extra_files();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            file_info,
            launch_files,
            recovery_save,
            recovery_clear,
            recovery_pending,
            clipboard_read,
            clipboard_write
        ])
        .run(tauri::generate_context!())
        .expect("error while running bedsheet");
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn claims_snapshots_whose_owner_has_exited() {
        let dir = scratch("recovery");
        let live = File::create(lock_file(&dir, "live")).unwrap();
        live.try_lock().unwrap();
        File::create(lock_file(&dir, "gone")).unwrap();
        fs::write(
            recovery_file(&dir, "gone", "abc123").unwrap(),
            "{\"name\":\"a.csv\"}",
        )
        .unwrap();
        fs::write(recovery_file(&dir, "4000000", "old").unwrap(), "{}").unwrap();
        fs::write(recovery_file(&dir, "mine", "own").unwrap(), "{}").unwrap();
        fs::write(recovery_file(&dir, "live", "open").unwrap(), "{}").unwrap();
        fs::write(dir.join("notes.txt"), "unrelated").unwrap();

        let mut found = claim_recovery_files(&dir, "mine");
        found.sort_by(|a, b| a.id.cmp(&b.id));
        let ids: Vec<&str> = found.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["abc123", "old"]);
        assert_eq!(found[0].data, "{\"name\":\"a.csv\"}");
        assert!(recovery_file(&dir, "mine", "abc123").unwrap().exists());
        assert!(!recovery_file(&dir, "gone", "abc123").unwrap().exists());
        assert!(recovery_file(&dir, "live", "open").unwrap().exists());
        assert!(!lock_file(&dir, "gone").exists());
        assert!(lock_file(&dir, "live").exists());
        assert!(claim_recovery_files(&dir, "mine").is_empty());
    }

    #[test]
    fn holds_its_lock_while_running() {
        let dir = scratch("owner");
        let own = recovery_owner(&dir).unwrap();
        assert!(owner_is_running(&dir, &own));
        assert_eq!(recovery_owner(&dir).unwrap(), own);
        assert!(!owner_is_running(&dir, "missing"));
    }

    #[test]
    fn rejects_recovery_ids_that_could_escape_the_directory() {
        let dir = scratch("recovery-id");
        assert!(recovery_file(&dir, "a1", "../evil").is_err());
        assert!(recovery_file(&dir, "a1", "").is_err());
        assert!(recovery_file(&dir, "a1", "ok42").is_ok());
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
    fn replaces_an_existing_file() {
        let dir = scratch("replace");
        let path = dir.join("a.csv");
        fs::write(&path, "old").unwrap();
        write_atomic(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(leftovers(&dir), 0);
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

    #[cfg(unix)]
    mod unix {
        use super::*;
        use std::os::unix::fs::{symlink, PermissionsExt};

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
}
