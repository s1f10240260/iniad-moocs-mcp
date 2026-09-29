//! collect-headless — 非対話スライド収集ラッパー
//!
//! 公式 `collect-cli` は `--path` / `--year` のみで実行後に対話選択するため
//! CI では使えない。本バイナリは `collect` crate を直接叩き、
//! フラグ指定だけで一括収集する。
//!
//! 詳細: ../../DESIGN.md 「データ収集ラッパー設計」

use clap::{Parser, Subcommand};
use collect::error::CollectError;
use collect::pdf;
use collect::{Collect, Course, Credentials, Lecture, LecturePage, SlideContent, Year};
use futures::stream::{self, StreamExt, TryStreamExt};
use reqwest::Client;
use serde_json::json;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

mod contract_ids;
use contract_ids::{assign_lecture_numbers, course_code, rel_pdf_path};

/// 対話プロンプトを一切出さない非対話収集 CLI
///
/// Debug は実装しない（パスワードが {:?} で漏れないように）
#[derive(Parser)]
#[command(name = "collect-headless", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    /// 対象年度 (例: 2026)
    #[arg(long, env = "MOOCS_YEAR")]
    year: Option<u32>,

    /// 出力ディレクトリ
    #[arg(long, env = "MOOCS_OUT")]
    path: Option<PathBuf>,

    /// 全講義を非対話で一括取得する
    #[arg(long, conflicts_with = "course")]
    all: bool,

    /// 対象コース CODE（大文字小文字無視の完全一致。例: INI201）
    #[arg(long, conflicts_with = "all")]
    course: Option<String>,

    /// 対象レクチャー（LL の数値完全一致、または slug / 名前の部分一致）
    #[arg(long)]
    lecture: Option<String>,

    /// 障害時リトライ回数（認証エラーはリトライしない）
    #[arg(long, default_value_t = 3)]
    retries: u32,

    /// 進捗を JSON Lines で stdout へ出力する
    #[arg(long)]
    json: bool,

    /// 人間向けログを抑制する
    #[arg(long)]
    quiet: bool,

    /// Moocs / Google のユーザー名（学籍番号）。env 推奨
    #[arg(long, env = "MOOCS_USERNAME", hide_env_values = true)]
    username: Option<String>,

    /// パスワード。CLI 引数はプロセス一覧に残るため env `MOOCS_PASSWORD` を推奨
    #[arg(long, env = "MOOCS_PASSWORD", hide_env_values = true)]
    password: Option<String>,
}

#[derive(Subcommand)]
enum Command {
    /// 認証のみ確認する（収集しない）
    AuthCheck,
}

const EXIT_USAGE: u8 = 2;
const EXIT_RUNTIME: u8 = 1;

/// 1 講義の処理結果。skip を ok に混ぜない
enum Outcome {
    Saved,
    Skipped,
}

fn emit(json_mode: bool, quiet: bool, event: serde_json::Value, human: &str) {
    if json_mode {
        println!("{}", event);
    } else if !quiet {
        eprintln!("{human}");
    }
}

fn out_pdf_path(root: &Path, year: u32, code: &str, lecture_no: u32) -> PathBuf {
    root.join(year.to_string())
        .join(code)
        .join(format!("{lecture_no:02}"))
        .join("slides.pdf")
}

/// 一時ファイルに書いてから rename する（壊れた PDF を最終パスに残さない）
async fn save_pdf_atomic(doc: &mut lopdf::Document, out: &Path) -> Result<(), anyhow::Error> {
    let tmp = out.with_extension("pdf.tmp");
    if let Some(dir) = out.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    doc.save(&tmp)?;
    tokio::fs::rename(&tmp, out).await?;
    Ok(())
}

/// CODE との完全一致（大文字小文字無視）。部分一致はしない（CI での誤爆防止）
fn course_matches_code(course: &Course, want_code: &str) -> bool {
    course_code(course.key.slug.value())
        .map(|c| c.eq_ignore_ascii_case(want_code))
        .unwrap_or(false)
}

