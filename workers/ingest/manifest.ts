/**
 * Collector の JSON Lines（collect-*.jsonl）を読み、D1 / R2 に反映すべき内容へまとめる。
 *
 * 入力の契約は docs/WORK_SPLIT.md 「共有インターフェース」と
 * docs/INGEST.md を参照。`done` 以外のイベントは集計のみで反映しない
 * （失敗したレクチャーは前回までのデータを残す = 3 回リトライ → スキップ）。
 */

export type ContentType = "quiz" | "assignment" | "slide";

export interface CourseEntry {
  id: string; // "2026/INI201"
  year: number;
  code: string;
  /** Collector が名前を出さなかった場合は undefined（既存値を上書きしない） */
  name?: string;
}

export interface LectureEntry {
  id: string; // "2026/INI201/02"
  courseId: string;
  number: number;
  title?: string;
}

export interface ContentEntry {
  id: string; // "2026/INI201/02/quiz"
  lectureId: string;
  type: ContentType;
  /** out/ からの相対パス。R2 キーにも使う（slide のみ） */
  file: string;
  title?: string;
}

export interface Manifest {
  courses: Map<string, CourseEntry>;
  lectures: Map<string, LectureEntry>;
  contents: Map<string, ContentEntry>;
  /** Collector が `error` を出した件数 */
  collectorErrors: number;
  /** 契約に合わず読み飛ばした行 */
  rejected: RejectedLine[];
}

export interface RejectedLine {
  source: string;
  line: number;
  reason: string;
}

const COURSE_CODE = /^[A-Za-z0-9_-]{1,32}$/;
const CONTENT_TYPES: ReadonlySet<string> = new Set(["quiz", "assignment", "slide"]);

export function emptyManifest(): Manifest {
  return {
    courses: new Map(),
    lectures: new Map(),
    contents: new Map(),
    collectorErrors: 0,
    rejected: [],
  };
}

export function lectureDir(year: number, code: string, lecture: number): string {
  return `${year}/${code}/${String(lecture).padStart(2, "0")}`;
}

/** 契約どおりのファイルパス。これ以外の `file` は受け付けない（パストラバーサル対策も兼ねる） */
export function expectedFile(year: number, code: string, lecture: number, type: ContentType): string {
  const dir = lectureDir(year, code, lecture);
  return type === "slide" ? `${dir}/slides.pdf` : `${dir}/${type}.html`;
}

/**
 * JSON Lines テキストを manifest に積む。同じキーの `done` は後勝ち。
 * `type` を持たない `done` は collect-headless のスライドイベントとみなす。
 */
export function addJsonl(manifest: Manifest, source: string, text: string): void {
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === "") return;
    const reject = (reason: string) => manifest.rejected.push({ source, line: i + 1, reason });

    let ev: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return reject("not a JSON object");
      }
      ev = parsed as Record<string, unknown>;
    } catch {
      return reject("invalid JSON");
    }

    if (ev.event === "error") {
      manifest.collectorErrors += 1;
      return;
    }
    if (ev.event !== "done") return;

    const { year, course, lecture } = ev;
    if (!Number.isInteger(year) || (year as number) < 2000 || (year as number) > 2100) {
      return reject("year must be an integer");
    }
    if (typeof course !== "string" || !COURSE_CODE.test(course)) {
      return reject("course must match [A-Za-z0-9_-]{1,32}");
    }
    if (!Number.isInteger(lecture) || (lecture as number) < 1 || (lecture as number) > 999) {
      return reject("lecture must be an integer between 1 and 999");
    }

    const type = ev.type === undefined ? "slide" : ev.type;
    if (typeof type !== "string" || !CONTENT_TYPES.has(type)) {
      return reject(`unknown content type: ${String(ev.type)}`);
    }
    const contentType = type as ContentType;

    const y = year as number;
    const n = lecture as number;
    const file = expectedFile(y, course, n, contentType);
    if (ev.file !== file) {
      return reject(`file must be "${file}"`);
    }

    const courseId = `${y}/${course}`;
    const lectureId = lectureDir(y, course, n);

    const prevCourse = manifest.courses.get(courseId);
    manifest.courses.set(courseId, {
      id: courseId,
      year: y,
      code: course,
      name: optionalText(ev.course_name) ?? prevCourse?.name,
    });

    const prevLecture = manifest.lectures.get(lectureId);
    manifest.lectures.set(lectureId, {
      id: lectureId,
      courseId,
      number: n,
      title: optionalText(ev.lecture_title) ?? prevLecture?.title,
    });

    const contentId = `${lectureId}/${contentType}`;
    manifest.contents.set(contentId, {
      id: contentId,
      lectureId,
      type: contentType,
      file,
      title: optionalText(ev.title) ?? manifest.contents.get(contentId)?.title,
    });
  });
}

function optionalText(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}
