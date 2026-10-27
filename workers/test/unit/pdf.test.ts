import { describe, expect, it } from "vitest";

import { pdfToText } from "../../ingest/pdf.js";

function minimalPdf(text: string): Uint8Array {
  // Helvetica の1行 PDF（pdfToText の動作確認用）
  const stream = `BT /F1 24 Tf 72 720 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
  const objs = [
    `1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n`,
    `2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n`,
    `3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj\n`,
    `4 0 obj<< /Length ${stream.length} >>stream\n${stream}\nendstream\nendobj\n`,
    `5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n`,
  ];
  const header = "%PDF-1.4\n";
  let body = header;
  const offsets: number[] = [];
  for (const o of objs) {
    offsets.push(body.length);
    body += o;
  }
  const xrefPos = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

describe("pdfToText", () => {
  it("extracts text from a simple pdf", async () => {
    const text = await pdfToText(minimalPdf("Hello Moocs"));
    expect(text).toContain("Hello Moocs");
  });

  it("returns empty string on garbage", async () => {
    const text = await pdfToText(new TextEncoder().encode("not a pdf"));
    expect(text).toBe("");
  });
});
