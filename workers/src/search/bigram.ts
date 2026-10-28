/**
 * アプリ側バイグラム分割。
 *
 * D1 はカスタムトークナイザを読み込めず、組み込みの trigram は 2 文字以下の語を検索できない。
 * そこで索引時・検索時の両方でテキストを 2 文字ずつのトークンに分け、空白区切りで
 * FTS5 の unicode61 トークナイザに渡す。取り込み（ingest）と検索（Workers）は必ずこのモジュールを共有すること。
 *
 *   索引: "データ基礎" → "デー ータ タ基 基礎 礎"（各区間の末尾 1 文字も入れる = 1 文字検索用）
 *   検索: "ータ基"   → "ータ タ基"（連続したバイグラムのフレーズ = 部分文字列一致）
 *         "礎"       → "礎"*（前方一致）
 *
 * ⚠ 分割方法を変えたら `ingest --reindex` で D1 の *_bg 列を作り直すこと
 *   （差分取り込みでは古い *_bg が残る行がある）。
 */

// unicode61 の既定のトークン文字（L* N* Co）に揃える。それ以外は区切りとして扱う
const SEGMENT = /[\p{L}\p{N}\p{Co}]+/gu;

function normalize(text: string): string {
  // NFKC で全角英数字・半角カナを揃える（"第２回" → "第2回"、"ＩＣＴ" → "ICT"）
  return text.normalize("NFKC").toLowerCase();
}

function segments(text: string): string[][] {
  return (normalize(text).match(SEGMENT) ?? []).map((s) => Array.from(s));
}

function bigrams(chars: string[]): string[] {
  const grams: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) grams.push(chars[i] + chars[i + 1]);
  return grams;
}

/** 索引用のトークン列（空白区切り） */
export function toBigramText(text: string): string {
  return segments(text)
    .flatMap((chars) => [...bigrams(chars), chars[chars.length - 1]])
    .join(" ");
}

/**
 * 検索語を FTS5 の MATCH 式にする。検索できる文字が無ければ null。
 * 空白などで区切られた語は AND で結ぶ。
 */
export function toBigramQuery(query: string): string | null {
  const terms = segments(query).map((chars) =>
    chars.length === 1 ? `"${chars[0]}"*` : `"${bigrams(chars).join(" ")}"`,
  );
  return terms.length > 0 ? terms.join(" AND ") : null;
}
