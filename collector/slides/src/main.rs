//! collect-headless — 非対話スライド収集ラッパー
//!
//! 公式 `collect-cli` は `--path` / `--year` のみで実行後に対話選択するため
//! CI では使えない。本バイナリは `collect` crate を直接叩き、
//! フラグ指定だけで一括収集する。
//!
//! 詳細: ../../DESIGN.md 「データ収集ラッパー設計」

use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;

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

    /// コースコード (例: INI201)
    #[arg(long, conflicts_with = "all")]
    course: Option<String>,

    /// レクチャー番号。省略時は該当コース全件
    #[arg(long)]
    lecture: Option<u32>,

    /// 障害時リトライ回数
    #[arg(long, default_value_t = 3)]
    retries: u32,

    /// 進捗を JSON Lines で stdout へ出力する
    #[arg(long)]
    json: bool,

    /// 人間向けログを抑制する
    #[arg(long)]
    quiet: bool,

    /// Netscape / JSON Cookie ジャー
    #[arg(long, env = "MOOCS_COOKIE_JAR")]
    cookie_jar: Option<PathBuf>,

    /// セッション Cookie 文字列 (CI 向け)
    #[arg(long, env = "MOOCS_SESSION_COOKIE")]
    session_cookie: Option<String>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// ローカル用: ブラウザでログインして Cookie を保存する
    Login {
        /// Cookie 保存先
        #[arg(long)]
        out: PathBuf,
    },
}

/// 対話入力を要求される呼び出しは exit code 2 で失敗させる
const EXIT_USAGE: u8 = 2;
const EXIT_RUNTIME: u8 = 1;

fn main() -> ExitCode {
    let cli = Cli::parse();

    if let Some(Command::Login { out }) = &cli.command {
        eprintln!("login は未実装です（Phase 1）。保存先: {}", out.display());
        return ExitCode::from(EXIT_RUNTIME);
    }

    // 対話プロンプトの代わりに、必須パラメータ不足は即エラーにする
    let (Some(year), Some(path)) = (cli.year, cli.path.as_ref()) else {
        eprintln!("error: --year と --path は必須です（対話入力は行いません）");
        return ExitCode::from(EXIT_USAGE);
    };

    if !cli.all && cli.course.is_none() {
        eprintln!("error: --all か --course のどちらかを指定してください（対話選択はありません）");
        return ExitCode::from(EXIT_USAGE);
    }

    if cli.session_cookie.is_none() && cli.cookie_jar.is_none() {
        eprintln!(
            "error: 認証情報がありません。MOOCS_SESSION_COOKIE か --cookie-jar を指定してください"
        );
        return ExitCode::from(EXIT_USAGE);
    }

    // TODO(phase-1): collect crate で非対話収集を実行する
    // 現状は CLI 契約（フラグ / exit code / JSON 進捗）の骨格のみ
    let plan = format!(
        "collect year={year} path={} all={} course={:?} lecture={:?} retries={}",
        path.display(),
        cli.all,
        cli.course,
        cli.lecture,
        cli.retries
    );

    if cli.json {
        println!(
            "{}",
            serde_json::json!({
                "event": "planned",
                "year": year,
                "path": path,
                "all": cli.all,
                "course": cli.course,
                "lecture": cli.lecture,
                "note": "implementation pending — see docs/ROADMAP.md Phase 1",
            })
        );
    } else if !cli.quiet {
        eprintln!("{plan}");
        eprintln!("collect-headless: 実装は Phase 1（docs/ROADMAP.md）");
    }

    ExitCode::SUCCESS
}
