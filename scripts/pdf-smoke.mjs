import { mkdir, writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const outputDirectory = new URL("../tmp/pdfs/", import.meta.url);
await mkdir(outputDirectory, { recursive: true });

const document = await PDFDocument.create();
document.setCreator("PicFlip PDF smoke test");
const regular = await document.embedFont(StandardFonts.Helvetica);
const bold = await document.embedFont(StandardFonts.HelveticaBold);

for (const [index, colors] of [
  [rgb(0.94, 0.98, 0.84), rgb(0.12, 0.15, 0.1)],
  [rgb(0.13, 0.15, 0.12), rgb(0.79, 0.94, 0.35)],
].entries()) {
  const page = document.addPage([720, 960]);
  page.drawRectangle({ x: 0, y: 0, width: 720, height: 960, color: colors[0] });
  page.drawText("PicFlip", { x: 58, y: 840, size: 42, font: bold, color: colors[1] });
  page.drawText(`PDF workflow verification · page ${index + 1}`, { x: 60, y: 795, size: 18, font: regular, color: colors[1] });
  page.drawRectangle({ x: 60, y: 545, width: 600, height: 190, borderWidth: 2, borderColor: colors[1], opacity: 0.92 });
  page.drawText(index === 0 ? "PDF -> PNG / JPG / WebP" : "Images -> one ordered PDF", { x: 88, y: 650, size: 25, font: bold, color: colors[1] });
  page.drawText("Generated locally. No upload required.", { x: 88, y: 605, size: 16, font: regular, color: colors[1] });
  page.drawText("PNG  <->  JPG  <->  WEBP  <->  ICO  <->  BMP  <->  TIFF", { x: 60, y: 120, size: 14, font: regular, color: colors[1] });
}

await writeFile(new URL("picflip-smoke.pdf", outputDirectory), await document.save());