fn matches_lecture(lecture: &Lecture, needle: &str, assigned_ll: Option<u32>) -> bool {
    if let Ok(n) = needle.trim().parse::<u32>() {
        return assigned_ll == Some(n);
    }
    let n = needle.to_lowercase();
    lecture.key.slug.value().to_lowercase().contains(&n)
        || lecture.display_name().to_lowercase().contains(&n)
}

/// 一時的な障害だけ再試行する（認証失敗の多重試行でロックを誘発しない）
fn is_retryable(e: &CollectError) -> bool {
    matches!(
        e,
        CollectError::Network { .. } | CollectError::Timeout { .. } | CollectError::RateLimit
    )
}

async fn with_retries<T, F, Fut>(retries: u32, mut op: F) -> Result<T, CollectError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, CollectError>>,
{
    let mut attempt = 0;
    loop {
        match op().await {
            Ok(v) => return Ok(v),
            Err(e) if attempt < retries && is_retryable(&e) => {
                attempt += 1;
                let wait = Duration::from_secs(2u64.pow(attempt));
                eprintln!("retry {attempt}/{retries} after {wait:?}: {e}");
                tokio::time::sleep(wait).await;
            }
            Err(e) => return Err(e),
        }
    }
}

/// 同時実行数を上限付きにして取得する（順序維持のため buffer_unordered ではなく buffered）
async fn collect_slide_contents(
    collect: &Collect,
    slides: &[collect::Slide],
    retries: u32,
) -> Result<Vec<SlideContent>, CollectError> {
    stream::iter(slides.iter())
        .map(
            |slide| async move { with_retries(retries, || collect.get_slide_content(slide)).await },
        )
        .buffered(4)
        .try_collect()
        .await
}

#[allow(clippy::too_many_arguments)]
async fn save_lecture_slides(
    collect: &Collect,
    client: &Client,
    year: u32,
    course_code: &str,
    lecture_no: u32,
    lecture: &Lecture,
    course_name: &str,
    root: &Path,
    json: bool,
    quiet: bool,
    retries: u32,
) -> Result<Outcome, anyhow::Error> {
    let pages: Vec<LecturePage> = with_retries(retries, || collect.get_pages(&lecture.key)).await?;

    let mut contents: Vec<SlideContent> = Vec::new();
    for page in &pages {
        let slides = with_retries(retries, || collect.get_slides(&page.key)).await?;
        if slides.is_empty() {
            continue;
        }
        let page_contents = collect_slide_contents(collect, &slides, retries).await?;
        contents.extend(page_contents);
    }

    let rel = rel_pdf_path(year, course_code, lecture_no);
    let out = out_pdf_path(root, year, course_code, lecture_no);

    if contents.is_empty() {
        emit(
            json,
            quiet,
            json!({
                "event": "skip",
                "year": year,
                "course": course_code,
                "lecture": lecture_no,
                "reason": "no_slides",
            }),
            "skip: no slides",
        );
        return Ok(Outcome::Skipped);
    }

    let preprocessor = pdf::PreProcessor::default();
    let mut all_svgs = Vec::new();
    for content in &contents {
        let pre = preprocessor.preprocess(client, content).await?;
        all_svgs.extend(pre.svgs);
    }

    // 1 レクチャー = 1 PDF（全ページ SVG を連結して convert）
    let combined = SlideContent::new(contents[0].page_key.clone(), all_svgs);
    let mut doc = pdf::convert(&combined)?;
    save_pdf_atomic(&mut doc, &out).await?;

    let pages_count = doc.get_pages().len();
    emit(
        json,
        quiet,
        json!({
            "event": "done",
            "year": year,
            "course": course_code,
            "lecture": lecture_no,
            "file": rel,
            "pages": pages_count,
            "course_name": course_name,
            "lecture_title": lecture.display_name(),
        }),
        &format!("done: {rel}"),
    );
    Ok(Outcome::Saved)
}

fn build_client() -> Result<Client, anyhow::Error> {
    Ok(Client::builder()
        .user_agent("collect-headless/0.1 (INIAD Moocs MCP; +https://github.com/s1f10240260/iniad-moocs-mcp)")
        .cookie_store(true)
        .build()?)
}

