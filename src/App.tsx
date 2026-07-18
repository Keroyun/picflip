import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { createPdfFromPngImages, renderPdfToImages } from "./pdfTools";

type Mode = "images" | "pdf" | "audio" | "video" | "enhance";
type PdfDirection = "pdf-to-images" | "images-to-pdf";
type QueueStatus = "ready" | "converting" | "done" | "error";
type ImageFormat = "png" | "jpg" | "webp" | "ico" | "bmp" | "tiff";
type ResizeMode = "original" | "percentage" | "dimensions";
type VideoFormat = "mp4" | "mov" | "mkv" | "avi" | "gif";
type VideoQuality = "high" | "balanced" | "compact";

interface FileInfo {
  path: string;
  name: string;
  extension: string;
  size: number;
  width: number | null;
  height: number | null;
  thumbnailDataUrl: string | null;
}

interface ConversionResult {
  outputPath: string;
  bytesBefore: number;
  bytesAfter: number;
  durationMs: number;
}

interface QueueItem extends FileInfo {
  id: string;
  status: QueueStatus;
  result?: ConversionResult;
  error?: string;
}

const imageExtensions = ["jpg", "jpeg", "png", "webp", "ico", "bmp", "tif", "tiff", "gif"];
const imageFormats: ImageFormat[] = ["png", "jpg", "webp", "ico", "bmp", "tiff"];
const modeCopy: Record<Mode, { title: string; subtitle: string; add: string; empty: string }> = {
  images: { title: "Image Converter", subtitle: "PNG ↔ JPG ↔ WebP ↔ ICO ↔ BMP ↔ TIFF", add: "Add images", empty: "Add images to start converting" },
  pdf: { title: "PDF Tools", subtitle: "Turn PDF pages into images, or combine images into one PDF", add: "Add files", empty: "Add a PDF or a set of images" },
  audio: { title: "Audio Converter", subtitle: "MP3 ↔ WAV ↔ AAC", add: "Add audio", empty: "Add audio files to start converting" },
  video: { title: "Video & GIF", subtitle: "MP4 · MOV · MKV · AVI · WebM · GIF", add: "Add videos", empty: "Add a video or GIF to start converting" },
  enhance: { title: "Clean Upscale", subtitle: "Smooth blockiness, sharpen edges, and enlarge locally", add: "Add images", empty: "Add pixelated images to clean up" },
};

const fontScaleStorageKey = "picflip-interface-font-scale";
const fontScaleMin = 90;
const fontScaleMax = 130;

function savedFontScale() {
  try {
    const value = Number(window.localStorage.getItem(fontScaleStorageKey));
    if (Number.isFinite(value) && value >= fontScaleMin && value <= fontScaleMax) return value;
  } catch {
    // Local storage can be unavailable in locked-down environments. The default still works.
  }
  return 100;
}

