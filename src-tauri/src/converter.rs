use std::{
    fs::{self, File},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    time::Instant,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{
    codecs::{jpeg::JpegEncoder, png::PngEncoder},
    imageops::{self, FilterType},
    DynamicImage, GenericImageView, ImageEncoder, ImageFormat, ImageReader, Limits, Rgb, RgbImage,
    RgbaImage,
};
use serde::{Deserialize, Serialize};
use tauri_plugin_fs::FsExt;
use tauri_plugin_shell::ShellExt;

const MAX_IN_MEMORY_BYTES: u64 = 256 * 1024 * 1024;
const MAX_MEDIA_SOURCE_BYTES: u64 = 50 * 1024 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 16_384;
const MAX_IMAGE_PIXELS: u64 = 100_000_000;
const MAX_IMAGE_ALLOCATION: u64 = 512 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    path: String,
    name: String,
    extension: String,
    size: u64,
    width: Option<u32>,
    height: Option<u32>,
    thumbnail_data_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionOptions {
    output_directory: String,
    target_format: String,
    quality: u8,
    resize_mode: String,
    scale_percent: f64,
    width: Option<u32>,
    height: Option<u32>,
    preserve_aspect_ratio: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceOptions {
    output_directory: String,
    target_format: String,
    quality: u8,
    upscale: u32,
    strength: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaOptions {
    output_directory: String,
    target_format: String,
    kind: String,
    audio_bitrate: u32,
    gif_fps: u32,
    gif_width: u32,
    video_quality: String,
    video_height: u32,
    keep_audio: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionResult {
    output_path: String,
    bytes_before: u64,
    bytes_after: u64,
    duration_ms: u128,
}

#[tauri::command]
pub fn inspect_file(app: tauri::AppHandle, path: String) -> Result<FileInfo, String> {
    let source = approved_source_file(&app, &path, MAX_MEDIA_SOURCE_BYTES)?;
    inspect_file_impl(&source)
}

fn inspect_file_impl(source: &Path) -> Result<FileInfo, String> {
    let metadata = fs::metadata(source).map_err(display_error)?;
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "The file name is not valid UTF-8.".to_string())?
        .to_string();
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("file")
        .to_lowercase();

    let decoded = read_image(source).ok();
    let dimensions = decoded.as_ref().map(DynamicImage::dimensions);
    let thumbnail_data_url = decoded.as_ref().map(image_thumbnail).transpose()?;

    Ok(FileInfo {
        path: source.to_string_lossy().into_owned(),
        name,
        extension,
        size: metadata.len(),
        width: dimensions.map(|value| value.0),
        height: dimensions.map(|value| value.1),
        thumbnail_data_url,
    })
}

#[tauri::command]
pub fn convert_image(
    app: tauri::AppHandle,
    path: String,
    options: ConversionOptions,
) -> Result<ConversionResult, String> {
    let source = approved_source_file(&app, &path, MAX_IN_MEMORY_BYTES)?;
    let output_directory = approved_output_directory(&app, &options.output_directory)?;
    convert_image_impl(&source, &output_directory, &options)
}

fn convert_image_impl(
    source: &Path,
    output_directory: &Path,
    options: &ConversionOptions,
) -> Result<ConversionResult, String> {
    let started_at = Instant::now();
    let bytes_before = fs::metadata(source).map_err(display_error)?.len();
    let decoded = read_image(source)?;
    let converted = resize_image(decoded, &options)?;
    let extension = normalized_image_extension(&options.target_format)?;
    let output_path = available_output_path(source, output_directory, extension);

    encode_image(&converted, &output_path, extension, options.quality)?;
    conversion_result(output_path, bytes_before, started_at)
}

#[tauri::command]
pub fn enhance_image(
    app: tauri::AppHandle,
    path: String,
    options: EnhanceOptions,
) -> Result<ConversionResult, String> {
    let source = approved_source_file(&app, &path, MAX_IN_MEMORY_BYTES)?;
    let output_directory = approved_output_directory(&app, &options.output_directory)?;
    enhance_image_impl(&source, &output_directory, &options)
}

fn enhance_image_impl(
    source: &Path,
    output_directory: &Path,
    options: &EnhanceOptions,
) -> Result<ConversionResult, String> {
    let started_at = Instant::now();
    let bytes_before = fs::metadata(source).map_err(display_error)?.len();
    let decoded = read_image(source)?;

    if !matches!(options.upscale, 1 | 2 | 4) {
        return Err("Upscale must be 1×, 2×, or 4×.".to_string());
    }
    let target_width = decoded
        .width()
        .checked_mul(options.upscale)
        .ok_or_else(|| "The requested image size is too large.".to_string())?;
    let target_height = decoded
        .height()
        .checked_mul(options.upscale)
        .ok_or_else(|| "The requested image size is too large.".to_string())?;
    validate_image_dimensions(target_width, target_height)?;
    let upscaled = decoded.resize_exact(target_width, target_height, FilterType::Lanczos3);
    let (blur, sigma, threshold) = match options.strength.as_str() {
        "gentle" => (0.18, 0.65, 3),
        "strong" => (0.45, 1.15, 2),
        _ => (0.30, 0.85, 3),
    };
    let enhanced = upscaled.blur(blur).unsharpen(sigma, threshold);
    let extension = normalized_image_extension(&options.target_format)?;
    let output_path = available_named_output_path(source, output_directory, "-enhanced", extension);
    encode_image(&enhanced, &output_path, extension, options.quality)?;
    conversion_result(output_path, bytes_before, started_at)
}

#[tauri::command]
pub fn read_file_base64(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let source = approved_source_file(&app, &path, MAX_IN_MEMORY_BYTES)?;
    fs::read(source)
        .map(|bytes| STANDARD.encode(bytes))
        .map_err(display_error)
}

#[tauri::command]
pub fn image_as_png_base64(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let source = approved_source_file(&app, &path, MAX_IN_MEMORY_BYTES)?;
    let image = read_image(&source)?.to_rgba8();
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(display_error)?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
pub fn write_base64_file(
    app: tauri::AppHandle,
    output_directory: String,
    preferred_name: String,
    data_base64: String,
) -> Result<String, String> {
    let directory = approved_output_directory(&app, &output_directory)?;
    let safe_name = Path::new(&preferred_name)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "The output file name is invalid.".to_string())?;
    let estimated_bytes = data_base64.len().saturating_mul(3) / 4;
    if estimated_bytes as u64 > MAX_IN_MEMORY_BYTES {
        return Err("The generated file is too large to process safely.".to_string());
    }
    let bytes = STANDARD
        .decode(data_base64)
        .map_err(|error| format!("Could not decode the generated file: {error}"))?;
    if bytes.len() as u64 > MAX_IN_MEMORY_BYTES {
        return Err("The generated file is too large to process safely.".to_string());
    }
    let output_path = available_file_path(&directory, safe_name);
    fs::write(&output_path, bytes).map_err(display_error)?;
    Ok(output_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn convert_media(
    app: tauri::AppHandle,
    path: String,
    options: MediaOptions,
) -> Result<ConversionResult, String> {
    let started_at = Instant::now();
    let source = approved_source_file(&app, &path, MAX_MEDIA_SOURCE_BYTES)?;
    let output_directory = approved_output_directory(&app, &options.output_directory)?;
    let extension = normalized_media_extension(&options.kind, &options.target_format)?;
    let output_path = available_output_path(&source, &output_directory, extension);
    let bytes_before = fs::metadata(&source).map_err(display_error)?.len();
    let args = media_arguments(&source, &output_path, &options)?;

    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(display_error)?
        .args(args)
        .output()
        .await
        .map_err(display_error)?;

    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr);
        let concise = details
            .lines()
            .rev()
            .take(8)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!("FFmpeg could not convert this file.\n{concise}"));
    }

    conversion_result(output_path, bytes_before, started_at)
}

fn image_thumbnail(image: &DynamicImage) -> Result<String, String> {
    let thumbnail = image.thumbnail(320, 220).to_rgba8();
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(
            thumbnail.as_raw(),
            thumbnail.width(),
            thumbnail.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(display_error)?;
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}

fn ensure_source_file(path: &Path, maximum_bytes: u64) -> Result<(), String> {
    if !path.is_file() {
        return Err("The selected file no longer exists.".to_string());
    }
    let size = fs::metadata(path).map_err(display_error)?.len();
    if size > maximum_bytes {
        return Err("The selected file is too large to process safely.".to_string());
    }
    Ok(())
}

fn approved_source_file(
    app: &tauri::AppHandle,
    path: &str,
    maximum_bytes: u64,
) -> Result<PathBuf, String> {
    let canonical = Path::new(path)
        .canonicalize()
        .map_err(|_| "The selected file no longer exists.".to_string())?;
    if !app.fs_scope().is_allowed(&canonical) {
        return Err("Access to this file was not approved. Please select it again.".to_string());
    }
    ensure_source_file(&canonical, maximum_bytes)?;
    Ok(canonical)
}

fn approved_output_directory(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
    let directory = Path::new(path)
        .canonicalize()
        .map_err(|_| "Please choose a valid output folder.".to_string())?;
    if !directory.is_dir() {
        return Err("Please choose a valid output folder.".to_string());
    }
    if !app.fs_scope().is_allowed(&directory) {
        return Err(
            "Access to this output folder was not approved. Please choose it again.".to_string(),
        );
    }
    Ok(directory)
}

fn read_image(path: &Path) -> Result<DynamicImage, String> {
    let mut reader = ImageReader::open(path)
        .map_err(display_error)?
        .with_guessed_format()
        .map_err(display_error)?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_IMAGE_ALLOCATION);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|error| format!("Could not decode {}: {error}", path.display()))?;
    validate_image_dimensions(image.width(), image.height())?;
    Ok(image)
}

fn validate_image_dimensions(width: u32, height: u32) -> Result<(), String> {
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| "The requested image size is too large.".to_string())?;
    if width == 0
        || height == 0
        || width > MAX_IMAGE_DIMENSION
        || height > MAX_IMAGE_DIMENSION
        || pixels > MAX_IMAGE_PIXELS
    {
        return Err(format!(
            "Images are limited to {MAX_IMAGE_DIMENSION}px per side and {MAX_IMAGE_PIXELS} pixels."
        ));
    }
    Ok(())
}

