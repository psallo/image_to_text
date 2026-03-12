use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{path::BaseDirectory, AppHandle, Manager};

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOcrRequest {
    pub image_bytes: Vec<u8>,
    pub filename: Option<String>,
    pub accuracy: bool,
}

#[tauri::command]
pub async fn run_native_ocr(
    app: AppHandle,
    payload: NativeOcrRequest,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_native_ocr_sync(app, payload))
        .await
        .map_err(|error| error.to_string())?
}

fn run_native_ocr_sync(app: AppHandle, payload: NativeOcrRequest) -> Result<String, String> {
    let sidecar_path = resolve_sidecar_path(&app)?;
    let temp_path = write_temp_image(&payload.image_bytes, payload.filename.as_deref())?;
    let mut command = Command::new(&sidecar_path);
    command
        .arg("--image-path")
        .arg(&temp_path)
        .arg("--profile")
        .arg("auto")
        .args(if payload.accuracy {
            vec!["--accuracy"]
        } else {
            Vec::new()
        });
    configure_command(&mut command);

    let output = command
        .output()
        .map_err(|error| format!("Failed to launch native OCR sidecar: {error}"))?;

    let _ = fs::remove_file(&temp_path);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Native OCR sidecar failed with status {}", output.status)
        } else {
            stderr
        });
    }

    let stdout = decode_output(&output.stdout)?;
    Ok(stdout)
}

fn resolve_sidecar_path(app: &AppHandle) -> Result<PathBuf, String> {
    let sidecar_filename = sidecar_filename();
    let resource_candidate = app
        .path()
        .resolve(format!("binaries/{sidecar_filename}"), BaseDirectory::Resource)
        .ok();
    let resource_root_candidate = app
        .path()
        .resolve(&sidecar_filename, BaseDirectory::Resource)
        .ok();

    let cwd_candidate = std::env::current_dir()
        .ok()
        .map(|dir| dir.join("src-tauri").join("binaries").join(&sidecar_filename));

    let exe_candidates = std::env::current_exe().ok().map(|exe| {
        let mut candidates = Vec::new();
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(&sidecar_filename));
            candidates.push(parent.join("../Resources").join(&sidecar_filename));
        }
        candidates
    });

    let mut candidates = Vec::new();
    if let Some(path) = resource_candidate {
        candidates.push(path);
    }
    if let Some(path) = resource_root_candidate {
        candidates.push(path);
    }
    if let Some(path) = cwd_candidate {
        candidates.push(path);
    }
    if let Some(paths) = exe_candidates {
        candidates.extend(paths);
    }

    candidates
        .iter()
        .find(|path| path.exists())
        .cloned()
        .ok_or_else(|| {
            let tried = candidates
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            format!("Native OCR sidecar not found: {sidecar_filename}. Tried: {tried}")
        })
}

fn write_temp_image(image_bytes: &[u8], filename: Option<&str>) -> Result<PathBuf, String> {
    let extension = filename
        .and_then(|value| Path::new(value).extension())
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("png");

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();

    let path = std::env::temp_dir().join(format!("simple-ocr-{timestamp}.{extension}"));
    fs::write(&path, image_bytes).map_err(|error| format!("Failed to write temp image: {error}"))?;
    Ok(path)
}

fn sidecar_filename() -> String {
    let mut name = format!("native-ocr-{}", current_target_triple());
    if cfg!(target_os = "windows") {
        name.push_str(".exe");
    }
    name
}

fn decode_output(bytes: &[u8]) -> Result<String, String> {
    match String::from_utf8(bytes.to_vec()) {
        Ok(value) => Ok(value),
        Err(error) => {
            let recovered = String::from_utf8_lossy(bytes).to_string();
            if recovered.trim_start().starts_with('{') {
                Ok(recovered)
            } else {
                Err(format!("Failed to decode OCR output: {error}"))
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn configure_command(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn configure_command(_command: &mut Command) {}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn current_target_triple() -> &'static str {
    "aarch64-apple-darwin"
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn current_target_triple() -> &'static str {
    "x86_64-apple-darwin"
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn current_target_triple() -> &'static str {
    "x86_64-pc-windows-msvc"
}

#[cfg(all(target_os = "windows", target_arch = "aarch64"))]
fn current_target_triple() -> &'static str {
    "aarch64-pc-windows-msvc"
}
