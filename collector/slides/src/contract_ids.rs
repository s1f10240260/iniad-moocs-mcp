//! 固定インターフェース（WORK_SPLIT / DESIGN）の ID / パス導出。
//!
//! 契約:
//! - CODE: `[A-Za-z0-9_-]{1,32}`。slug がそのまま使えるときのみ採用（推測フォールバックなし）
//! - LL: 1..=999（JSONL では数値、パスでは 0 埋め 2 桁）
//! - スライド相対パス: `{year}/{CODE}/{LL:02}/slides.pdf`
//!
//! LL 割当方針（Issue #7）:
//! 1. slug 由来の数字（1..=999）を採用
//! 2. 使えない・衝突する講義は、一覧の通し番号から **最小の空き LL** を振る
//! 3. それでも振れない場合のみエラー（PDF 上書きはしない）

use std::collections::HashSet;

/// コース CODE。slug 全体が `[A-Za-z0-9_-]{1,32}` のときだけ大文字化して返す。
pub fn course_code(slug: &str) -> Result<String, String> {
    let upper = slug.to_ascii_uppercase();
    if is_valid_course_code(&upper) {
        Ok(upper)
    } else {
        Err(format!(
            "course slug {slug:?} は CODE（[A-Za-z0-9_-]{{1,32}}）として使えません。\
             slug そのものを CODE として設定してください"
        ))
    }
}

