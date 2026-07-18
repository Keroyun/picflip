mod converter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            converter::inspect_file,
            converter::convert_image,
            converter::enhance_image,
            converter::read_file_base64,
            converter::image_as_png_base64,
            converter::write_base64_file,
            converter::convert_media,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PicFlip");
}
