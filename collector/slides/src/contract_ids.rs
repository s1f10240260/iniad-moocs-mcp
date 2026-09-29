//! 固定インターフェース（WORK_SPLIT / DESIGN）の ID / パス導出。
//!
//! 契約:
//! - CODE: `[A-Za-z0-9_-]{1,32}`。slug がそのまま使えるときのみ採用（推測フォールバックなし）
//! - LL: 1..=999（JSONL では数値、パスでは 0 埋め 2 桁）
//! - スライド相対パス: `{year}/{CODE}/{LL:02}/slides.pdf`
//!
//! 導出できない・LL が重複する場合はエラーにし、黙って上書きしない。

/// コース CODE。slug 全体が `[A-Za-z0-9_-]{1,32}` のときだけ大文字化して返す。
/// それ以外（日本語・コロン含みなど）は推測せずエラー。
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
pub fn first_number(s: &str) -> Option<u32> {
    let mut digits = String::new();
    let mut started = false;
    for c in s.chars() {
        if c.is_ascii_digit() {
            started = true;
            digits.push(c);
        } else if started {
            break;
        }
    }
    digits.parse().ok()
}

/// 1 件分の LL 候補。slug の数字を優先し、無ければ `fallback`（一覧全体での通し番号）。
pub fn lecture_number_candidate(slug: &str, fallback: u32) -> Result<u32, String> {
    let n = first_number(slug).unwrap_or(fallback);
    if (1..=999).contains(&n) {
        Ok(n)
    } else {
        Err(format!(
            "lecture slug {slug:?} から LL（1..=999）を導けません (fallback={fallback})"
        ))
    }
}

/// 講義一覧に LL を割り当てる。衝突した LL は **すべて**エラーにして上書きを防ぐ。
///
/// `entries` は (slug, fallback_index) の並び。fallback はコース一覧全体での通し番号
/// （`get_lectures` の flat 後の位置 + 1）。サイドバー内のグループごとの `index` は使わない。
pub fn assign_lecture_numbers(entries: &[(String, u32)]) -> (Vec<Result<u32, String>>, Vec<u32>) {
    let mut results: Vec<Result<u32, String>> = Vec::with_capacity(entries.len());
    let mut used: Vec<(u32, usize)> = Vec::new(); // (ll, first_index)

    for (i, (slug, fallback)) in entries.iter().enumerate() {
        match lecture_number_candidate(slug, *fallback) {
            Ok(ll) => {
                used.push((ll, i));
                results.push(Ok(ll));
            }
            Err(e) => results.push(Err(e)),
        }
    }

    // 衝突検出: 同じ LL を使った位置をすべて Err にする
    let mut counts: std::collections::HashMap<u32, Vec<usize>> = std::collections::HashMap::new();
    for (ll, i) in &used {
        counts.entry(*ll).or_default().push(*i);
    }
    let mut collided: Vec<u32> = Vec::new();
    for (ll, idxs) in counts {
        if idxs.len() > 1 {
            collided.push(ll);
            for i in idxs {
                results[i] = Err(format!(
                    "lecture LL {ll:02} が複数講義で衝突しています。slug に一意な数字を付けるか、講義を分離してください"
                ));
            }
        }
    }
    collided.sort_unstable();
    (results, collided)
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
        // 推測フォールバックは廃止。混ざった slug は CODE にしない
        assert!(course_code("intro:INI201").is_err());
        assert!(course_code("日本語のみ").is_err());
        assert!(course_code("").is_err());
        assert!(course_code("has space").is_err());
    }

    #[test]
    fn lecture_number_prefers_slug_digits() {
        assert_eq!(lecture_number_candidate("02", 9).unwrap(), 2);
        assert_eq!(lecture_number_candidate("2", 0).unwrap(), 2);
        assert_eq!(lecture_number_candidate("lecture-03", 0).unwrap(), 3);
        assert_eq!(lecture_number_candidate("intro", 5).unwrap(), 5);
        assert!(lecture_number_candidate("0", 0).is_err());
        assert!(lecture_number_candidate("1000", 0).is_err());
    }

    #[test]
    fn assign_detects_ll_collisions() {
        // グループ分割で index が振り直されても、fallback は一覧全体の通し番号を使う
        let entries = vec![
            ("intro".to_string(), 1),
            ("02".to_string(), 2),
            ("02-extra".to_string(), 3), // slug 数字 02 と衝突
            ("wrap".to_string(), 4),
        ];
        let (results, collided) = assign_lecture_numbers(&entries);
        assert_eq!(collided, vec![2]);
        assert!(results[0].is_ok()); // 1
        assert!(results[1].is_err()); // 02
        assert!(results[2].is_err()); // 02-extra
        assert_eq!(results[3].as_ref().unwrap(), &4);
    }

    #[test]
    fn assign_uses_fallback_when_slug_has_no_digits() {
        let entries = vec![
            ("intro".to_string(), 1),
            ("advanced".to_string(), 2),
            ("workshop".to_string(), 3),
        ];
        let (results, collided) = assign_lecture_numbers(&entries);
        assert!(collided.is_empty());
        assert_eq!(
            results
                .iter()
                .map(|r| r.as_ref().unwrap())
                .collect::<Vec<_>>(),
            vec![&1, &2, &3]
        );
    }

    #[test]
    fn rel_pdf_path_matches_fixed_contract() {
        assert_eq!(rel_pdf_path(2026, "INI201", 2), "2026/INI201/02/slides.pdf");
        assert_eq!(
            rel_pdf_path(2026, "INI201", 10),
            "2026/INI201/10/slides.pdf"
        );
    }
}