function App() {
  const [mode, setMode] = useState<Mode>("images");
  const [pdfDirection, setPdfDirection] = useState<PdfDirection>("pdf-to-images");
  const [items, setItems] = useState<QueueItem[]>([]);
  const [outputDirectory, setOutputDirectory] = useState("");
  const [outputFormat, setOutputFormat] = useState<ImageFormat>("webp");
  const [quality, setQuality] = useState(84);
  const [resizeMode, setResizeMode] = useState<ResizeMode>("original");
  const [scalePercent, setScalePercent] = useState(75);
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [preserveAspectRatio, setPreserveAspectRatio] = useState(true);
  const [upscale, setUpscale] = useState<1 | 2 | 4>(2);
  const [enhanceStrength, setEnhanceStrength] = useState("standard");
  const [audioFormat, setAudioFormat] = useState<"mp3" | "wav" | "aac">("mp3");
  const [audioBitrate, setAudioBitrate] = useState(192);
  const [videoFormat, setVideoFormat] = useState<VideoFormat>("mp4");
  const [videoQuality, setVideoQuality] = useState<VideoQuality>("balanced");
  const [videoHeight, setVideoHeight] = useState(0);
  const [keepAudio, setKeepAudio] = useState(true);
  const [gifFps, setGifFps] = useState(12);
  const [gifWidth, setGifWidth] = useState(720);
  const [pdfImageFormat, setPdfImageFormat] = useState<"png" | "jpg" | "webp">("png");
  const [pdfScale, setPdfScale] = useState(2);
  const [isDragging, setIsDragging] = useState(false);
  const [isInspecting, setIsInspecting] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [notice, setNotice] = useState("");
  const [fontScale, setFontScale] = useState(savedFontScale);

  useEffect(() => {
    document.documentElement.style.fontSize = `${fontScale}%`;
    try {
      window.localStorage.setItem(fontScaleStorageKey, String(fontScale));
    } catch {
      // Keep the control usable for this session even if preferences cannot be stored.
    }
  }, [fontScale]);

  const acceptedExtensions = useMemo(() => {
    if (mode === "images" || mode === "enhance") return imageExtensions;
    if (mode === "pdf") return pdfDirection === "pdf-to-images" ? ["pdf"] : imageExtensions;
    if (mode === "audio") return ["mp3", "wav", "aac", "m4a"];
    return ["mp4", "mov", "m4v", "mkv", "avi", "webm", "gif"];
  }, [mode, pdfDirection]);

  const completedCount = items.filter((item) => item.status === "done").length;
  const failedCount = items.filter((item) => item.status === "error").length;
  const totalBefore = items.reduce((sum, item) => sum + item.size, 0);
  const totalAfter = items.reduce((sum, item) => sum + (item.result?.bytesAfter ?? 0), 0);
  const progress = items.length ? ((completedCount + failedCount) / items.length) * 100 : 0;

  const addPaths = useCallback(async (paths: string[]) => {
    const allowed = new Set(acceptedExtensions);
    const existing = new Set(items.map((item) => item.path));
    const accepted = paths.filter((path) => allowed.has(path.split(".").pop()?.toLowerCase() ?? "") && !existing.has(path));
    if (!accepted.length) {
      if (paths.length) setNotice(`No new supported ${mode === "audio" ? "audio" : mode === "video" ? "video" : "files"} were found.`);
      return;
    }
    setIsInspecting(true);
    setNotice("");
    const results = await Promise.allSettled(accepted.map((path) => invoke<FileInfo>("inspect_file", { path })));
    const timestamp = Date.now();
    const valid = results.flatMap((result, index) => result.status === "fulfilled"
      ? [{ ...result.value, id: `${timestamp}-${index}-${result.value.path}`, status: "ready" as const }]
      : []);
    setItems((current) => [...current, ...valid]);
    const rejected = results.length - valid.length;
    if (rejected) setNotice(`${rejected} file${rejected === 1 ? " was" : "s were"} skipped because it could not be read.`);
    setIsInspecting(false);
  }, [acceptedExtensions, items, mode]);

  useEffect(() => {
    if (!import.meta.env.TAURI_ENV_PLATFORM || new URLSearchParams(window.location.search).has("browser-preview")) return;
    let dispose: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over") setIsDragging(true);
      if (event.payload.type === "drop") {
        setIsDragging(false);
        void addPaths(event.payload.paths);
      }
      if (event.payload.type === "leave") setIsDragging(false);
    }).then((unlisten) => { dispose = unlisten; });
    return () => dispose?.();
  }, [addPaths]);

  function switchMode(next: Mode) {
    if (next === mode || isConverting) return;
    setMode(next);
    setItems([]);
    setNotice("");
  }

  function switchPdfDirection(next: PdfDirection) {
    if (next === pdfDirection || isConverting) return;
    setPdfDirection(next);
    setItems([]);
    setNotice("");
  }

  async function chooseFiles() {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: modeCopy[mode].title, extensions: acceptedExtensions }],
    });
    if (Array.isArray(selected)) await addPaths(selected);
    else if (typeof selected === "string") await addPaths([selected]);
  }

  async function chooseOutputFolder(): Promise<string | null> {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      setOutputDirectory(selected);
      return selected;
    }
    return null;
  }

  function updateItem(id: string, changes: Partial<QueueItem>) {
    setItems((current) => current.map((item) => item.id === id ? { ...item, ...changes } : item));
  }

  async function convertAll() {
    if (!items.length || isConverting) return;
    let destination = outputDirectory;
    if (!destination) destination = (await chooseOutputFolder()) ?? "";
    if (!destination) return;

    setIsConverting(true);
    setNotice("");
    setItems((current) => current.map((item) => ({ ...item, status: "ready", result: undefined, error: undefined })));

    try {
      if (mode === "pdf" && pdfDirection === "images-to-pdf") {
        await combineImagesIntoPdf(destination);
      } else {
        for (const item of items) await convertOne(item, destination);
      }
    } finally {
      setIsConverting(false);
    }
  }

  async function convertOne(item: QueueItem, destination: string) {
    const started = performance.now();
    updateItem(item.id, { status: "converting", error: undefined, result: undefined });
    try {
      let result: ConversionResult;
      if (mode === "images") {
        result = await invoke("convert_image", { path: item.path, options: imageConversionOptions(destination) });
      } else if (mode === "enhance") {
        result = await invoke("enhance_image", {
          path: item.path,
          options: { outputDirectory: destination, targetFormat: outputFormat, quality, upscale, strength: enhanceStrength },
        });
      } else if (mode === "audio" || mode === "video") {
        result = await invoke("convert_media", {
          path: item.path,
          options: {
            outputDirectory: destination,
            targetFormat: mode === "audio" ? audioFormat : videoFormat,
            kind: mode,
            audioBitrate,
            gifFps,
            gifWidth,
            videoQuality,
            videoHeight,
            keepAudio,
          },
        });
      } else {
        const pdfBase64 = await invoke<string>("read_file_base64", { path: item.path });
        const pages = await renderPdfToImages(pdfBase64, pdfImageFormat, quality, pdfScale, (page, total) => {
          setNotice(`Rendering ${item.name}: page ${page} of ${total}…`);
        });
        let firstPath = "";
        let outputBytes = 0;
        for (const page of pages) {
          const outputPath = await invoke<string>("write_base64_file", {
            outputDirectory: destination,
            preferredName: `${fileStem(item.name)}-page-${String(page.pageNumber).padStart(3, "0")}.${pdfImageFormat}`,
            dataBase64: page.dataBase64,
          });
          firstPath ||= outputPath;
          outputBytes += Math.floor(page.dataBase64.length * 0.75);
        }
        result = { outputPath: firstPath, bytesBefore: item.size, bytesAfter: outputBytes, durationMs: Math.round(performance.now() - started) };
      }
      updateItem(item.id, { status: "done", result });
      setNotice(mode === "pdf" ? `Finished ${item.name}.` : "Conversion finished successfully.");
    } catch (error) {
      updateItem(item.id, { status: "error", error: friendlyError(error) });
      setNotice("Finished with one or more errors. Check the affected files below.");
    }
  }

  async function combineImagesIntoPdf(destination: string) {
    const started = performance.now();
    setItems((current) => current.map((item) => ({ ...item, status: "converting" })));
    try {
      const images: string[] = [];
      for (let index = 0; index < items.length; index += 1) {
        setNotice(`Preparing image ${index + 1} of ${items.length}…`);
        images.push(await invoke<string>("image_as_png_base64", { path: items[index].path }));
      }
      const pdfBase64 = await createPdfFromPngImages(images);
      const outputPath = await invoke<string>("write_base64_file", {
        outputDirectory: destination,
        preferredName: `PicFlip-images-${new Date().toISOString().slice(0, 10)}.pdf`,
        dataBase64: pdfBase64,
      });
      const result: ConversionResult = {
        outputPath,
        bytesBefore: totalBefore,
        bytesAfter: Math.floor(pdfBase64.length * 0.75),
        durationMs: Math.round(performance.now() - started),
      };
      setItems((current) => current.map((item) => ({ ...item, status: "done", result })));
      setNotice(`Created one PDF with ${items.length} page${items.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setItems((current) => current.map((item) => ({ ...item, status: "error", error: friendlyError(error) })));
      setNotice("The PDF could not be created. Check that every image is readable.");
    }
  }

  function imageConversionOptions(destination: string) {
    return {
      outputDirectory: destination,
      targetFormat: outputFormat,
      quality,
      resizeMode,
      scalePercent,
      width: resizeMode === "dimensions" ? Math.max(1, width) : null,
      height: resizeMode === "dimensions" ? Math.max(1, height) : null,
      preserveAspectRatio,
    };
  }

  const actionLabel = useMemo(() => {
    if (isConverting) return `Working… ${completedCount + failedCount} / ${items.length}`;
    if (mode === "pdf" && pdfDirection === "images-to-pdf") return `Create PDF from ${items.length || ""} image${items.length === 1 ? "" : "s"}`;
    return `Convert ${items.length || ""} file${items.length === 1 ? "" : "s"}`;
  }, [completedCount, failedCount, isConverting, items.length, mode, pdfDirection]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><BrandMark /><div><strong>PicFlip</strong><span>Private media toolkit</span></div></div>
        <nav className="mode-tabs" aria-label="Tools">
          <ModeButton value="images" current={mode} onClick={switchMode} icon={<PictureIcon />} label="Images" />
          <ModeButton value="pdf" current={mode} onClick={switchMode} icon={<DocumentIcon />} label="PDF" />
          <ModeButton value="audio" current={mode} onClick={switchMode} icon={<AudioIcon />} label="Audio" />
          <ModeButton value="video" current={mode} onClick={switchMode} icon={<VideoIcon />} label="Video" />
          <ModeButton value="enhance" current={mode} onClick={switchMode} icon={<SparkleIcon />} label="Enhance" />
        </nav>
        <div className="privacy-pill"><LockIcon /><span>100% offline</span></div>
      </header>

      <main className="workspace">
        <section className="content-panel">
          <div className="page-heading">
            <div><span className="eyebrow">PICFLIP TOOL</span><h1>{modeCopy[mode].title}</h1><p>{modeCopy[mode].subtitle}</p></div>
            {mode === "pdf" && (
              <div className="direction-switch">
                <button className={pdfDirection === "pdf-to-images" ? "selected" : ""} onClick={() => switchPdfDirection("pdf-to-images")}>PDF → Images</button>
                <button className={pdfDirection === "images-to-pdf" ? "selected" : ""} onClick={() => switchPdfDirection("images-to-pdf")}>Images → PDF</button>
              </div>
            )}
          </div>

          <div className={`drop-zone ${isDragging ? "is-dragging" : ""}`} onClick={() => void chooseFiles()} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") void chooseFiles(); }}>
            <div className="drop-icon">{modeIcon(mode)}</div>
            <div><h2>{isInspecting ? "Reading your files…" : "Drop files here"}</h2><p>{acceptedExtensions.map((value) => value.toUpperCase()).join(" · ")}</p></div>
            <button className="secondary-button" type="button" onClick={(event) => { event.stopPropagation(); void chooseFiles(); }}><PlusIcon /> {modeCopy[mode].add}</button>
          </div>

          <div className="queue-heading">
            <div><h2>Conversion queue</h2><span>{items.length} {items.length === 1 ? "file" : "files"} · {formatBytes(totalBefore)}</span></div>
            {!!items.length && <button className="text-button" disabled={isConverting} onClick={() => setItems([])}>Clear all</button>}
          </div>

          {!items.length ? (
            <div className="empty-state"><div className="empty-art">{modeIcon(mode)}</div><h3>{modeCopy[mode].empty}</h3><p>Everything runs on this laptop. Nothing is uploaded or sent to a server.</p></div>
          ) : (
            <div className="queue-list">
              {items.map((item, index) => (
                <article className={`queue-item status-${item.status}`} key={item.id}>
                  <div className="thumbnail-wrap">
                    {item.thumbnailDataUrl ? <img src={item.thumbnailDataUrl} alt="" /> : <div className="file-tile">{fileIcon(item.extension)}</div>}
                    <span>{item.extension.toUpperCase()}</span>
                  </div>
                  <div className="file-details">
                    <strong title={item.name}>{mode === "pdf" && pdfDirection === "images-to-pdf" ? `${index + 1}. ` : ""}{item.name}</strong>
                    <small>{item.width && item.height ? `${item.width} × ${item.height} · ` : ""}{formatBytes(item.size)}</small>
                    {item.status === "done" && item.result && <em>Saved · {formatBytes(item.result.bytesAfter)} · {shortPath(item.result.outputPath)}</em>}
                    {item.status === "error" && <em className="error-detail">{item.error}</em>}
                  </div>
                  <StatusChip status={item.status} />
                  <button className="icon-button" aria-label={`Remove ${item.name}`} disabled={isConverting} onClick={() => setItems((current) => current.filter((candidate) => candidate.id !== item.id))}><CloseIcon /></button>
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="settings-panel">
          <div className="settings-title"><SlidersIcon /><div><h2>Settings</h2><p>Conversion and display</p></div></div>
          <DisplaySizeControl value={fontScale} onChange={setFontScale} />
          <Settings
            mode={mode} pdfDirection={pdfDirection} outputFormat={outputFormat} setOutputFormat={setOutputFormat}
            quality={quality} setQuality={setQuality} resizeMode={resizeMode} setResizeMode={setResizeMode}
            scalePercent={scalePercent} setScalePercent={setScalePercent} width={width} setWidth={setWidth}
            height={height} setHeight={setHeight} preserveAspectRatio={preserveAspectRatio} setPreserveAspectRatio={setPreserveAspectRatio}
            upscale={upscale} setUpscale={setUpscale} enhanceStrength={enhanceStrength} setEnhanceStrength={setEnhanceStrength}
            audioFormat={audioFormat} setAudioFormat={setAudioFormat} audioBitrate={audioBitrate} setAudioBitrate={setAudioBitrate}
            videoFormat={videoFormat} setVideoFormat={setVideoFormat} videoQuality={videoQuality} setVideoQuality={setVideoQuality}
            videoHeight={videoHeight} setVideoHeight={setVideoHeight} keepAudio={keepAudio} setKeepAudio={setKeepAudio}
            gifFps={gifFps} setGifFps={setGifFps} gifWidth={gifWidth} setGifWidth={setGifWidth}
            pdfImageFormat={pdfImageFormat} setPdfImageFormat={setPdfImageFormat} pdfScale={pdfScale} setPdfScale={setPdfScale}
          />
          <div className="setting-group output-group"><label>Save to</label><button className="folder-picker" onClick={() => void chooseOutputFolder()}><FolderIcon /><span>{outputDirectory ? shortPath(outputDirectory) : "Choose output folder"}</span><ChevronIcon /></button></div>
          <div className="local-note"><LockIcon /><p><strong>Private by design.</strong><br />Your files never leave this computer.</p></div>
        </aside>
      </main>

      <footer className="action-bar">
        <div className="action-summary">
          {(isConverting || completedCount + failedCount > 0) && <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>}
          <p>{notice || (items.length ? `${formatBytes(totalBefore)} ready${totalAfter ? ` · ${formatBytes(totalAfter)} exported` : ""}` : "Add files to begin")}</p>
        </div>
        <button className="primary-button" disabled={!items.length || isConverting} onClick={() => void convertAll()}>{isConverting ? <Spinner /> : <ConvertIcon />}{actionLabel}</button>
      </footer>
    </div>
  );
}

function DisplaySizeControl({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const progress = ((value - fontScaleMin) / (fontScaleMax - fontScaleMin)) * 100;
  return (
    <section className="display-setting" aria-labelledby="text-size-label">
      <div className="display-setting-heading">
        <div><strong id="text-size-label">Text size</strong><span>Adjust the whole interface</span></div>
        <output aria-live="polite">{value}%</output>
      </div>
      <div className="font-size-control">
        <span className="font-size-small" aria-hidden="true">A</span>
        <input
          aria-label="Interface text size"
          type="range"
          min={fontScaleMin}
          max={fontScaleMax}
          step={5}
          value={value}
          style={{ "--range-progress": `${progress}%` } as React.CSSProperties}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span className="font-size-large" aria-hidden="true">A</span>
      </div>
    </section>
  );
}

interface SettingsProps {
  mode: Mode; pdfDirection: PdfDirection; outputFormat: ImageFormat; setOutputFormat: (value: ImageFormat) => void;
  quality: number; setQuality: (value: number) => void; resizeMode: ResizeMode; setResizeMode: (value: ResizeMode) => void;
  scalePercent: number; setScalePercent: (value: number) => void; width: number; setWidth: (value: number) => void; height: number; setHeight: (value: number) => void;
  preserveAspectRatio: boolean; setPreserveAspectRatio: (value: boolean) => void; upscale: 1 | 2 | 4; setUpscale: (value: 1 | 2 | 4) => void;
  enhanceStrength: string; setEnhanceStrength: (value: string) => void; audioFormat: "mp3" | "wav" | "aac"; setAudioFormat: (value: "mp3" | "wav" | "aac") => void;
  audioBitrate: number; setAudioBitrate: (value: number) => void; videoFormat: VideoFormat; setVideoFormat: (value: VideoFormat) => void;
  videoQuality: VideoQuality; setVideoQuality: (value: VideoQuality) => void; videoHeight: number; setVideoHeight: (value: number) => void;
  keepAudio: boolean; setKeepAudio: (value: boolean) => void;
  gifFps: number; setGifFps: (value: number) => void; gifWidth: number; setGifWidth: (value: number) => void;
  pdfImageFormat: "png" | "jpg" | "webp"; setPdfImageFormat: (value: "png" | "jpg" | "webp") => void; pdfScale: number; setPdfScale: (value: number) => void;
}

function Settings(props: SettingsProps) {
  const { mode } = props;
  if (mode === "pdf" && props.pdfDirection === "images-to-pdf") return <div className="setting-card"><DocumentIcon /><h3>One image per page</h3><p>Images stay in queue order. Each is fitted onto its own PDF page without cropping.</p></div>;
  if (mode === "audio") return <>
    <ChoiceGroup label="Output format" values={["mp3", "wav", "aac"]} selected={props.audioFormat} onChange={(v) => props.setAudioFormat(v as "mp3" | "wav" | "aac")} />
    {props.audioFormat !== "wav" && <RangeSetting label="Audio bitrate" value={props.audioBitrate} min={64} max={320} step={32} suffix=" kbps" onChange={props.setAudioBitrate} />}
  </>;
  if (mode === "video") return <>
    <ChoiceGroup label="Output format" values={["mp4", "mov", "mkv", "avi", "gif"]} selected={props.videoFormat} onChange={(v) => props.setVideoFormat(v as VideoFormat)} />
    {props.videoFormat === "gif" ? <>
      <RangeSetting label="Frame rate" value={props.gifFps} min={5} max={24} step={1} suffix=" fps" onChange={props.setGifFps} />
      <ChoiceGroup label="GIF width" values={["480", "720", "1080"]} selected={String(props.gifWidth)} onChange={(v) => props.setGifWidth(Number(v))} />
      <div className="tip-card"><SparkleIcon /><p>Smart palette rendering improves GIF colours and dithering. GIF does not support audio.</p></div>
    </> : <>
      <ChoiceGroup label="Video quality" values={["high", "balanced", "compact"]} labels={["High", "Balanced", "Smaller"]} selected={props.videoQuality} onChange={(v) => props.setVideoQuality(v as VideoQuality)} />
      <ChoiceGroup label="Maximum resolution" values={["0", "720", "1080", "2160"]} labels={["Original", "720p", "1080p", "4K"]} selected={String(props.videoHeight)} onChange={(v) => props.setVideoHeight(Number(v))} />
      <div className="setting-group"><label className="checkbox-row video-audio-toggle"><input type="checkbox" checked={props.keepAudio} onChange={(e) => props.setKeepAudio(e.target.checked)} /> Keep audio track</label></div>
      <div className="tip-card"><VideoIcon /><p>{props.videoFormat === "avi" ? "AVI uses MPEG-4 video and MP3 audio for legacy compatibility." : "MP4, MOV and MKV use efficient H.264 video with AAC audio."}</p></div>
    </>}
  </>;
  if (mode === "pdf") return <>
    <ChoiceGroup label="Page format" values={["png", "jpg", "webp"]} selected={props.pdfImageFormat} onChange={(v) => props.setPdfImageFormat(v as "png" | "jpg" | "webp")} />
    <ChoiceGroup label="Render quality" values={["1", "2", "3"]} labels={["Standard", "Sharp", "Print"]} selected={String(props.pdfScale)} onChange={(v) => props.setPdfScale(Number(v))} />
    {props.pdfImageFormat !== "png" && <RangeSetting label="Image quality" value={props.quality} min={40} max={100} step={1} suffix="%" onChange={props.setQuality} />}
  </>;
  return <>
    <ChoiceGroup label="Output format" values={imageFormats} selected={props.outputFormat} onChange={(v) => props.setOutputFormat(v as ImageFormat)} />
    {(props.outputFormat === "jpg" || props.outputFormat === "webp") && <RangeSetting label="Image quality" value={props.quality} min={40} max={100} step={1} suffix="%" onChange={props.setQuality} />}
    {mode === "enhance" ? <>
      <ChoiceGroup label="Upscale" values={["1", "2", "4"]} labels={["1× Clean", "2×", "4×"]} selected={String(props.upscale)} onChange={(v) => props.setUpscale(Number(v) as 1 | 2 | 4)} />
      <ChoiceGroup label="Cleanup strength" values={["gentle", "standard", "strong"]} selected={props.enhanceStrength} onChange={props.setEnhanceStrength} />
      <div className="tip-card"><SparkleIcon /><p>Clean Upscale uses high-quality resampling and edge cleanup. It improves visible blockiness, but cannot recreate detail missing from the original.</p></div>
    </> : <>
      <ChoiceGroup label="Resize" values={["original", "percentage", "dimensions"]} labels={["Original", "Percent", "Custom"]} selected={props.resizeMode} onChange={(v) => props.setResizeMode(v as ResizeMode)} />
      {props.resizeMode === "percentage" && <RangeSetting label="Scale" value={props.scalePercent} min={10} max={200} step={5} suffix="%" onChange={props.setScalePercent} />}
      {props.resizeMode === "dimensions" && <div className="setting-group"><label>Target size</label><div className="dimension-inputs"><input type="number" min="1" value={props.width} onChange={(e) => props.setWidth(Number(e.target.value))} /><span>×</span><input type="number" min="1" value={props.height} onChange={(e) => props.setHeight(Number(e.target.value))} /></div><label className="checkbox-row"><input type="checkbox" checked={props.preserveAspectRatio} onChange={(e) => props.setPreserveAspectRatio(e.target.checked)} /> Preserve aspect ratio</label></div>}
    </>}
  </>;
}

function ChoiceGroup({ label, values, labels, selected, onChange }: { label: string; values: readonly string[]; labels?: string[]; selected: string; onChange: (value: string) => void }) {
  return <div className="setting-group"><label>{label}</label><div className={`choice-grid count-${Math.min(values.length, 3)}`}>{values.map((value, index) => <button key={value} className={selected === value ? "selected" : ""} onClick={() => onChange(value)}>{labels?.[index] ?? value.toUpperCase()}</button>)}</div></div>;
}

function RangeSetting({ label, value, min, max, step, suffix, onChange }: { label: string; value: number; min: number; max: number; step: number; suffix: string; onChange: (value: number) => void }) {
  const progress = ((value - min) / (max - min)) * 100;
  return <div className="setting-group"><div className="label-row"><label>{label}</label><output>{value}{suffix}</output></div><input type="range" min={min} max={max} step={step} value={value} style={{ "--range-progress": `${progress}%` } as React.CSSProperties} onChange={(e) => onChange(Number(e.target.value))} /></div>;
}

function ModeButton({ value, current, onClick, icon, label }: { value: Mode; current: Mode; onClick: (value: Mode) => void; icon: React.ReactNode; label: string }) {
  return <button className={current === value ? "selected" : ""} onClick={() => onClick(value)}>{icon}<span>{label}</span></button>;
}

function StatusChip({ status }: { status: QueueStatus }) {
  return <div className={`status-chip ${status}`}>{status === "converting" && <Spinner />}{status === "done" && <CheckIcon />}{status === "ready" ? "Ready" : status === "converting" ? "Working" : status === "done" ? "Done" : "Failed"}</div>;
}

function formatBytes(bytes: number) { if (!bytes) return "0 B"; const units = ["B", "KB", "MB", "GB"]; const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3); return `${(bytes / 1024 ** i).toFixed(i === 0 || bytes / 1024 ** i >= 10 ? 0 : 1)} ${units[i]}`; }
function shortPath(path: string) { const parts = path.split(/[\\/]/).filter(Boolean); return parts.length <= 3 ? path : `…/${parts.slice(-3).join("/")}`; }
function fileStem(name: string) { return name.replace(/\.[^.]+$/, "") || "document"; }
function friendlyError(error: unknown) { const value = String(error); return value.length > 360 ? `${value.slice(0, 357)}…` : value; }
function modeIcon(mode: Mode) { return mode === "images" ? <PictureIcon /> : mode === "pdf" ? <DocumentIcon /> : mode === "audio" ? <AudioIcon /> : mode === "video" ? <VideoIcon /> : <SparkleIcon />; }
function fileIcon(extension: string) { return ["mp3", "wav", "aac", "m4a"].includes(extension) ? <AudioIcon /> : ["mp4", "mov", "m4v", "mkv", "avi", "webm", "gif"].includes(extension) ? <VideoIcon /> : <DocumentIcon />; }

const Svg = ({ children, viewBox = "0 0 24 24" }: { children: React.ReactNode; viewBox?: string }) => <svg viewBox={viewBox} aria-hidden="true">{children}</svg>;
const PictureIcon = () => <Svg><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m5 18 5-5 3 3 2-2 4 4"/></Svg>;
const DocumentIcon = () => <Svg><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 12h6M9 16h6"/></Svg>;
const AudioIcon = () => <Svg><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></Svg>;
const VideoIcon = () => <Svg><rect x="3" y="5" width="14" height="14" rx="3"/><path d="m17 10 4-2v8l-4-2zM7 5l2-3M13 5l2-3"/></Svg>;
const SparkleIcon = () => <Svg><path d="m12 2 1.4 5.1L18 9l-4.6 1.9L12 16l-1.4-5.1L6 9l4.6-1.9zM19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z"/></Svg>;
const LockIcon = () => <Svg><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></Svg>;
const PlusIcon = () => <Svg><path d="M12 5v14M5 12h14"/></Svg>;
const CloseIcon = () => <Svg><path d="m7 7 10 10M17 7 7 17"/></Svg>;
const SlidersIcon = () => <Svg><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></Svg>;
const FolderIcon = () => <Svg><path d="M3 6h7l2 2h9v11H3z"/></Svg>;
const ChevronIcon = () => <Svg><path d="m9 6 6 6-6 6"/></Svg>;
const ConvertIcon = () => <Svg><path d="M4 7h13l-3-3M20 17H7l3 3"/></Svg>;
const CheckIcon = () => <Svg><path d="m5 12 4 4L19 6"/></Svg>;
const Spinner = () => <span className="spinner" />;
const BrandMark = () => <div className="brand-mark" aria-hidden="true"><span/><span/><i/></div>;

export default App;
