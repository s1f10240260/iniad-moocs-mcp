/**
 * PDF からプレーンテキストを取り出す（スライド検索用）。
 * 失敗時は空文字を返し、取り込み自体は止めない。
 */
import { extractText, getDocumentProxy } from "unpdf";

const MAX_CHARS = 200_000;

export async function pdfToText(data: Uint8Array): Promise<string> {
  try {
    const pdf = await getDocumentProxy(data);
    const { text } = await extractText(pdf, { mergePages: true });
    const s = (text ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) : s;
  } catch {
    return "";
  }
}
