import { PDFDocument } from "pdf-lib";
import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

export interface RenderedPdfPage {
  pageNumber: number;
  dataBase64: string;
  width: number;
  height: number;
}

export async function renderPdfToImages(
  pdfBase64: string,
  format: "png" | "jpg" | "webp",
  quality: number,
  scale: number,
  onProgress?: (page: number, total: number) => void,
): Promise<RenderedPdfPage[]> {
  const loadingTask = pdfjs.getDocument({ data: base64ToBytes(pdfBase64) });
  const document = await loadingTask.promise;
  const rendered: RenderedPdfPage[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      onProgress?.(pageNumber, document.numPages);
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: Math.min(4, Math.max(1, scale)) });
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { alpha: format !== "jpg" });
      if (!context) throw new Error("This computer could not create a PDF drawing surface.");

      if (format === "jpg") {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }

      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const mime = format === "jpg" ? "image/jpeg" : `image/${format}`;
      const blob = await canvasToBlob(canvas, mime, quality / 100);
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

export async function createPdfFromPngImages(pngImagesBase64: string[]): Promise<string> {
  if (pngImagesBase64.length === 0) throw new Error("Add at least one image first.");
  const document = await PDFDocument.create();
  document.setCreator("PicFlip");
  document.setProducer("PicFlip offline PDF tools");

  for (const imageBase64 of pngImagesBase64) {
    const image = await document.embedPng(base64ToBytes(imageBase64));
    const maximumSide = 1440;
    const fitScale = Math.min(1, maximumSide / Math.max(image.width, image.height));
    const width = Math.max(1, image.width * fitScale);
    const height = Math.max(1, image.height * fitScale);
    const page = document.addPage([width, height]);
    page.drawImage(image, { x: 0, y: 0, width, height });
  }

  return bytesToBase64(await document.save());
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
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
