import { createWorker } from "tesseract.js";
import * as pdfjs from "pdfjs-dist";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

export async function recognizeDocument(file, onProgress = () => {}) {
  const worker = await createWorker("ron+eng", 1, {
    logger: (event) => { if (event.status === "recognizing text") onProgress(Math.round(event.progress * 100)); }
  });
  try {
    let fullText = "";
    if (file.type === "application/pdf") {
      const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
      const maxPages = Math.min(pdf.numPages, 8);
      for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
        const result = await worker.recognize(canvas);
        fullText += "\n" + result.data.text;
      }
    } else {
      const result = await worker.recognize(file);
      fullText = result.data.text;
    }
    return fullText.trim();
  } finally {
    await worker.terminate();
  }
}

function money(raw) {
  const value = String(raw).replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function extractInvoiceFields(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const joined = lines.join(" ");
  const amount = (pattern) => {
    const match = joined.match(pattern);
    return match ? money(match[1]) : null;
  };
  const cui = joined.match(/\b(?:CUI|C\.U\.I\.?|CIF)\s*[:#-]?\s*(RO\s*)?(\d{2,10})/i);
  const invoice = joined.match(/(?:factur[ăa]|invoice)\s*(?:nr\.?|num[ăa]r)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]{1,24})/i)
    || joined.match(/\b(?:nr\.?\s*factur[ăa]?|num[ăa]r factur[ăa])\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]{1,24})/i);
  const dateMatch = joined.match(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/);
  const total = amount(/(?:total\s+(?:de\s+plată|de plata|factură|factura|general)|total\s+plata|valoare\s+cu\s+TVA)\D{0,30}(\d[\d\s.,]{0,14})/i);
  const vat = amount(/(?:TVA|valoare\s+TVA)\D{0,24}(\d[\d\s.,]{0,14})/i);
  const net = amount(/(?:total\s+fără\s+TVA|total\s+fara\s+TVA|baza\s+impozabilă|baza\s+impozabila|valoare\s+fără\s+TVA|valoare\s+fara\s+TVA)\D{0,24}(\d[\d\s.,]{0,14})/i);
  const supplier = lines.find((line) => line.length > 3 && line.length < 100 && !/factur|cui|cod fiscal|adres|total/i.test(line)) || "";
  const items = lines.filter((line) => /[A-ZĂÂÎȘȚa-zăâîșț]{3,}/.test(line) && /\d/.test(line) && !/factur|cui|cod fiscal|tva|total|iban|banc/i.test(line))
    .slice(0, 40).map((line) => ({ description: line, quantity: "", unitPrice: "", total: "" }));
  const date = dateMatch ? dateMatch[3] + "-" + dateMatch[2].padStart(2, "0") + "-" + dateMatch[1].padStart(2, "0") : "";
  return {
    supplier,
    companyName: supplier,
    cui: cui ? ((cui[1] || "") + cui[2]).replace(/\s/g, "") : "",
    invoiceNumber: invoice ? invoice[1] : "",
    issueDate: date,
    net: net !== null ? net : total !== null && vat !== null ? Math.max(0, total - vat) : 0,
    vat: vat !== null ? vat : 0,
    total: total !== null ? total : net !== null && vat !== null ? net + vat : 0,
    items,
    rawText: text
  };
}

export function extractJobHints(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 30).join("\n");
}
