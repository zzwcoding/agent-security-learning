// m7 知识沉淀 worker · 草稿输出 schema 把关（票 17）。
//
// 与 m4 的 parseVerdict 同款纪律：schema 把关在 worker，不在 adapter——真 LLM 回自由
// 文本，只有合契约的 JSON 才能变成草稿；不合就重试 1 次，再不合就 skip（宁可不错提，
// 不可编造/猜）。解析绝不「修」到合法为止。
import { KB_ENTRY_KINDS, type KnowledgeInput } from "./prompt.js";

export interface KbDraft {
  kind: (typeof KB_ENTRY_KINDS)[number];
  title: string;
  body: string;
  tags: string[];
}

export type ParseResult =
  | { ok: true; skip: false; draft: KbDraft }
  | { ok: true; skip: true; reason: string }
  | { ok: false; error: string };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/** 解析 LLM 输出：合契约草稿 / 明确 skip / 坏形（fail-closed）。 */
export function parseDraft(text: unknown): ParseResult {
  let obj: unknown;
  if (typeof text === "string") {
    try {
      obj = JSON.parse(text);
    } catch {
      return { ok: false, error: "bad_draft:not_json" };
    }
  } else {
    obj = text;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, error: "bad_draft:not_object" };
  }
  const o = obj as Record<string, unknown>;
  if (o["skip"] === true) {
    const reason = str(o["reason"]) ?? "(未说明)";
    return { ok: true, skip: true, reason };
  }
  const kind = o["kind"];
  const title = str(o["title"]);
  const body = str(o["body"]);
  const tags = o["tags"];
  if (typeof kind !== "string" || !(KB_ENTRY_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `bad_kind:${String(kind)}` };
  }
  if (!title) return { ok: false, error: "bad_title" };
  if (!body) return { ok: false, error: "bad_body" };
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) {
    return { ok: false, error: "bad_tags" };
  }
  return {
    ok: true,
    skip: false,
    draft: { kind: kind as KbDraft["kind"], title, body, tags: tags as string[] },
  };
}

/** sample 输入（真网冒烟/测试共用）。 */
export function sampleKnowledgeInput(): KnowledgeInput {
  return {
    kase: {
      id: "case_000001",
      title: "[wazuh_alert] - centos7 - 2026-09-08",
      description: "多次失败登录后成功登录",
      severity: 3,
      verdict: "benign_true_positive",
      verdict_note: "授权红队演练（登记号 DX-2026-09）",
      tags: ["group:sshd"],
      host: "centos7",
      timeline: [{ kind: "system", author: "m2", body: "case created" }],
    },
    untrusted: [{ field: "timeline:0", content: "Failed password for root" }],
  };
}
