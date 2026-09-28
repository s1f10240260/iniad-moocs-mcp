import { describe, expect, it } from "vitest";

import { addJsonl, emptyManifest } from "../../ingest/manifest.js";

const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");

describe("addJsonl", () => {
  it("done イベントから course / lecture / content を作る", () => {
    const m = emptyManifest();
    addJsonl(
      m,
      "slides",
      jsonl(
        { event: "start", year: 2026, course: "INI201", lecture: 2 },
        {
          event: "done",
          year: 2026,
          course: "INI201",
          lecture: 2,
          file: "2026/INI201/02/slides.pdf",
          course_name: "データサイエンス基礎",
          lecture_title: "第2回",
        },
      ),
    );

    expect([...m.courses.values()]).toEqual([
      { id: "2026/INI201", year: 2026, code: "INI201", name: "データサイエンス基礎" },
    ]);
    expect([...m.lectures.values()]).toEqual([
      { id: "2026/INI201/02", courseId: "2026/INI201", number: 2, title: "第2回" },
    ]);
    expect([...m.contents.keys()]).toEqual(["2026/INI201/02/slide"]);
    expect(m.rejected).toEqual([]);
  });

  it("contents 側のイベントで講義名が無くても、スライド側の名前を消さない", () => {
    const m = emptyManifest();
    addJsonl(
      m,
      "slides",
      jsonl({
        event: "done",
        year: 2026,
        course: "INI201",
        lecture: 2,
        file: "2026/INI201/02/slides.pdf",
        course_name: "データサイエンス基礎",
        lecture_title: "第2回",
      }),
    );
    addJsonl(
      m,
      "contents",
      jsonl({ event: "done", year: 2026, course: "INI201", lecture: 2, type: "quiz", file: "2026/INI201/02/quiz.html" }),
    );

    expect(m.courses.get("2026/INI201")?.name).toBe("データサイエンス基礎");
    expect(m.lectures.get("2026/INI201/02")?.title).toBe("第2回");
    expect(m.contents.get("2026/INI201/02/quiz")?.type).toBe("quiz");
  });

  it("同じ content の done が再度来ても、title が無ければ前の title を残す", () => {
    const m = emptyManifest();
    const ev = { event: "done", year: 2026, course: "INI201", lecture: 2, type: "quiz", file: "2026/INI201/02/quiz.html" };
    addJsonl(m, "contents", jsonl({ ...ev, title: "第2回 ミニクイズ" }, ev));
    expect(m.contents.get("2026/INI201/02/quiz")?.title).toBe("第2回 ミニクイズ");
  });

  it("error イベントは件数だけ数え、データは作らない", () => {
    const m = emptyManifest();
    addJsonl(m, "slides", jsonl({ event: "error", year: 2026, course: "INI201", lecture: 3, code: "auth_expired" }));
    expect(m.collectorErrors).toBe(1);
    expect(m.lectures.size).toBe(0);
  });

  it.each([
    ["パストラバーサル", { file: "../../etc/passwd" }],
    ["ゼロ埋めしていないパス", { file: "2026/INI201/2/slides.pdf" }],
    ["不正なコースコード", { course: "INI 201", file: "2026/INI 201/02/slides.pdf" }],
    ["不正な type", { type: "video", file: "2026/INI201/02/video.html" }],
    ["レクチャー番号 0", { lecture: 0, file: "2026/INI201/00/slides.pdf" }],
    ["年度が文字列", { year: "2026" }],
  ])("%s は rejected に入る", (_, override) => {
    const m = emptyManifest();
    const ev = { event: "done", year: 2026, course: "INI201", lecture: 2, file: "2026/INI201/02/slides.pdf", ...override };
    addJsonl(m, "slides", jsonl(ev));
    expect(m.rejected).toHaveLength(1);
    expect(m.contents.size).toBe(0);
  });

  it("壊れた行は行番号付きで rejected に入り、他の行は処理を続ける", () => {
    const m = emptyManifest();
    addJsonl(
      m,
      "slides.jsonl",
      ["{not json", "", JSON.stringify({ event: "done", year: 2026, course: "INI201", lecture: 1, file: "2026/INI201/01/slides.pdf" })].join(
        "\r\n",
      ),
    );
    expect(m.rejected).toEqual([{ source: "slides.jsonl", line: 1, reason: "invalid JSON" }]);
    expect(m.contents.size).toBe(1);
  });
});
