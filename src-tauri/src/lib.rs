mod converter;

use tauri_plugin_fs::FsExt;

#[tauri::command]
fn open_profile_url(url: String) -> Result<(), String> {
    match url.as_str() {
        "https://khairulazhar.com" | "https://github.com/Keroyun" => {
            open::that_detached(url).map_err(|error| format!("Could not open the link: {error}"))
        }
        _ => Err("This link is not allowed.".to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if let Some(scope) = window.try_fs_scope() {
                    for path in paths {
                        let result = if path.is_dir() {
                            scope.allow_directory(path, true)
                        } else {
                            scope.allow_file(path)
                        };
                        if let Err(error) = result {
                            eprintln!("Could not approve dropped path: {error}");
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            converter::inspect_file,
            converter::convert_image,
            converter::enhance_image,
            converter::read_file_base64,
            converter::image_as_png_base64,
            converter::write_base64_file,
            converter::convert_media,
            open_profile_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PicFlip");
}
