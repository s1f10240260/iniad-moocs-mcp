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
use collect::{Collect, Credentials, Course, Lecture, LecturePage, SlideContent, Year};
use futures::future;
use reqwest::Client;
use std::future::Future;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

mod contract_ids;
use contract_ids::{course_code, lecture_number, rel_pdf_path};

/// 対話プロンプトを一切出さない非対話収集 CLI
#[derive(Debug, Parser)]
#[command(name = "collect-headless", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    /// 対象年度 (例: 2026)
    #[arg(long, env = "MOOCS_YEAR")]
    year: Option<i32>,

    /// 出力ディレクトリ
    #[arg(long, env = "MOOCS_OUT")]
    path: Option<PathBuf>,

    /// 全講義を非対話で一括取得する
    #[arg(long, conflicts_with = "course")]
    all: bool,

    /// 対象コース（slug / コード / 名前の部分一致。例: INI201）。出力 CODE は slug から導出
    #[arg(long, conflicts_with = "all")]
    course: Option<String>,

    /// 対象レクチャー（slug / 番号 / 名前の部分一致）。出力 LL は slug 先頭数字 or index+1
    #[arg(long)]
    lecture: Option<String>,

    /// 障害時リトライ回数
    #[arg(long, default_value_t = 3)]
    retries: u32,

    /// 進捗を JSON Lines で stdout へ出力する
    #[arg(long)]
    json: bool,

    /// 人間向けログを抑制する
    #[arg(long)]
    quiet: bool,

    /// Moocs / Google のユーザー名（学籍番号）
    #[arg(long, env = "MOOCS_USERNAME")]
    username: Option<String>,

    /// パスワード（CI では Secrets から）
    #[arg(long, env = "MOOCS_PASSWORD")]
    password: Option<String>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// 認証のみ確認する（収集しない）
    AuthCheck,
}

const EXIT_USAGE: u8 = 2;
const EXIT_RUNTIME: u8 = 1;

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

fn matches_course(course: &Course, needle: &str) -> bool {
    let n = needle.to_lowercase();
    course.key.slug.value().to_lowercase().contains(&n)
        || course.name.to_lowercase().contains(&n)
        || course.display_name().to_lowercase().contains(&n)
}