fn resize_image(image: DynamicImage, options: &ConversionOptions) -> Result<DynamicImage, String> {
    match options.resize_mode.as_str() {
        "original" => Ok(image),
        "percentage" => {
            if !(1.0..=400.0).contains(&options.scale_percent) {
                return Err("Resize percentage must be between 1 and 400.".to_string());
            }
            let width =
                ((image.width() as f64 * options.scale_percent / 100.0).round() as u32).max(1);
            let height =
                ((image.height() as f64 * options.scale_percent / 100.0).round() as u32).max(1);
            validate_image_dimensions(width, height)?;
            Ok(image.resize_exact(width, height, FilterType::Lanczos3))
        }
        "dimensions" => {
            let width = options
                .width
                .ok_or_else(|| "A target width is required.".to_string())?
                .max(1);
            let height = options
                .height
                .ok_or_else(|| "A target height is required.".to_string())?
                .max(1);
            validate_image_dimensions(width, height)?;
            if options.preserve_aspect_ratio {
                Ok(image.resize(width, height, FilterType::Lanczos3))
            } else {
                Ok(image.resize_exact(width, height, FilterType::Lanczos3))
            }
        }
        _ => Err("Unknown resize mode.".to_string()),
    }
}

fn normalized_image_extension(format: &str) -> Result<&'static str, String> {
    match format.to_lowercase().as_str() {
        "webp" => Ok("webp"),
        "jpg" | "jpeg" => Ok("jpg"),
        "png" => Ok("png"),
        "ico" => Ok("ico"),
        "bmp" => Ok("bmp"),
        "tif" | "tiff" => Ok("tiff"),
        _ => Err(format!("Unsupported output format: {format}")),
    }
}