async fn login(collect: &Collect, cli: &Cli) -> Result<(), anyhow::Error> {
    let (Some(username), Some(password)) = (cli.username.as_ref(), cli.password.as_ref()) else {
        anyhow::bail!(
            "認証情報がありません。MOOCS_USERNAME / MOOCS_PASSWORD（または --username / --password）を指定してください"
        );
    };

    let credentials = Credentials::new(username, password);
    match with_retries(cli.retries, || collect.authenticate(&credentials)).await {
        Ok(()) => {
            emit(cli.json, cli.quiet, json!({"event": "auth_ok"}), "auth: ok");
            Ok(())
        }
        Err(CollectError::Authentication { reason }) => {
            emit(
                cli.json,
                cli.quiet,
                json!({"event": "error", "code": "auth_expired", "message": reason}),
                &format!("auth failed: {reason}"),
            );
            Err(anyhow::anyhow!("auth failed: {reason}"))
        }
        Err(e) => {
            emit(
                cli.json,
                cli.quiet,
                json!({"event": "error", "code": "auth_error", "message": e.to_string()}),
                &format!("auth error: {e}"),
            );
            Err(e.into())
        }
    }
}

/// 引数・実行時エラーを JSONL / stderr に揃えて出し、exit code を決める
fn fail(json: bool, quiet: bool, code: &'static str, message: &str, exit_code: u8) -> ExitCode {
    emit(
        json,
        quiet,
        json!({"event": "error", "code": code, "message": message}),
        &format!("error: {message}"),
    );
    ExitCode::from(exit_code)
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();

    let client = match build_client() {
        Ok(c) => c,
        Err(e) => {
            return fail(
                cli.json,
                cli.quiet,
                "client_init",
                &e.to_string(),
                EXIT_RUNTIME,
            );
        }
    };
    let http = client.clone();
    let collect = Collect::from(Arc::new(client));

    // auth-check: 認証のみ（--year / --path 不要）
    if matches!(cli.command, Some(Command::AuthCheck)) {
        return match login(&collect, &cli).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(_) => ExitCode::from(EXIT_RUNTIME),
        };
    }

    let (Some(year_raw), Some(path)) = (cli.year, cli.path.as_ref()) else {
        return fail(
            cli.json,
            cli.quiet,
            "usage",
            "--year と --path は必須です（対話入力は行いません）",
            EXIT_USAGE,
        );
    };

    if !cli.all && cli.course.is_none() {
        return fail(
            cli.json,
            cli.quiet,
            "usage",
            "--all か --course のどちらかを指定してください（対話選択はありません）",
            EXIT_USAGE,
        );
    }

    // ingest が受理する範囲（2000–2100）に揃える
    if !(2000..=2100).contains(&year_raw) {
        return fail(
            cli.json,
            cli.quiet,
            "usage",
            &format!("--year は 2000–2100 で指定してください（got {year_raw}）"),
            EXIT_USAGE,
        );
    }
    let year = match Year::new(year_raw) {
        Ok(y) => y,
        Err(e) => {
            return fail(cli.json, cli.quiet, "usage", &e.to_string(), EXIT_USAGE);
        }
    };

    if let Err(_e) = login(&collect, &cli).await {
        return ExitCode::from(EXIT_RUNTIME);
    }

    let courses: Vec<Course> =
        match with_retries(cli.retries, || collect.get_courses(Some(year.clone()))).await {
            Ok(c) => c,
            Err(e) => {
                return fail(
                    cli.json,
                    cli.quiet,
                    "list_courses",
                    &e.to_string(),
                    EXIT_RUNTIME,
                );
            }
        };

    // CODE 完全一致。部分一致はしない（INI20 で複数コースに当たる事故を防ぐ）
    let selected: Vec<&Course> = courses
        .iter()
        .filter(|c| {
            cli.all
                || cli
                    .course
                    .as_deref()
                    .is_some_and(|want| course_matches_code(c, want))
        })
        .collect();

    if selected.is_empty() {
        return fail(
            cli.json,
            cli.quiet,
            "no_match",
            "条件に合うコースがありません",
            EXIT_RUNTIME,
        );
    }
    if !cli.all && selected.len() > 1 {
        return fail(
            cli.json,
            cli.quiet,
            "ambiguous_course",
            &format!(
                "--course に一致するコースが {} 件あります。CODE を完全一致で指定してください",
                selected.len()
            ),
            EXIT_USAGE,
        );
    }

    let mut ok = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;

    for course in selected {
        let code = match course_code(course.key.slug.value()) {
            Ok(c) => c,
            Err(e) => {
                failed += 1;
                emit(
                    cli.json,
                    cli.quiet,
                    json!({
                        "event": "error",
                        "year": year.value(),
                        "course": course.key.slug.value(),
                        "code": "invalid_course_code",
                        "message": e,
                    }),
                    &format!("error course code: {e}"),
                );
                continue;
            }
        };
        let course_name = course.display_name().to_string();

        let lectures: Vec<Lecture> =
            match with_retries(cli.retries, || collect.get_lectures(&course.key)).await {
                Ok(l) => l,
                Err(e) => {
                    failed += 1;
                    emit(
                        cli.json,
                        cli.quiet,
                        json!({
                            "event": "error",
                            "year": year.value(),
                            "course": code,
                            "code": "list_lectures",
                            "message": e.to_string(),
                        }),
                        &format!("error lectures: {e}"),
                    );
                    continue;
                }
            };

        // LL は一覧全体で割り当て、衝突は黙って上書きしない
        let entries: Vec<(String, u32)> = lectures
            .iter()
            .enumerate()
            .map(|(i, l)| (l.key.slug.value().to_string(), (i + 1) as u32))
            .collect();
        let (assignments, collided) = assign_lecture_numbers(&entries);
        for ll in &collided {
            emit(
                cli.json,
                cli.quiet,
                json!({
                    "event": "error",
                    "year": year.value(),
                    "course": code,
                    "code": "lecture_id_collision",
                    "message": format!("LL {ll:02} が衝突したため該当講義をスキップしました"),
                }),
                &format!("error: LL {ll:02} collision"),
            );
        }

        for (idx, lecture) in lectures.iter().enumerate() {
            let lecture_no = match &assignments[idx] {
                Ok(n) => *n,
                Err(_) => {
                    // 衝突・導出失敗は既に event を出している。failed には数えない
                    skipped += 1;
                    continue;
                }
            };

            let show = match &cli.lecture {
                None => true,
                Some(needle) => matches_lecture(lecture, needle, Some(lecture_no)),
            };
            if !show {
                continue;
            }

            emit(
                cli.json,
                cli.quiet,
                json!({
                    "event": "start",
                    "year": year.value(),
                    "course": code,
                    "lecture": lecture_no,
                }),
                &format!("start {}/{}/{:02}", year.value(), code, lecture_no),
            );

            match save_lecture_slides(
                &collect,
                &http,
                year.value(),
                &code,
                lecture_no,
                lecture,
                &course_name,
                path,
                cli.json,
                cli.quiet,
                cli.retries,
            )
            .await
            {
                Ok(Outcome::Saved) => ok += 1,
                Ok(Outcome::Skipped) => skipped += 1,
                Err(e) => {
                    failed += 1;
                    emit(
                        cli.json,
                        cli.quiet,
                        json!({
                            "event": "error",
                            "year": year.value(),
                            "course": code,
                            "lecture": lecture_no,
                            "code": "collect_failed",
                            "message": e.to_string(),
                        }),
                        &format!("error: {e}"),
                    );
                }
            }
        }
    }

    emit(
        cli.json,
        cli.quiet,
        json!({
            "event": "summary",
            "ok": ok,
            "skipped": skipped,
            "failed": failed
        }),
        &format!("summary ok={ok} skipped={skipped} failed={failed}"),
    );

    if failed > 0 {
        ExitCode::from(EXIT_RUNTIME)
    } else {
        ExitCode::SUCCESS
    }
}
