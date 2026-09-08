// 票 17 契约测试：草稿 schema、prompt 契约、工具面（INV-3）、FakeKnowledgeLlm 确定性。
import { describe, expect, test } from "vitest";
import { buildKnowledgePrompt, KB_ENTRY_KINDS, KNOWLEDGE_OUTPUT_CONTRACT, KNOWLEDGE_TOOLS } from "./prompt.js";
import { parseDraft, sampleKnowledgeInput } from "./schema.js";
import { FakeKnowledgeLlm } from "./llm.js";
import { hashEmbedding, tokenize } from "./vector-store.js";

// ---------- 验收 1 前置：KBEntry 草稿（kind/title/body/tags）输出 schema ----------

const GOOD = {
  kind: "fp_pattern",
  title: "FP 模式：web-01 定时备份 syscheck 新增",
  body: "## 触发特征\n- /etc/cron.d/db-backup\n\n## 判定依据\n- 变更单 CHG-1042",
  tags: ["web-01", "fp_pattern"],
};

describe("parseDraft（schema 把关在 worker，与 m4 parseVerdict 同款纪律）", () => {
  test("kind 枚举 = PRD §5.10 三值（与 M2 侧 KB_KINDS 契约一致）", () => {
    expect([...KB_ENTRY_KINDS].sort()).toEqual(["env_fact", "fp_pattern", "runbook"]);
  });

  test("合法草稿（JSON 串或对象）都能解析", () => {
    expect(parseDraft(JSON.stringify(GOOD))).toEqual({ ok: true, skip: false, draft: GOOD });
    expect(parseDraft(GOOD)).toEqual({ ok: true, skip: false, draft: GOOD });
    expect(parseDraft(JSON.stringify({ ...GOOD, kind: "runbook" })).ok).toBe(true);
    expect(parseDraft(JSON.stringify({ ...GOOD, kind: "env_fact" })).ok).toBe(true);
  });

  test("LLM 明确 skip（ASP：无可沉淀结论）→ skip + reason", () => {
    const r = parseDraft(JSON.stringify({ skip: true, reason: "verdict=uncertain" }));
    expect(r).toEqual({ ok: true, skip: true, reason: "verdict=uncertain" });
  });

  test.each([
    ["kind 出枚举", { ...GOOD, kind: "poison" }, "bad_kind"],
    ["title 空", { ...GOOD, title: "" }, "bad_title"],
    ["body 缺失", { kind: "runbook", title: "x" }, "bad_body"],
    ["tags 非字符串数组", { ...GOOD, tags: [1] }, "bad_tags"],
  ])("%s → 拒收", (_label, bad, errPrefix) => {
    const r = parseDraft(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(errPrefix);
  });

  test("非 JSON 自由文本 / 数组 → 拒收（fail-closed：宁可 skip 不可猜）", () => {
    expect(parseDraft("好的，我来提炼知识！").ok).toBe(false);
    expect(parseDraft(["fp_pattern"]).ok).toBe(false);
    expect(parseDraft(null).ok).toBe(false);
  });
});

// ---------- prompt 契约与不可信包装（FR-S3.1） ----------

describe("buildKnowledgePrompt（提炼输入的不可信段包装）", () => {
  test("输出契约 + 可信摘要 + wrapUntrusted 包装的 timeline 全部在位", () => {
    const p = buildKnowledgePrompt(sampleKnowledgeInput());
    expect(p).toContain(KNOWLEDGE_OUTPUT_CONTRACT);
    expect(p).toContain('"fp_pattern" | "runbook" | "env_fact"');
    expect(p).toContain("verdict: benign_true_positive");
    expect(p).toContain("verdict_note: 授权红队演练（登记号 DX-2026-09）");
    // timeline 正文（内嵌告警原文）必须进 UNTRUSTED 包装，不能裸进 prompt
    expect(p).toContain('<<<UNTRUSTED field="timeline:0">>>');
    expect(p).toContain("Failed password for root");
    expect(p).toContain("<<<END UNTRUSTED>>>");
  });
});

// ---------- 工具面（INV-3：任务票物理不含 L2；kb_write 是 L2） ----------

describe("KNOWLEDGE_TOOLS（任务票 allowedTools 按它铸）", () => {
  test("沉淀任务票只有读案 + 建提案，kb_write 绝不在票面", () => {
    expect([...KNOWLEDGE_TOOLS].sort()).toEqual(["get_case", "kb_propose"]);
    expect(KNOWLEDGE_TOOLS).not.toContain("kb_write"); // L2：只能走审批卡铸 ApprovalToken
  });
});

// ---------- FakeKnowledgeLlm 确定性（ASP 门控：verdict 是人的结论，提炼只做结构化） ----------

describe("FakeKnowledgeLlm（verdict → KBEntry 草稿的确定性版）", () => {
  const base = sampleKnowledgeInput();

  async function distillFor(verdict: string | null, note = "人工结论") {
    const llm = new FakeKnowledgeLlm();
    const input = { ...base, kase: { ...base.kase, verdict, verdict_note: note } };
    return llm.distill({ prompt: buildKnowledgePrompt(input), input });
  }

  test("false_positive → fp_pattern，title/body/tags 齐全且含检索要点", async () => {
    const r = await distillFor("false_positive", "WAF 拦截的扫描噪声");
    const draft = JSON.parse(r.text) as Record<string, unknown>;
    expect(draft).toMatchObject({ kind: "fp_pattern", tags: expect.arrayContaining(["centos7"]) });
    expect(String(draft.body)).toContain("复核要点");
    expect(String(draft.title)).toContain("FP 模式");
  });

  test("benign_true_positive → env_fact（内网环境事实）", async () => {
    const r = await distillFor("benign_true_positive", "授权红队演练（登记号 DX-2026-09）");
    const draft = JSON.parse(r.text) as Record<string, unknown>;
    expect(draft.kind).toBe("env_fact");
    expect(String(draft.body)).toContain("授权红队演练");
  });

  test("true_positive → runbook（处置经验）", async () => {
    const r = await distillFor("true_positive");
    expect((JSON.parse(r.text) as Record<string, unknown>).kind).toBe("runbook");
  });

  test("uncertain / 无 verdict → skip（ASP 门控：无可沉淀结论不编造）", async () => {
    expect((JSON.parse((await distillFor("uncertain")).text) as Record<string, unknown>).skip).toBe(true);
    expect((JSON.parse((await distillFor(null)).text) as Record<string, unknown>).skip).toBe(true);
  });
});

// ---------- hashEmbedding 确定性（离线 embedding 的根基） ----------

describe("hashEmbedding / tokenize（票内裁决：确定性本地 embedding，出入记票）", () => {
  test("同文本必得同向量；归一化到单位长度", () => {
    const a = hashEmbedding("勒索软件 ransomware 快速关单");
    const b = hashEmbedding("勒索软件 ransomware 快速关单");
    expect(a).toEqual(b);
    const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  test("不同文本向量不同；共同词越多越接近（cosine 单调）", () => {
    const base = hashEmbedding("centos7 暴力破解 授权红队演练");
    const near = hashEmbedding("centos7 暴力破解 完全另一件事");
    const far = hashEmbedding("web-01 sql注入 union select");
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
    expect(dot(base, near)).toBeGreaterThan(dot(base, far));
  });

  test("分词：ascii 词 + CJK 单字（中文按字切，不被空格正则吞掉）", () => {
    expect(tokenize("centos7 暴力破解")).toEqual(["centos7", "暴", "力", "破", "解"]);
  });
});