fn normalized_media_extension(kind: &str, format: &str) -> Result<&'static str, String> {
    match (kind, format.to_lowercase().as_str()) {
        ("audio", "mp3") => Ok("mp3"),
        ("audio", "wav") => Ok("wav"),
        ("audio", "aac") => Ok("aac"),
        ("video", "mp4") => Ok("mp4"),
        ("video", "mov") => Ok("mov"),
        ("video", "mkv") => Ok("mkv"),
        ("video", "avi") => Ok("avi"),
        ("video", "gif") => Ok("gif"),
        _ => Err(format!("Unsupported {kind} output format: {format}")),
    }
}

fn available_output_path(source: &Path, directory: &Path, extension: &str) -> PathBuf {
    available_named_output_path(source, directory, "", extension)
}

fn available_named_output_path(
    source: &Path,
    directory: &Path,
    suffix: &str,
    extension: &str,
) -> PathBuf {
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("converted");
    let preferred = format!("{stem}{suffix}.{extension}");
    let candidate = directory.join(&preferred);
    let source_matches_candidate = source
        .canonicalize()
        .ok()
        .zip(candidate.canonicalize().ok())
        .is_some_and(|(left, right)| left == right);
    if !candidate.exists() && !source_matches_candidate {
        return candidate;
    }
    for index in 1..10_000 {
        let candidate = directory.join(format!("{stem}{suffix}-{index}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("{stem}{suffix}-converted.{extension}"))
}

fn available_file_path(directory: &Path, preferred_name: &str) -> PathBuf {
    let preferred = Path::new(preferred_name);
    let stem = preferred
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("converted");
    let extension = preferred.extension().and_then(|value| value.to_str());
    let candidate = directory.join(preferred_name);
    if !candidate.exists() {
        return candidate;
    }
    for index in 1..10_000 {
        let name = extension.map_or_else(
            || format!("{stem}-{index}"),
            |ext| format!("{stem}-{index}.{ext}"),
        );
        let candidate = directory.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("{stem}-converted"))
}

fn encode_image(
    image: &DynamicImage,
    output_path: &Path,
    format: &str,
    quality: u8,
) -> Result<(), String> {
    let quality = quality.clamp(1, 100);
    match format {
        "jpg" => {
            let file = File::create(output_path).map_err(display_error)?;
            let mut writer = BufWriter::new(file);
            let rgb = flatten_alpha_on_white(image);
            JpegEncoder::new_with_quality(&mut writer, quality)
                .encode(
                    rgb.as_raw(),
                    rgb.width(),
                    rgb.height(),
                    image::ExtendedColorType::Rgb8,
                )
                .map_err(display_error)?;
            writer.flush().map_err(display_error)
        }
        "png" => {
            let file = File::create(output_path).map_err(display_error)?;
            let mut writer = BufWriter::new(file);
            let rgba = image.to_rgba8();
            PngEncoder::new(&mut writer)
                .write_image(
                    rgba.as_raw(),
                    rgba.width(),
                    rgba.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(display_error)?;
            writer.flush().map_err(display_error)
        }
        "webp" => {
            let rgba = image.to_rgba8();
            let encoder = webp::Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height());
            let encoded = encoder.encode(quality as f32);
            fs::write(output_path, &*encoded).map_err(display_error)
        }
        "ico" => icon_image(image)
            .save_with_format(output_path, ImageFormat::Ico)
            .map_err(display_error),
        "bmp" => image
            .save_with_format(output_path, ImageFormat::Bmp)
            .map_err(display_error),
        "tiff" => image
            .save_with_format(output_path, ImageFormat::Tiff)
            .map_err(display_error),
        _ => Err(format!("Unsupported output format: {format}")),
    }
}

fn icon_image(image: &DynamicImage) -> DynamicImage {
    let max_dimension = image.width().max(image.height()).clamp(1, 256);
    let resized = image
        .resize(max_dimension, max_dimension, FilterType::Lanczos3)
        .to_rgba8();
    let side = resized.width().max(resized.height());
    let mut canvas = RgbaImage::new(side, side);
    let x = (side - resized.width()) / 2;
    let y = (side - resized.height()) / 2;
    imageops::overlay(&mut canvas, &resized, i64::from(x), i64::from(y));
    DynamicImage::ImageRgba8(canvas)
}

fn flatten_alpha_on_white(image: &DynamicImage) -> RgbImage {
    let rgba = image.to_rgba8();
    let mut output = RgbImage::new(rgba.width(), rgba.height());
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let alpha = pixel[3] as u16;
        let inverse = 255 - alpha;
        let blend =
            |channel: u8| -> u8 { (((channel as u16 * alpha) + (255 * inverse)) / 255) as u8 };
        output.put_pixel(
            x,
            y,
            Rgb([blend(pixel[0]), blend(pixel[1]), blend(pixel[2])]),
        );
    }
    output
}

fn media_arguments(
    source: &Path,
    output: &Path,
    options: &MediaOptions,
) -> Result<Vec<String>, String> {
    let input = source.to_string_lossy().into_owned();
    let destination = output.to_string_lossy().into_owned();
    let bitrate = options.audio_bitrate.clamp(64, 512);
    let fps = options.gif_fps.clamp(5, 30);
    let width = options.gif_width.clamp(240, 1920);
    let args = match (options.kind.as_str(), options.target_format.as_str()) {
        ("audio", "mp3") => vec![
            "-y".into(),
            "-i".into(),
            input,
            "-vn".into(),
            "-c:a".into(),
            "libmp3lame".into(),
            "-b:a".into(),
            format!("{bitrate}k"),
            destination,
        ],
        ("audio", "wav") => vec![
            "-y".into(),
            "-i".into(),
            input,
            "-vn".into(),
            "-c:a".into(),
            "pcm_s16le".into(),
            destination,
        ],
        ("audio", "aac") => vec![
            "-y".into(),
            "-i".into(),
            input,
            "-vn".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            format!("{bitrate}k"),
            "-f".into(),
            "adts".into(),
            destination,
        ],
        ("video", "gif") => vec![
            "-y".into(),
            "-i".into(),
            input,
            "-filter_complex".into(),
            format!("[0:v]fps={fps},scale={width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle"),
            "-loop".into(),
            "0".into(),
            "-an".into(),
            destination,
        ],
        ("video", "mp4" | "mov" | "mkv" | "avi") => {
            video_arguments(input, destination, options)
        }
        _ => return Err("Unsupported media conversion.".to_string()),
    };
    Ok(args)
}

fn video_arguments(input: String, destination: String, options: &MediaOptions) -> Vec<String> {
    let format = options.target_format.as_str();
    let filter = if options.video_height == 0 {
        "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos".to_string()
    } else {
        let height = options.video_height.clamp(360, 2160);
        format!("scale=-2:trunc(min({height}\\,ih)/2)*2:flags=lanczos")
    };
    let mut args = vec![
        "-y".into(),
        "-i".into(),
        input,
        "-map".into(),
        "0:v:0".into(),
        "-vf".into(),
        filter,
    ];

    if format == "avi" {
        let quality = match options.video_quality.as_str() {
            "high" => "2",
            "compact" => "6",
            _ => "4",
        };
        args.extend(["-c:v", "mpeg4", "-q:v", quality, "-pix_fmt", "yuv420p"].map(str::to_string));
    } else {
        let crf = match options.video_quality.as_str() {
            "high" => "18",
            "compact" => "27",
            _ => "22",
        };
        args.extend(
            [
                "-c:v", "libx264", "-preset", "medium", "-crf", crf, "-pix_fmt", "yuv420p",
            ]
            .map(str::to_string),
        );
    }

    if options.keep_audio {
        args.extend(["-map", "0:a:0?"].map(str::to_string));
        if format == "avi" {
            args.extend(["-c:a", "libmp3lame", "-b:a", "192k"].map(str::to_string));
        } else {
            args.extend(["-c:a", "aac", "-b:a", "192k"].map(str::to_string));
        }
    } else {
        args.push("-an".into());
    }

    if matches!(format, "mp4" | "mov") {
        args.extend(["-movflags", "+faststart"].map(str::to_string));
    }
    args.push(destination);
    args
}

fn conversion_result(
    output_path: PathBuf,
    bytes_before: u64,
    started_at: Instant,
) -> Result<ConversionResult, String> {
    let bytes_after = fs::metadata(&output_path).map_err(display_error)?.len();
    Ok(ConversionResult {
        output_path: output_path.to_string_lossy().into_owned(),
        bytes_before,
        bytes_after,
        duration_ms: started_at.elapsed().as_millis(),
    })
}

fn display_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_directory() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("picflip-test-{}-{unique}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn normalizes_supported_extensions() {
        assert_eq!(normalized_image_extension("JPEG").unwrap(), "jpg");
        assert_eq!(normalized_image_extension("ico").unwrap(), "ico");
        assert!(normalized_image_extension("pdf").is_err());
    }

    #[test]
    fn rejects_oversized_image_dimensions() {
        assert!(validate_image_dimensions(MAX_IMAGE_DIMENSION, 1).is_ok());
        assert!(validate_image_dimensions(MAX_IMAGE_DIMENSION + 1, 1).is_err());
        assert!(validate_image_dimensions(10_001, 10_001).is_err());
    }

    #[test]
    fn alpha_is_blended_onto_white_for_jpeg() {
        let image = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            1,
            1,
            image::Rgba([0, 0, 0, 0]),
        ));
        assert_eq!(
            flatten_alpha_on_white(&image).get_pixel(0, 0),
            &Rgb([255, 255, 255])
        );
    }

    #[test]
    fn converts_resizes_and_creates_icon() {
        let directory = temporary_directory();
        let input = directory.join("sample.png");
        DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            40,
            20,
            image::Rgba([72, 140, 210, 180]),
        ))
        .save_with_format(&input, ImageFormat::Png)
        .unwrap();
        let options = ConversionOptions {
            output_directory: directory.to_string_lossy().into_owned(),
            target_format: "ico".into(),
            quality: 80,
            resize_mode: "percentage".into(),
            scale_percent: 50.0,
            width: None,
            height: None,
            preserve_aspect_ratio: true,
        };
        let result = convert_image_impl(&input, &directory, &options).unwrap();
        let output = read_image(Path::new(&result.output_path)).unwrap();
        assert_eq!(output.dimensions(), (20, 20));
        assert!(result.bytes_after > 0);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn clean_upscale_doubles_dimensions() {
        let directory = temporary_directory();
        let input = directory.join("tiny.png");
        DynamicImage::new_rgba8(8, 6).save(&input).unwrap();
        let options = EnhanceOptions {
            output_directory: directory.to_string_lossy().into_owned(),
            target_format: "png".into(),
            quality: 90,
            upscale: 2,
            strength: "standard".into(),
        };
        let result = enhance_image_impl(&input, &directory, &options).unwrap();
        assert_eq!(
            read_image(Path::new(&result.output_path))
                .unwrap()
                .dimensions(),
            (16, 12)
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn media_arguments_are_passed_without_a_shell() {
        let options = MediaOptions {
            output_directory: String::new(),
            target_format: "gif".into(),
            kind: "video".into(),
            audio_bitrate: 192,
            gif_fps: 12,
            gif_width: 720,
            video_quality: "balanced".into(),
            video_height: 1080,
            keep_audio: true,
        };
        let args = media_arguments(
            Path::new("movie sample.mp4"),
            Path::new("movie.gif"),
            &options,
        )
        .unwrap();
        assert!(args.contains(&"movie sample.mp4".to_string()));
        assert!(args
            .iter()
            .any(|arg| arg.contains("palettegen=stats_mode=diff")));
    }

    #[test]
    fn mov_uses_h264_and_optional_audio_mapping() {
        let options = MediaOptions {
            output_directory: String::new(),
            target_format: "mov".into(),
            kind: "video".into(),
            audio_bitrate: 192,
            gif_fps: 12,
            gif_width: 720,
            video_quality: "high".into(),
            video_height: 1080,
            keep_audio: true,
        };
        let args =
            media_arguments(Path::new("input.webm"), Path::new("output.mov"), &options).unwrap();
        assert!(args.contains(&"libx264".to_string()));
        assert!(args.contains(&"18".to_string()));
        assert!(args.contains(&"0:a:0?".to_string()));
        assert!(args.contains(&"+faststart".to_string()));
    }
}