fn matches_lecture(lecture: &Lecture, needle: &str) -> bool {
    // 数字指定は LL と厳密一致（"2" が "第12回" に部分一致しないように）
    if let Ok(n) = needle.trim().parse::<u32>() {
        return lecture_number(lecture.key.slug.value(), lecture.index).ok() == Some(n);
    }
    let n = needle.to_lowercase();
    lecture.key.slug.value().to_lowercase().contains(&n)
        || lecture.display_name().to_lowercase().contains(&n)
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
            Err(e) if attempt < retries => {
                attempt += 1;
                let wait = Duration::from_secs(2u64.pow(attempt));
                eprintln!("retry {attempt}/{retries} after {wait:?}: {e}");
                tokio::time::sleep(wait).await;
            }
            Err(e) => return Err(e),
        }
    }
}

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
) -> Result<PathBuf, anyhow::Error> {
    let pages: Vec<LecturePage> = with_retries(retries, || {
        collect.get_pages(&lecture.key)
    })
    .await?;

    let mut contents: Vec<SlideContent> = Vec::new();
    for page in &pages {
        let slides = with_retries(retries, || collect.get_slides(&page.key)).await?;
        if slides.is_empty() {
            continue;
        }
        let page_contents = future::join_all(slides.iter().map(|slide| collect.get_slide_content(slide)))
            .await
            .into_iter()
            .collect::<Result<Vec<_>, _>>()?;
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
        return Ok(out);
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

    if let Some(dir) = out.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    doc.save(&out)?;

    let pages_count = doc.get_pages().len();
    // 固定契約（DESIGN / PR #4 ingest）:
    //   file は out/ からの相対パス `{year}/{CODE}/{LL:02}/slides.pdf`
    //   course は CODE、lecture は数値
    //   course_name / lecture_title は任意（PR #4 が ingest で取り込む）
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
    Ok(out)
}

fn build_client() -> Result<Client, anyhow::Error> {
    Ok(Client::builder()
        .user_agent("collect-headless/0.1 (INIAD Moocs MCP; +https://github.com/s1f10240260/iniad-moocs-mcp)")
        .cookie_store(true)
        .build()?)
}

async fn login(collect: &Collect, cli: &Cli) -> Result<(), anyhow::Error> {
    let (Some(username), Some(password)) = (cli.username.as_ref(), cli.password.as_ref()) else {
        eprintln!(
            "error: 認証情報がありません。MOOCS_USERNAME / MOOCS_PASSWORD（または --username / --password）を指定してください"
        );
        std::process::exit(i32::from(EXIT_USAGE));
    };

    let credentials = Credentials::new(username, password);
    match with_retries(cli.retries, || collect.authenticate(&credentials)).await {
        Ok(()) => {
            emit(
                cli.json,
                cli.quiet,
                json!({"event": "auth_ok"}),
                "auth: ok",
            );
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

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();

    let client = match build_client() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::from(EXIT_RUNTIME);
        }
    };
    let collect = Collect::from(Arc::new(client));

    // auth-check: 認証のみ（--year / --path 不要）
    if matches!(cli.command, Some(Command::AuthCheck)) {
        return match login(&collect, &cli).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(_) => ExitCode::from(EXIT_RUNTIME),
        };
    }

    let (Some(year_raw), Some(path)) = (cli.year, cli.path.as_ref()) else {
        eprintln!("error: --year と --path は必須です（対話入力は行いません）");
        return ExitCode::from(EXIT_USAGE);
    };

    if !cli.all && cli.course.is_none() {
        eprintln!("error: --all か --course のどちらかを指定してください（対話選択はありません）");
        return ExitCode::from(EXIT_USAGE);
    }

    let year = match Year::new(year_raw as u32) {
        Ok(y) => y,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::from(EXIT_USAGE);
        }
    };

    let client = match build_client() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::from(EXIT_RUNTIME);
        }
    };
    let http = client.clone();
    let collect = Collect::from(Arc::new(client));

    if let Err(_e) = login(&collect, &cli).await {
        return ExitCode::from(EXIT_RUNTIME);
    }

    let courses: Vec<Course> = match with_retries(cli.retries, || collect.get_courses(Some(year.clone()))).await {
        Ok(c) => c,
        Err(e) => {
            emit(
                cli.json,
                cli.quiet,
                json!({"event": "error", "code": "list_courses", "message": e.to_string()}),
                &format!("error: {e}"),
            );
            return ExitCode::from(EXIT_RUNTIME);
        }
    };

    let selected: Vec<&Course> = courses
        .iter()
        .filter(|c| cli.all || cli.course.as_deref().is_some_and(|n| matches_course(c, n)))
        .collect();

    if selected.is_empty() {
        eprintln!("error: 条件に合うコースがありません");
        return ExitCode::from(EXIT_RUNTIME);
    }

    let mut ok = 0usize;
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
                        "message": e.to_string(),
                    }),
                    &format!("error course code: {e}"),
                );
                continue;
            }
        };
        let course_name = course.display_name().to_string();

        let lectures: Vec<Lecture> = match with_retries(cli.retries, || {
            collect.get_lectures(&course.key)
        })
        .await
        {
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

        for lecture in lectures
            .iter()
            .filter(|l| cli.lecture.as_deref().is_none_or(|n| matches_lecture(l, n)))
        {
            let lecture_no = match lecture_number(lecture.key.slug.value(), lecture.index) {
                Ok(n) => n,
                Err(e) => {
                    failed += 1;
                    emit(
                        cli.json,
                        cli.quiet,
                        json!({
                            "event": "error",
                            "year": year.value(),
                            "course": code,
                            "code": "invalid_lecture_number",
                            "message": e.to_string(),
                        }),
                        &format!("error lecture number: {e}"),
                    );
                    continue;
                }
            };

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
                Ok(_) => ok += 1,
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
        json!({"event": "summary", "ok": ok, "failed": failed}),
        &format!("summary ok={ok} failed={failed}"),
    );

    if failed > 0 {
        ExitCode::from(EXIT_RUNTIME)
    } else {
        ExitCode::SUCCESS
    }
}
