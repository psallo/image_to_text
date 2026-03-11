use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{path::BaseDirectory, AppHandle, Manager};

#[cfg(target_os = "windows")]
const SIDECAR_FILENAME: &str = concat!("native-ocr-", env!("TARGET"), ".exe");

#[cfg(not(target_os = "windows"))]
const SIDECAR_FILENAME: &str = concat!("native-ocr-", env!("TARGET"));

#[derive(Clone, serde::Deserialize)]
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
    let output = Command::new(&sidecar_path)
        .arg("--image-path")
        .arg(&temp_path)
        .arg("--profile")
        .arg("auto")
        .args(if payload.accuracy {
            vec!["--accuracy"]
        } else {
            Vec::new()
        })
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

    let stdout = String::from_utf8(output.stdout)
        .map_err(|error| format!("Failed to decode OCR output: {error}"))?;
    Ok(stdout)
}

fn resolve_sidecar_path(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_candidate = app
        .path()
        .resolve(format!("binaries/{SIDECAR_FILENAME}"), BaseDirectory::Resource)
        .ok();

    let cwd_candidate = std::env::current_dir()
        .ok()
        .map(|dir| dir.join("src-tauri").join("binaries").join(SIDECAR_FILENAME));

    let exe_candidates = std::env::current_exe().ok().map(|exe| {
        let mut candidates = Vec::new();
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(SIDECAR_FILENAME));
            candidates.push(parent.join("../Resources").join(SIDECAR_FILENAME));
        }
        candidates
    });

    let mut candidates = Vec::new();
    if let Some(path) = resource_candidate {
        candidates.push(path);
    }
    if let Some(path) = cwd_candidate {
        candidates.push(path);
    }
    if let Some(paths) = exe_candidates {
        candidates.extend(paths);
    }

    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| format!("Native OCR sidecar not found: {SIDECAR_FILENAME}"))
}

fn write_temp_image(image_bytes: &[u8], filename: Option<&str>) -> Result<PathBuf, String> {
    let extension = filename
        .and_then(Path::new().extension())
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
