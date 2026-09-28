//! 固定インターフェース（WORK_SPLIT / DESIGN）の ID / パス導出。
//!
//! 契約:
//! - CODE: `[A-Za-z0-9_-]{1,32}`
//! - LL: 1..=999（JSONL では数値、パスでは 0 埋め 2 桁）
//! - スライド相対パス: `{year}/{CODE}/{LL:02}/slides.pdf`

/// コース CODE。slug がそのまま使えるなら大文字化して返す。
/// 使えなければ先頭の英数トークンを使う。
pub fn course_code(slug: &str) -> Result<String, String> {
    let upper = slug.to_ascii_uppercase();
    if is_valid_course_code(&upper) {
        return Ok(upper);
    }
    let token: String = upper
        .chars()
        .skip_while(|c| !c.is_ascii_alphanumeric() && *c != '_' && *c != '-')
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if is_valid_course_code(&token) {
        Ok(token)
    } else {
        Err(format!(
            "course slug {slug:?} から CODE（[A-Za-z0-9_-]{{1,32}}）を導けません"
        ))
    }
}

fn is_valid_course_code(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn first_number(s: &str) -> Option<u32> {
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

/// レクチャー番号 LL（1..=999）。slug 中の最初の数字列を優先し、無ければ index + 1。
pub fn lecture_number(slug: &str, index: usize) -> Result<u32, String> {
    let n = first_number(slug).unwrap_or((index + 1) as u32);
    if (1..=999).contains(&n) {
        Ok(n)
    } else {
        Err(format!(
            "lecture slug {slug:?} (index={index}) から LL（1..=999）を導けません"
        ))
    }
}

/// 契約どおりの相対パス: `{year}/{CODE}/{LL:02}/slides.pdf`
pub fn rel_pdf_path(year: u32, code: &str, lecture_no: u32) -> String {
    format!("{year}/{code}/{lecture_no:02}/slides.pdf")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn course_code_accepts_and_uppercases() {
        assert_eq!(course_code("INI201").unwrap(), "INI201");
        assert_eq!(course_code("ini201").unwrap(), "INI201");
        assert_eq!(course_code("INI_201-a").unwrap(), "INI_201-A");
    }

    #[test]
    fn course_code_extracts_token_from_noisy_slug() {
        assert_eq!(course_code("intro:INI201").unwrap(), "INTRO");
        assert!(course_code("日本語のみ").is_err());
        assert!(course_code("").is_err());
    }

    #[test]
    fn lecture_number_prefers_digits() {
        assert_eq!(lecture_number("02", 9).unwrap(), 2);
        assert_eq!(lecture_number("2", 0).unwrap(), 2);
        assert_eq!(lecture_number("lecture-03", 0).unwrap(), 3);
        assert_eq!(lecture_number("intro", 0).unwrap(), 1);
        assert_eq!(lecture_number("intro", 4).unwrap(), 5);
        assert!(lecture_number("0", 0).is_err());
        assert!(lecture_number("1000", 0).is_err());
    }

    #[test]
    fn rel_pdf_path_matches_fixed_contract() {
        // PR #4 ingest の expectedFile() と一致すること
        assert_eq!(rel_pdf_path(2026, "INI201", 2), "2026/INI201/02/slides.pdf");
        assert_eq!(rel_pdf_path(2026, "INI201", 10), "2026/INI201/10/slides.pdf");
    }
}