fn is_valid_course_code(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// slug 中の最初の数字列。無ければ None。
///
/// slug は URL エンコードされていることがある（例: `第7回` → `%E7%AC%AC7%E5%9B%9E`）。
/// エンコードされた 16 進 (`%E7` の `7`) を数字と誤認しないよう、**デコード後に**探す。
pub fn first_number(s: &str) -> Option<u32> {
    let decoded = percent_decode(s);
    let mut digits = String::new();
    let mut started = false;
    for c in decoded.chars() {
        if c.is_ascii_digit() {
            started = true;
            digits.push(c);
        } else if started {
            break;
        }
    }
    digits.parse().ok()
}

/// `%XX` をバイト列としてデコードする
fn percent_decode(s: &str) -> String {
    if !s.contains('%') {
        return s.to_string();
    }
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &s[i + 1..i + 3];
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// slug 由来の LL 候補（1..=999）。無ければ None。
fn slug_ll(slug: &str) -> Option<u32> {
    first_number(slug).filter(|n| (1..=999).contains(n))
}

/// 講義一覧に LL を割り当てる（Issue #7 方針）。
///
/// `entries` は (slug, flat_index) の並び。flat_index は `get_lectures` の flat 後の位置 + 1。
///
/// - slug 数字が使える講義はそれを優先（`02` → 2、`第7回` → 7）
/// - 同じ LL を欲しがる場合は **先勝ち**、後続は最小の空き LL
/// - slug に数字が無い講義も最小の空き LL
/// - 空きが無ければ Err（スキップ。上書きはしない）
pub fn assign_lecture_numbers(entries: &[(String, u32)]) -> (Vec<Result<u32, String>>, Vec<u32>) {
    let mut used: HashSet<u32> = HashSet::new();
    let mut results: Vec<Result<u32, String>> = Vec::with_capacity(entries.len());
    let mut reassigned: Vec<u32> = Vec::new();

    // Pass 1: slug 数字が一意な講義を先に確定（一覧順 = 先勝ち）
    let mut pending: Vec<Option<u32>> = Vec::with_capacity(entries.len());
    for (slug, _) in entries {
        match slug_ll(slug) {
            Some(ll) if used.insert(ll) => {
                pending.push(Some(ll));
                results.push(Ok(ll));
            }
            _ => {
                pending.push(None);
                results.push(Ok(0)); // placeholder
            }
        }
    }

    // Pass 2: 残りに最小の空き LL を振る
    let mut next = 1u32;
    for (i, (_, flat_index)) in entries.iter().enumerate() {
        if pending[i].is_some() {
            continue;
        }
        // 通し番号を起点に空きを探す（自然な番号になりやすい）
        let mut ll = (*flat_index).clamp(1, 999);
        while used.contains(&ll) {
            ll += 1;
            if ll > 999 {
                ll = 1;
            }
            if ll == (*flat_index).clamp(1, 999) {
                // 1 周した
                results[i] = Err(format!(
                    "lecture slug {:?} に振れる空き LL（1..=999）がありません",
                    entries[i].0
                ));
                break;
            }
        }
        if matches!(results[i], Ok(0)) {
            used.insert(ll);
            results[i] = Ok(ll);
            if Some(ll) != slug_ll(&entries[i].0) {
                reassigned.push(ll);
            }
            let _ = next;
        }
    }

    reassigned.sort_unstable();
    (results, reassigned)
}

/// 契約どおりの相対パス: `{year}/{CODE}/{LL:02}/slides.pdf`
pub fn rel_pdf_path(year: u32, code: &str, lecture_no: u32) -> String {
    format!("{year}/{code}/{lecture_no:02}/slides.pdf")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn course_code_accepts_valid_slug_only() {
        assert_eq!(course_code("INI201").unwrap(), "INI201");
        assert_eq!(course_code("ini201").unwrap(), "INI201");
        assert_eq!(course_code("INI_201-a").unwrap(), "INI_201-A");
    }

    #[test]
    fn course_code_rejects_unsafe_or_ambiguous_slugs() {
        assert!(course_code("intro:INI201").is_err());
        assert!(course_code("日本語のみ").is_err());
        assert!(course_code("").is_err());
        assert!(course_code("has space").is_err());
    }

    #[test]
    fn lecture_number_prefers_slug_digits() {
        assert_eq!(slug_ll("02"), Some(2));
        assert_eq!(slug_ll("2"), Some(2));
        assert_eq!(slug_ll("lecture-03"), Some(3));
        assert_eq!(slug_ll("intro"), None);
        assert_eq!(slug_ll("0"), None);
        assert_eq!(slug_ll("1000"), None);
    }

    #[test]
    fn assign_keeps_slug_ll_when_unique() {
        let entries = vec![
            ("02".to_string(), 1),
            ("Week3".to_string(), 2),
            ("%E7%AC%AC7%E5%9B%9E".to_string(), 3),
        ];
        let (results, reassigned) = assign_lecture_numbers(&entries);
        assert!(reassigned.is_empty());
        assert_eq!(results[0].as_ref().unwrap(), &2);
        assert_eq!(results[1].as_ref().unwrap(), &3);
        assert_eq!(results[2].as_ref().unwrap(), &7);
    }

    #[test]
    fn assign_reassigns_collisions_to_free_ll() {
        // 第15回 と Week15 がともに 15 を希望 → 先勝ちで 15、後続は空き 16
        let entries = vec![
            ("%E7%AC%AC15%E5%9B%9E".to_string(), 15),
            ("Week15".to_string(), 16),
        ];
        let (results, reassigned) = assign_lecture_numbers(&entries);
        assert_eq!(results[0].as_ref().unwrap(), &15);
        assert_eq!(results[1].as_ref().unwrap(), &16);
        assert_eq!(reassigned, vec![16]);
    }

    #[test]
    fn assign_fills_numbers_for_slugs_without_digits() {
        let entries = vec![
            ("00".to_string(), 1),
            ("02".to_string(), 2),
            ("-00".to_string(), 8),
        ];
        let (results, _) = assign_lecture_numbers(&entries);
        assert_eq!(results[0].as_ref().unwrap(), &1);
        assert_eq!(results[1].as_ref().unwrap(), &2);
        assert_eq!(results[2].as_ref().unwrap(), &8);
    }

    #[test]
    fn assign_detects_ll_collisions_when_no_free_slot() {
        // 1..=2 を両方使った状態で 3 つ目は空きがあるので成功するケースの対比
        let entries = vec![
            ("01".to_string(), 1),
            ("01".to_string(), 2),
            ("01".to_string(), 3),
        ];
        let (results, _) = assign_lecture_numbers(&entries);
        let lls: Vec<u32> = results.iter().map(|r| *r.as_ref().unwrap()).collect();
        let set: HashSet<u32> = lls.iter().copied().collect();
        assert_eq!(set.len(), 3, "LL must be unique: {lls:?}");
    }

    #[test]
    fn rel_pdf_path_matches_fixed_contract() {
        assert_eq!(rel_pdf_path(2026, "INI201", 2), "2026/INI201/02/slides.pdf");
        assert_eq!(
            rel_pdf_path(2026, "INI201", 10),
            "2026/INI201/10/slides.pdf"
        );
    }

    #[test]
    fn lecture_number_decodes_percent_encoded_slugs() {
        assert_eq!(slug_ll("%E7%AC%AC7%E5%9B%9E"), Some(7));
        assert_eq!(slug_ll("%E7%AC%AC12%E5%9B%9E"), Some(12));
        assert_ne!(slug_ll("%E7%AC%AC9%E5%9B%9E"), Some(7));
    }
}
