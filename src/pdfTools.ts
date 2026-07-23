import { PDFDocument } from "pdf-lib";
import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

const maximumInMemoryBytes = 256 * 1024 * 1024;
const maximumPdfPages = 500;
const maximumImageDimension = 16_384;
const maximumImagePixels = 100_000_000;

export interface RenderedPdfPage {
  pageNumber: number;
  dataBase64: string;
  width: number;
  height: number;
}

export type PdfResizeMode = "original" | "percentage" | "dimensions";
export type PdfPageSize = "auto" | "a4" | "letter" | "custom";

export interface PdfImageResizeOptions {
  mode: PdfResizeMode;
  scalePercent: number;
  width: number;
  height: number;
}

export interface PdfCreationOptions {
  pageSize: PdfPageSize;
  widthMm: number;
  heightMm: number;
}

export async function renderPdfToImages(
  pdfBase64: string,
  format: "png" | "jpg" | "webp",
  quality: number,
  scale: number,
  resize: PdfImageResizeOptions,
  onProgress?: (page: number, total: number) => void,
): Promise<RenderedPdfPage[]> {
  const loadingTask = pdfjs.getDocument({ data: base64ToBytes(pdfBase64) });
  const document = await loadingTask.promise;
  const rendered: RenderedPdfPage[] = [];
  let renderedBytes = 0;

  try {
    if (document.numPages > maximumPdfPages) {
      throw new Error(`PDF files are limited to ${maximumPdfPages} pages.`);
    }
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      onProgress?.(pageNumber, document.numPages);
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: Math.min(4, Math.max(1, scale)) });
      const outputSize = resolvePdfImageSize(viewport.width, viewport.height, resize);
      const canvas = window.document.createElement("canvas");
      canvas.width = outputSize.width;
      canvas.height = outputSize.height;
      validateImageDimensions(canvas.width, canvas.height);
      const context = canvas.getContext("2d", { alpha: format !== "jpg" });
      if (!context) throw new Error("This computer could not create a PDF drawing surface.");

      if (format === "jpg") {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }

      const scaleX = canvas.width / viewport.width;
      const scaleY = canvas.height / viewport.height;
      await page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: [scaleX, 0, 0, scaleY, 0, 0],
      }).promise;
      const mime = format === "jpg" ? "image/jpeg" : `image/${format}`;
      const blob = await canvasToBlob(canvas, mime, quality / 100);
      renderedBytes += blob.size;
      if (renderedBytes > maximumInMemoryBytes) {
        throw new Error("The rendered PDF output is too large to process safely.");
      }
      rendered.push({
        pageNumber,
        dataBase64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
        width: canvas.width,
        height: canvas.height,
      });
      canvas.width = 1;
      canvas.height = 1;
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }

  return rendered;
}

export async function createPdfFromPngImages(
  pngImagesBase64: string[],
  options: PdfCreationOptions,
): Promise<string> {
  if (pngImagesBase64.length === 0) throw new Error("Add at least one image first.");
  if (pngImagesBase64.length > maximumPdfPages) {
    throw new Error(`PDF files are limited to ${maximumPdfPages} pages.`);
  }
  const document = await PDFDocument.create();
  document.setCreator("PicFlip");
  document.setProducer("PicFlip offline PDF tools");

  for (const imageBase64 of pngImagesBase64) {
    const image = await document.embedPng(base64ToBytes(imageBase64));
    validateImageDimensions(image.width, image.height);
    const pageSize = resolvePdfPageSize(image.width, image.height, options);
    const page = document.addPage([pageSize.width, pageSize.height]);
    const availableWidth = pageSize.width - pageSize.margin * 2;
    const availableHeight = pageSize.height - pageSize.margin * 2;
    const fitScale = Math.min(availableWidth / image.width, availableHeight / image.height);
    const width = Math.max(1, image.width * fitScale);
    const height = Math.max(1, image.height * fitScale);
    page.drawImage(image, {
      x: (pageSize.width - width) / 2,
      y: (pageSize.height - height) / 2,
      width,
      height,
    });
  }

  const bytes = await document.save();
  if (bytes.byteLength > maximumInMemoryBytes) {
    throw new Error("The generated PDF is too large to process safely.");
  }
  return bytesToBase64(bytes);
}

function resolvePdfImageSize(
  sourceWidth: number,
  sourceHeight: number,
  resize: PdfImageResizeOptions,
) {
  if (resize.mode === "original") {
    return { width: Math.ceil(sourceWidth), height: Math.ceil(sourceHeight) };
  }
  if (resize.mode === "percentage") {
    if (!Number.isFinite(resize.scalePercent) || resize.scalePercent < 10 || resize.scalePercent > 400) {
      throw new Error("PDF output scale must be between 10% and 400%.");
    }
    return {
      width: Math.max(1, Math.round(sourceWidth * resize.scalePercent / 100)),
      height: Math.max(1, Math.round(sourceHeight * resize.scalePercent / 100)),
    };
  }
  if (!Number.isFinite(resize.width) || !Number.isFinite(resize.height)
    || resize.width < 1 || resize.height < 1) {
    throw new Error("PDF output width and height must be positive numbers.");
  }
  const fitScale = Math.min(resize.width / sourceWidth, resize.height / sourceHeight);
  return {
    width: Math.max(1, Math.round(sourceWidth * fitScale)),
    height: Math.max(1, Math.round(sourceHeight * fitScale)),
  };
}

function resolvePdfPageSize(
  imageWidth: number,
  imageHeight: number,
  options: PdfCreationOptions,
) {
  if (options.pageSize === "auto") {
    const maximumSide = 1440;
    const scale = Math.min(1, maximumSide / Math.max(imageWidth, imageHeight));
    return {
      width: Math.max(1, imageWidth * scale),
      height: Math.max(1, imageHeight * scale),
      margin: 0,
    };
  }

  const [width, height] = options.pageSize === "a4"
    ? [595.28, 841.89]
    : options.pageSize === "letter"
      ? [612, 792]
      : [millimetresToPoints(options.widthMm), millimetresToPoints(options.heightMm)];

  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 25 || height < 25
    || width > millimetresToPoints(1000) || height > millimetresToPoints(1000)) {
    throw new Error("Custom PDF pages must be between 25 mm and 1000 mm per side.");
  }
  return { width, height, margin: 24 };
}

function millimetresToPoints(value: number) {
  return value * 72 / 25.4;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error(`This computer cannot export ${type}.`)),
      type,
      Math.min(1, Math.max(0.1, quality)),
    );
  });
}

function base64ToBytes(value: string): Uint8Array {
  const estimatedBytes = Math.floor(value.length * 0.75);
  if (estimatedBytes > maximumInMemoryBytes) {
    throw new Error("This file is too large to process safely.");
  }
  const binary = atob(value);
  if (binary.length > maximumInMemoryBytes) {
    throw new Error("This file is too large to process safely.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.byteLength > maximumInMemoryBytes) {
    throw new Error("This file is too large to process safely.");
  }
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function validateImageDimensions(width: number, height: number) {
  const pixels = width * height;
  if (!Number.isFinite(pixels)
    || width < 1
    || height < 1
    || width > maximumImageDimension
    || height > maximumImageDimension
    || pixels > maximumImagePixels) {
    throw new Error(`Images are limited to ${maximumImageDimension}px per side and ${maximumImagePixels} pixels.`);
  }
}
