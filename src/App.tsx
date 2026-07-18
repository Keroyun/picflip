import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { createPdfFromPngImages, renderPdfToImages } from "./pdfTools";
import { translate, type Language } from "./i18n";
import picflipIcon from "./assets/picflip-icon.png";

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
const fontScaleStorageKey = "picflip-interface-font-scale";
const languageStorageKey = "picflip-interface-language";
const fontScaleMin = 90;
const fontScaleMax = 130;
const appVersion = "0.3.5";
const profileUrls = {
  website: "https://khairulazhar.com",
  github: "https://github.com/Keroyun",
} as const;

function savedFontScale() {
  try {
    const value = Number(window.localStorage.getItem(fontScaleStorageKey));
    if (Number.isFinite(value) && value >= fontScaleMin && value <= fontScaleMax) return value;
  } catch {
    // Local storage can be unavailable in locked-down environments. The default still works.
  }
  return 100;
}

function savedLanguage(): Language {
  try {
    return window.localStorage.getItem(languageStorageKey) === "ms" ? "ms" : "en";
  } catch {
    return "en";
  }
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
  const [language, setLanguage] = useState<Language>(savedLanguage);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const updateDialogButtonRef = useRef<HTMLButtonElement>(null);

  const modeCopy = useMemo<Record<Mode, { title: string; subtitle: string; add: string; empty: string }>>(() => ({
    images: { title: translate(language, "imageTitle"), subtitle: translate(language, "imageSubtitle"), add: translate(language, "imageAdd"), empty: translate(language, "imageEmpty") },
    pdf: { title: translate(language, "pdfTitle"), subtitle: translate(language, "pdfSubtitle"), add: translate(language, "pdfAdd"), empty: translate(language, "pdfEmpty") },
    audio: { title: translate(language, "audioTitle"), subtitle: translate(language, "audioSubtitle"), add: translate(language, "audioAdd"), empty: translate(language, "audioEmpty") },
    video: { title: translate(language, "videoTitle"), subtitle: translate(language, "videoSubtitle"), add: translate(language, "videoAdd"), empty: translate(language, "videoEmpty") },
    enhance: { title: translate(language, "enhanceTitle"), subtitle: translate(language, "enhanceSubtitle"), add: translate(language, "enhanceAdd"), empty: translate(language, "enhanceEmpty") },
  }), [language]);

  useEffect(() => {
    document.documentElement.style.fontSize = `${fontScale}%`;
    try {
      window.localStorage.setItem(fontScaleStorageKey, String(fontScale));
    } catch {
      // Keep the control usable for this session even if preferences cannot be stored.
    }
  }, [fontScale]);

  useEffect(() => {
    document.documentElement.lang = language === "ms" ? "ms" : "en";
    try {
      window.localStorage.setItem(languageStorageKey, language);
    } catch {
      // The selected language still works for this session when storage is unavailable.
    }
  }, [language]);

  useEffect(() => {
    if (!settingsOpen) return;
    function closeSettings(event: MouseEvent) {
      if (!settingsMenuRef.current?.contains(event.target as Node)) setSettingsOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setSettingsOpen(false);
    }
    document.addEventListener("mousedown", closeSettings);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeSettings);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [settingsOpen]);

  useEffect(() => {
    if (!updateDialogOpen) return;
    updateDialogButtonRef.current?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setUpdateDialogOpen(false);
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [updateDialogOpen]);

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
      if (paths.length) {
        const kind = translate(language, mode === "audio" ? "audioFiles" : mode === "video" ? "videoFiles" : "supportedFiles");
        setNotice(translate(language, "noSupportedFiles", { kind }));
      }
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
    if (rejected) setNotice(rejected === 1
      ? translate(language, "skippedOne")
      : translate(language, "skippedMany", { count: rejected }));
    setIsInspecting(false);
  }, [acceptedExtensions, items, language, mode]);

  useEffect(() => {
    if (!isTauri() || new URLSearchParams(window.location.search).has("browser-preview")) return;
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
    const selected = await open({ directory: true, multiple: false, recursive: true });
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
          setNotice(translate(language, "renderingPage", { name: item.name, page, total }));
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
      setNotice(mode === "pdf"
        ? translate(language, "finishedFile", { name: item.name })
        : translate(language, "conversionSuccess"));
    } catch (error) {
      updateItem(item.id, { status: "error", error: friendlyError(error, language) });
      setNotice(translate(language, "conversionErrors"));
    }
  }

  async function combineImagesIntoPdf(destination: string) {
    const started = performance.now();
    setItems((current) => current.map((item) => ({ ...item, status: "converting" })));
    try {
      const images: string[] = [];
      for (let index = 0; index < items.length; index += 1) {
        setNotice(translate(language, "preparingImage", { current: index + 1, total: items.length }));
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
      setNotice(items.length === 1
        ? translate(language, "pdfCreatedOne")
        : translate(language, "pdfCreatedMany", { count: items.length }));
    } catch (error) {
      setItems((current) => current.map((item) => ({ ...item, status: "error", error: friendlyError(error, language) })));
      setNotice(translate(language, "pdfCreateError"));
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
    if (isConverting) return translate(language, "workingCount", { done: completedCount + failedCount, total: items.length });
    if (mode === "pdf" && pdfDirection === "images-to-pdf") {
      return translate(language, "createPdfAction", { count: items.length || "", suffix: items.length === 1 ? "" : "s" });
    }
    return translate(language, "convertAction", { count: items.length || "", suffix: items.length === 1 ? "" : "s" });
  }, [completedCount, failedCount, isConverting, items.length, language, mode, pdfDirection]);

  async function openProfileUrl(url: string) {
    if (!Object.values(profileUrls).includes(url as (typeof profileUrls)[keyof typeof profileUrls])) return;
    setSettingsOpen(false);
    try {
      if (isTauri()) await invoke("open_profile_url", { url });
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setNotice(translate(language, "openLinkError"));
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><BrandMark /><div><strong>PicFlip</strong><span>{translate(language, "brandTagline")}</span></div></div>
        <nav className="mode-tabs" aria-label={translate(language, "toolsAria")}>
          <ModeButton value="images" current={mode} onClick={switchMode} icon={<PictureIcon />} label={translate(language, "images")} />
          <ModeButton value="pdf" current={mode} onClick={switchMode} icon={<DocumentIcon />} label={translate(language, "pdf")} />
          <ModeButton value="audio" current={mode} onClick={switchMode} icon={<AudioIcon />} label={translate(language, "audio")} />
          <ModeButton value="video" current={mode} onClick={switchMode} icon={<VideoIcon />} label={translate(language, "video")} />
          <ModeButton value="enhance" current={mode} onClick={switchMode} icon={<SparkleIcon />} label={translate(language, "enhance")} />
        </nav>
        <div className="topbar-actions">
          <div className="privacy-pill"><LockIcon /><span>{translate(language, "offline")}</span></div>
          <div className="settings-menu-wrap" ref={settingsMenuRef}>
            <button
              className={`settings-button ${settingsOpen ? "is-open" : ""}`}
              type="button"
              aria-label={translate(language, "settingsAria")}
              aria-expanded={settingsOpen}
              aria-controls="application-settings-menu"
              onClick={() => setSettingsOpen((current) => !current)}
            >
              <SettingsIcon /><span>{translate(language, "settings")}</span><DownIcon />
            </button>
            {settingsOpen && (
              <ApplicationSettings
                language={language}
                setLanguage={setLanguage}
                fontScale={fontScale}
                setFontScale={setFontScale}
                onOpenWebsite={() => void openProfileUrl(profileUrls.website)}
                onOpenGitHub={() => void openProfileUrl(profileUrls.github)}
                onCheckForUpdates={() => {
                  setSettingsOpen(false);
                  setUpdateDialogOpen(true);
                }}
              />
            )}
          </div>
        </div>
      </header>

      {updateDialogOpen && (
        <div
          className="update-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setUpdateDialogOpen(false);
          }}
        >
          <section className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title" aria-describedby="update-dialog-message">
            <div className="update-dialog-icon"><UpdateIcon /></div>
            <span className="update-dialog-kicker">{translate(language, "updateDialogTitle")}</span>
            <h2 id="update-dialog-title">{translate(language, "updateComingSoon")}</h2>
            <p id="update-dialog-message">{translate(language, "updateComingSoonHelp")}</p>
            <button ref={updateDialogButtonRef} type="button" onClick={() => setUpdateDialogOpen(false)}>{translate(language, "gotIt")}</button>
          </section>
        </div>
      )}

      <main className="workspace">
        <section className="content-panel">
          <div className="page-heading">
            <div><span className="eyebrow">{translate(language, "toolEyebrow")}</span><h1>{modeCopy[mode].title}</h1><p>{modeCopy[mode].subtitle}</p></div>
            {mode === "pdf" && (
              <div className="direction-switch">
                <button className={pdfDirection === "pdf-to-images" ? "selected" : ""} onClick={() => switchPdfDirection("pdf-to-images")}>{translate(language, "pdfToImages")}</button>
                <button className={pdfDirection === "images-to-pdf" ? "selected" : ""} onClick={() => switchPdfDirection("images-to-pdf")}>{translate(language, "imagesToPdf")}</button>
              </div>
            )}
          </div>

          <div className={`drop-zone ${isDragging ? "is-dragging" : ""}`} onClick={() => void chooseFiles()} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") void chooseFiles(); }}>
            <div className="drop-icon">{modeIcon(mode)}</div>
            <div><h2>{isInspecting ? translate(language, "readingFiles") : translate(language, "dropFiles")}</h2><p>{acceptedExtensions.map((value) => value.toUpperCase()).join(" · ")}</p></div>
            <button className="secondary-button" type="button" onClick={(event) => { event.stopPropagation(); void chooseFiles(); }}><PlusIcon /> {modeCopy[mode].add}</button>
          </div>

          <div className="queue-heading">
            <div><h2>{translate(language, "conversionQueue")}</h2><span>{items.length} {translate(language, items.length === 1 ? "file" : "files")} · {formatBytes(totalBefore)}</span></div>
            {!!items.length && <button className="text-button" disabled={isConverting} onClick={() => setItems([])}>{translate(language, "clearAll")}</button>}
          </div>

          {!items.length ? (
            <div className="empty-state"><div className="empty-art">{modeIcon(mode)}</div><h3>{modeCopy[mode].empty}</h3><p>{translate(language, "privateMessage")}</p></div>
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
                    {item.status === "done" && item.result && <em>{translate(language, "saved")} · {formatBytes(item.result.bytesAfter)} · {shortPath(item.result.outputPath)}</em>}
                    {item.status === "error" && <em className="error-detail">{item.error}</em>}
                  </div>
                  <StatusChip status={item.status} language={language} />
                  <button className="icon-button" aria-label={translate(language, "remove", { name: item.name })} disabled={isConverting} onClick={() => setItems((current) => current.filter((candidate) => candidate.id !== item.id))}><CloseIcon /></button>
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="settings-panel">
          <div className="settings-title"><SlidersIcon /><div><h2>{translate(language, "outputOptions")}</h2><p>{translate(language, "outputOptionsHelp")}</p></div></div>
          <Settings
            language={language}
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
          <div className="setting-group output-group"><label>{translate(language, "saveTo")}</label><button className="folder-picker" onClick={() => void chooseOutputFolder()}><FolderIcon /><span>{outputDirectory ? shortPath(outputDirectory) : translate(language, "chooseOutputFolder")}</span><ChevronIcon /></button></div>
          <div className="local-note"><LockIcon /><p><strong>{translate(language, "privateByDesign")}</strong><br />{translate(language, "filesNeverLeave")}</p></div>
        </aside>
      </main>

      <footer className="action-bar">
        <div className="action-summary">
          {(isConverting || completedCount + failedCount > 0) && <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>}
          <p>{notice || (items.length
            ? `${translate(language, "readyToConvert", { size: formatBytes(totalBefore) })}${totalAfter ? ` · ${translate(language, "exported", { size: formatBytes(totalAfter) })}` : ""}`
            : translate(language, "addFilesToBegin"))}</p>
        </div>
        <button className="primary-button" disabled={!items.length || isConverting} onClick={() => void convertAll()}>{isConverting ? <Spinner /> : <ConvertIcon />}{actionLabel}</button>
      </footer>
    </div>
  );
}

function ApplicationSettings({
  language,
  setLanguage,
  fontScale,
  setFontScale,
  onOpenWebsite,
  onOpenGitHub,
  onCheckForUpdates,
}: {
  language: Language;
  setLanguage: (language: Language) => void;
  fontScale: number;
  setFontScale: (value: number) => void;
  onOpenWebsite: () => void;
  onOpenGitHub: () => void;
  onCheckForUpdates: () => void;
}) {
  return (
    <section id="application-settings-menu" className="application-settings-menu" role="dialog" aria-label={translate(language, "settings")}>
      <div className="application-settings-heading">
        <div className="settings-heading-icon"><SettingsIcon /></div>
        <div><h2>{translate(language, "settings")}</h2><p>{translate(language, "settingsSubtitle")}</p></div>
      </div>

      <div className="creator-card">
        <img src={picflipIcon} alt="" />
        <div><strong>Khairul Azhar</strong><span>{translate(language, "creator")}</span></div>
      </div>
      <div className="profile-links">
        <button type="button" onClick={onOpenWebsite}><GlobeIcon /><span>{translate(language, "website")}</span><ExternalLinkIcon /></button>
        <button type="button" onClick={onOpenGitHub}><GitHubIcon /><span>{translate(language, "github")}</span><ExternalLinkIcon /></button>
      </div>

      <DisplaySizeControl language={language} value={fontScale} onChange={setFontScale} />

      <section className="language-setting" aria-labelledby="language-setting-label">
        <div className="language-setting-heading"><strong id="language-setting-label">{translate(language, "language")}</strong><span>{translate(language, "languageHelp")}</span></div>
        <div className="language-options">
          <button type="button" className={language === "en" ? "selected" : ""} onClick={() => setLanguage("en")}><span>EN</span>{translate(language, "english")}</button>
          <button type="button" className={language === "ms" ? "selected" : ""} onClick={() => setLanguage("ms")}><span>BM</span>{translate(language, "malay")}</button>
        </div>
      </section>

      <button className="check-updates-button" type="button" onClick={onCheckForUpdates}>
        <span className="check-updates-icon"><UpdateIcon /></span>
        <span><strong>{translate(language, "checkForUpdates")}</strong><small>{translate(language, "checkForUpdatesHelp")}</small></span>
        <ChevronIcon />
      </button>

      <div className="settings-menu-footer"><span><LockIcon />{translate(language, "offline")}</span><small>{translate(language, "version", { version: appVersion })}</small></div>
    </section>
  );
}

function DisplaySizeControl({ language, value, onChange }: { language: Language; value: number; onChange: (value: number) => void }) {
  const progress = ((value - fontScaleMin) / (fontScaleMax - fontScaleMin)) * 100;
  return (
    <section className="display-setting" aria-labelledby="text-size-label">
      <div className="display-setting-heading">
        <div><strong id="text-size-label">{translate(language, "textSize")}</strong><span>{translate(language, "textSizeHelp")}</span></div>
        <output aria-live="polite">{value}%</output>
      </div>
      <div className="font-size-control">
        <span className="font-size-small" aria-hidden="true">A</span>
        <input
          aria-label={translate(language, "textSizeAria")}
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
  language: Language;
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
  const { language, mode } = props;
  if (mode === "pdf" && props.pdfDirection === "images-to-pdf") return <div className="setting-card"><DocumentIcon /><h3>{translate(language, "oneImagePerPage")}</h3><p>{translate(language, "oneImagePerPageHelp")}</p></div>;
  if (mode === "audio") return <>
    <ChoiceGroup label={translate(language, "outputFormat")} values={["mp3", "wav", "aac"]} selected={props.audioFormat} onChange={(v) => props.setAudioFormat(v as "mp3" | "wav" | "aac")} />
    {props.audioFormat !== "wav" && <RangeSetting label={translate(language, "audioBitrate")} value={props.audioBitrate} min={64} max={320} step={32} suffix=" kbps" onChange={props.setAudioBitrate} />}
  </>;
  if (mode === "video") return <>
    <ChoiceGroup label={translate(language, "outputFormat")} values={["mp4", "mov", "mkv", "avi", "gif"]} selected={props.videoFormat} onChange={(v) => props.setVideoFormat(v as VideoFormat)} />
    {props.videoFormat === "gif" ? <>
      <RangeSetting label={translate(language, "frameRate")} value={props.gifFps} min={5} max={24} step={1} suffix=" fps" onChange={props.setGifFps} />
      <ChoiceGroup label={translate(language, "gifWidth")} values={["480", "720", "1080"]} selected={String(props.gifWidth)} onChange={(v) => props.setGifWidth(Number(v))} />
      <div className="tip-card"><SparkleIcon /><p>{translate(language, "gifTip")}</p></div>
    </> : <>
      <ChoiceGroup label={translate(language, "videoQuality")} values={["high", "balanced", "compact"]} labels={[translate(language, "high"), translate(language, "balanced"), translate(language, "smaller")]} selected={props.videoQuality} onChange={(v) => props.setVideoQuality(v as VideoQuality)} />
      <ChoiceGroup label={translate(language, "maximumResolution")} values={["0", "720", "1080", "2160"]} labels={[translate(language, "original"), "720p", "1080p", "4K"]} selected={String(props.videoHeight)} onChange={(v) => props.setVideoHeight(Number(v))} />
      <div className="setting-group"><label className="checkbox-row video-audio-toggle"><input type="checkbox" checked={props.keepAudio} onChange={(e) => props.setKeepAudio(e.target.checked)} /> {translate(language, "keepAudio")}</label></div>
      <div className="tip-card"><VideoIcon /><p>{translate(language, props.videoFormat === "avi" ? "aviTip" : "videoTip")}</p></div>
    </>}
  </>;
  if (mode === "pdf") return <>
    <ChoiceGroup label={translate(language, "pageFormat")} values={["png", "jpg", "webp"]} selected={props.pdfImageFormat} onChange={(v) => props.setPdfImageFormat(v as "png" | "jpg" | "webp")} />
    <ChoiceGroup label={translate(language, "renderQuality")} values={["1", "2", "3"]} labels={[translate(language, "standard"), translate(language, "sharp"), translate(language, "print")]} selected={String(props.pdfScale)} onChange={(v) => props.setPdfScale(Number(v))} />
    {props.pdfImageFormat !== "png" && <RangeSetting label={translate(language, "imageQuality")} value={props.quality} min={40} max={100} step={1} suffix="%" onChange={props.setQuality} />}
  </>;
  return <>
    <ChoiceGroup label={translate(language, "outputFormat")} values={imageFormats} selected={props.outputFormat} onChange={(v) => props.setOutputFormat(v as ImageFormat)} />
    {(props.outputFormat === "jpg" || props.outputFormat === "webp") && <RangeSetting label={translate(language, "imageQuality")} value={props.quality} min={40} max={100} step={1} suffix="%" onChange={props.setQuality} />}
    {mode === "enhance" ? <>
      <ChoiceGroup label={translate(language, "upscale")} values={["1", "2", "4"]} labels={[translate(language, "clean"), "2×", "4×"]} selected={String(props.upscale)} onChange={(v) => props.setUpscale(Number(v) as 1 | 2 | 4)} />
      <ChoiceGroup label={translate(language, "cleanupStrength")} values={["gentle", "standard", "strong"]} labels={[translate(language, "gentle"), translate(language, "standard"), translate(language, "strong")]} selected={props.enhanceStrength} onChange={props.setEnhanceStrength} />
      <div className="tip-card"><SparkleIcon /><p>{translate(language, "enhanceTip")}</p></div>
    </> : <>
      <ChoiceGroup label={translate(language, "resize")} values={["original", "percentage", "dimensions"]} labels={[translate(language, "original"), translate(language, "percent"), translate(language, "custom")]} selected={props.resizeMode} onChange={(v) => props.setResizeMode(v as ResizeMode)} />
      {props.resizeMode === "percentage" && <RangeSetting label={translate(language, "scale")} value={props.scalePercent} min={10} max={200} step={5} suffix="%" onChange={props.setScalePercent} />}
      {props.resizeMode === "dimensions" && <div className="setting-group"><label>{translate(language, "targetSize")}</label><div className="dimension-inputs"><input type="number" min="1" value={props.width} onChange={(e) => props.setWidth(Number(e.target.value))} /><span>×</span><input type="number" min="1" value={props.height} onChange={(e) => props.setHeight(Number(e.target.value))} /></div><label className="checkbox-row"><input type="checkbox" checked={props.preserveAspectRatio} onChange={(e) => props.setPreserveAspectRatio(e.target.checked)} /> {translate(language, "preserveAspectRatio")}</label></div>}
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

function StatusChip({ status, language }: { status: QueueStatus; language: Language }) {
  return <div className={`status-chip ${status}`}>{status === "converting" && <Spinner />}{status === "done" && <CheckIcon />}{translate(language, status === "ready" ? "ready" : status === "converting" ? "working" : status === "done" ? "done" : "failed")}</div>;
}

function formatBytes(bytes: number) { if (!bytes) return "0 B"; const units = ["B", "KB", "MB", "GB"]; const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3); return `${(bytes / 1024 ** i).toFixed(i === 0 || bytes / 1024 ** i >= 10 ? 0 : 1)} ${units[i]}`; }
function shortPath(path: string) { const parts = path.split(/[\\/]/).filter(Boolean); return parts.length <= 3 ? path : `…/${parts.slice(-3).join("/")}`; }
function fileStem(name: string) { return name.replace(/\.[^.]+$/, "") || "document"; }
function friendlyError(error: unknown, language: Language) {
  if (language === "ms") return translate(language, "fileProcessError");
  const value = String(error);
  return value.length > 360 ? `${value.slice(0, 357)}…` : value;
}
function modeIcon(mode: Mode) { return mode === "images" ? <PictureIcon /> : mode === "pdf" ? <DocumentIcon /> : mode === "audio" ? <AudioIcon /> : mode === "video" ? <VideoIcon /> : <SparkleIcon />; }
function fileIcon(extension: string) { return ["mp3", "wav", "aac", "m4a"].includes(extension) ? <AudioIcon /> : ["mp4", "mov", "m4v", "mkv", "avi", "webm", "gif"].includes(extension) ? <VideoIcon /> : <DocumentIcon />; }

const Svg = ({ children, viewBox = "0 0 24 24" }: { children: React.ReactNode; viewBox?: string }) => <svg viewBox={viewBox} aria-hidden="true">{children}</svg>;
const PictureIcon = () => <Svg><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m5 18 5-5 3 3 2-2 4 4"/></Svg>;
const DocumentIcon = () => <Svg><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 12h6M9 16h6"/></Svg>;
const AudioIcon = () => <Svg><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></Svg>;
const VideoIcon = () => <Svg><rect x="3" y="5" width="14" height="14" rx="3"/><path d="m17 10 4-2v8l-4-2zM7 5l2-3M13 5l2-3"/></Svg>;
const SparkleIcon = () => <Svg><path d="m12 2 1.4 5.1L18 9l-4.6 1.9L12 16l-1.4-5.1L6 9l4.6-1.9zM19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z"/></Svg>;
const LockIcon = () => <Svg><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></Svg>;
const SettingsIcon = () => <Svg><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/></Svg>;
const DownIcon = () => <Svg><path d="m7 9 5 5 5-5"/></Svg>;
const GlobeIcon = () => <Svg><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></Svg>;
const GitHubIcon = () => <Svg><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7.5A5.8 5.8 0 0 0 19.3 3 5.4 5.4 0 0 0 19.1 0S17.9-.4 15 1.5a13.4 13.4 0 0 0-7 0C5.1-.4 3.9 0 3.9 0a5.4 5.4 0 0 0-.2 3A5.8 5.8 0 0 0 2.2 7c0 5.9 3.5 7.1 6.8 7.5A4.8 4.8 0 0 0 8 18v4M8 19c-3 .9-3-1.5-4.2-2"/></Svg>;
const ExternalLinkIcon = () => <Svg><path d="M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></Svg>;
const PlusIcon = () => <Svg><path d="M12 5v14M5 12h14"/></Svg>;
const CloseIcon = () => <Svg><path d="m7 7 10 10M17 7 7 17"/></Svg>;
const SlidersIcon = () => <Svg><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></Svg>;
const FolderIcon = () => <Svg><path d="M3 6h7l2 2h9v11H3z"/></Svg>;
const ChevronIcon = () => <Svg><path d="m9 6 6 6-6 6"/></Svg>;
const ConvertIcon = () => <Svg><path d="M4 7h13l-3-3M20 17H7l3 3"/></Svg>;
const CheckIcon = () => <Svg><path d="m5 12 4 4L19 6"/></Svg>;
const UpdateIcon = () => <Svg><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></Svg>;
const Spinner = () => <span className="spinner" />;
const BrandMark = () => <div className="brand-mark" aria-hidden="true"><img src={picflipIcon} alt="" /></div>;

export default App;
