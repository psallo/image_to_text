mod ocr;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ocr::run_native_ocr])
        .run(tauri::generate_context!())
        .expect("failed to run Tauri application");
}
