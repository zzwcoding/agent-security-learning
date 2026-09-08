import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { INVESTIGATION_TOOLS, TOOL_SCHEMAS, validateToolCall } from "./prompt.js";
import { parseReport } from "./schema.js";
import { FixtureSiem } from "./siem.js";

// 票 14 验收 1 的主战场：siem_query 强制 time_window 等工具签名契约
// （源：m5 卡公开接口·PRD §6-M5）。契约 = 本目录 prompt.ts，闸在 flow 的循环里。

const FIXTURES = fileURLToPath(new URL("../../../../fixtures/alerts/", import.meta.url));

describe("工具面与签名契约（PRD §6-M5 / 附录 A.1）", () => {
  test("INVESTIGATION_TOOLS = §6-M5 五件套 + A.1 共用读 get_alert，无任何 L2", () => {
    expect([...INVESTIGATION_TOOLS]).toEqual([
      "get_alert",
      "siem_query",
      "related_alerts",
      "kb_verify",
      "add_timeline_entry",
      "add_task_log",
    ]);
    for (const t of INVESTIGATION_TOOLS) {
      expect(["isolate_host", "block_ip", "kb_write"]).not.toContain(t); // INV-3
    }
  });

  test("契约自证：siem_query 的 required 里就有 time_window（无默认值）", () => {
    expect(TOOL_SCHEMAS.siem_query.required).toContain("time_window");
    expect(TOOL_SCHEMAS.related_alerts.required).toContain("time_window"); // FR-M5.5 查询强制过滤窗口
  });

  test("siem_query：缺 time_window / 窗口残缺 / entity_type 非法 / entity 空 → 一律拒绝", () => {
    const base = { entity_type: "ip", entity: "18.18.18.18" };
    expect(validateToolCall("siem_query", { ...base })).toEqual({
      ok: false,
      error: "time_window_required",
    });
    expect(validateToolCall("siem_query", { ...base, time_window: { from: "2023-04-25T00:00:00Z" } })).toEqual({
      ok: false,
      error: "bad_time_window.to",
    });
    expect(
      validateToolCall("siem_query", { ...base, time_window: { from: "nope", to: "2023-04-25T00:00:00Z" } }).ok,
    ).toBe(false);
    expect(
      validateToolCall("siem_query", {
        entity_type: "domain",
        entity: "evil.com",
        time_window: { from: "2023-04-25T00:00:00Z", to: "2023-04-26T00:00:00Z" },
      }),
    ).toEqual({ ok: false, error: "bad_entity_type" });
    expect(
      validateToolCall("siem_query", {
        entity_type: "ip",
        entity: "",
        time_window: { from: "2023-04-25T00:00:00Z", to: "2023-04-26T00:00:00Z" },
      }).ok,
    ).toBe(false);
    expect(
      validateToolCall("siem_query", {
        entity_type: "ip",
        entity: "18.18.18.18",
        time_window: { from: "2023-04-25T00:00:00Z", to: "2023-04-26T00:00:00Z" },
        max_results: 0,
      }).ok,
    ).toBe(false);
  });

  test("siem_query 合法调用放行；related_alerts 同样强制 time_window", () => {
    const w = { from: "2023-04-25T00:00:00Z", to: "2023-04-26T00:00:00Z" };
    expect(validateToolCall("siem_query", { entity_type: "ip", entity: "18.18.18.18", time_window: w })).toEqual({
      ok: true,
    });
    expect(validateToolCall("related_alerts", { scope: "host", value: "centos7" })).toEqual({
      ok: false,
      error: "time_window_required",
    });
    expect(validateToolCall("related_alerts", { scope: "port", value: "22", time_window: w }).ok).toBe(false);
    expect(validateToolCall("related_alerts", { scope: "host", value: "centos7", time_window: w })).toEqual({
      ok: true,
    });
  });

  test("kb_verify / add_timeline_entry / add_task_log / get_alert / 未知工具", () => {
    expect(validateToolCall("kb_verify", {})).toEqual({ ok: false, error: "kb_verify_requires_entity" });
    expect(validateToolCall("kb_verify", { host: "centos7" })).toEqual({ ok: true });
    expect(validateToolCall("add_timeline_entry", { case_id: "case_000001" }).ok).toBe(false);
    expect(
      validateToolCall("add_timeline_entry", { case_id: "case_000001", kind: "isolate_everything", body: "x" }).ok,
    ).toBe(false);
    expect(
      validateToolCall("add_timeline_entry", {
        case_id: "case_000001",
        kind: "investigation_report",
        body: "报告",
      }),
    ).toEqual({ ok: true });
    expect(validateToolCall("add_task_log", { case_id: "case_000001", task_id: "t1" }).ok).toBe(false);
    expect(validateToolCall("get_alert", {}).ok).toBe(false);
    expect(validateToolCall("get_alert", { alert_id: "al_1" })).toEqual({ ok: true });
    expect(validateToolCall("isolate_host", { host: "centos7" })).toEqual({ ok: false, error: "unknown_tool" });
  });
});

describe("调查报告 schema（PRD §6-M5 输出契约，FR-M5.4）", () => {
  // PRD §6-M5 的示例 JSON 原样：能原封不动过闸才算契约对齐
  const PRD_EXAMPLE = {
    summary: "ssh 暴力破解成功，18.18.18.18 对 centos7 的关联探测",
    severity_assessment: 3,
    confidence: 0.8,
    findings: [{ entity: "18.18.18.18", evidence: "Invalid user blimey from 18.18.18.18", source_tool: "siem_query" }],
    affected_assets: ["centos7"],
    recommended_actions: [{ tool: "isolate_host", params: { host: "centos7" }, justification: "持续爆破" }],
    kb_refs: ["kb_01J..."],
  };

  test("PRD 示例 JSON 原样通过", () => {
    const r = parseReport(JSON.stringify(PRD_EXAMPLE));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.report.findings).toHaveLength(1);
  });

  test("缺字段 / 越界值 / 形状不对逐一把关（fail-closed 的 schema 版）", () => {
    expect(parseReport("{}").ok).toBe(false);
    expect(parseReport({ ...PRD_EXAMPLE, summary: "" }).ok).toBe(false);
    expect(parseReport({ ...PRD_EXAMPLE, severity_assessment: 5 }).ok).toBe(false);
    expect(parseReport({ ...PRD_EXAMPLE, confidence: 1.5 }).ok).toBe(false);
    expect(parseReport({ ...PRD_EXAMPLE, findings: [{ entity: "x", evidence: "y" }] }).ok).toBe(false);
    expect(
      parseReport({ ...PRD_EXAMPLE, recommended_actions: [{ tool: "isolate_host", justification: "x" }] }).ok,
    ).toBe(false);
    expect(parseReport({ ...PRD_EXAMPLE, kb_refs: "kb_01J" }).ok).toBe(false);
    const partial = parseReport(JSON.stringify({ ...PRD_EXAMPLE, incomplete: true }));
    expect(partial.ok).toBe(true); // max_steps 截断的部分报告带 incomplete 标记
    if (partial.ok) expect(partial.report.incomplete).toBe(true);
  });
});

describe("FixtureSiem（m5 卡 Seam：fixture 告警集检索 adapter，FR-M5.1）", () => {
  const siem = new FixtureSiem(FIXTURES);
  const DAY = { from: "2023-04-25T00:00:00.000Z", to: "2023-04-26T00:00:00.000Z" };

  test("ip pivot + 时间窗：命中 5712 的爆破日志，命中全部落在窗口内", async () => {
    const r = await siem.query({ entity_type: "ip", entity: "18.18.18.18", time_window: DAY });
    expect(r.total).toBeGreaterThanOrEqual(1);
    expect(r.hits.some((h) => h.full_log.includes("Invalid user blimey"))).toBe(true);
    for (const h of r.hits) {
      const t = Date.parse(h.timestamp);
      expect(t).toBeGreaterThanOrEqual(Date.parse(DAY.from));
      expect(t).toBeLessThanOrEqual(Date.parse(DAY.to));
    }
  });

  test("窗口外 0 命中（强制 time_window 的意义）；host pivot 命中 centos7", async () => {
    const none = await siem.query({
      entity_type: "ip",
      entity: "18.18.18.18",
      time_window: { from: "2020-01-01T00:00:00.000Z", to: "2020-01-02T00:00:00.000Z" },
    });
    expect(none).toEqual({ total: 0, hits: [] });
    const host = await siem.query({ entity_type: "host", entity: "web-01", time_window: DAY });
    expect(host.total).toBeGreaterThanOrEqual(3);
  });

  test("max_results 截断 hits 不改 total（PRD 返回形状：total + truncated 由上层治理）", async () => {
    const r = await siem.query({ entity_type: "host", entity: "web-01", time_window: DAY, max_results: 2 });
    expect(r.hits).toHaveLength(2);
    expect(r.total).toBeGreaterThan(2);
  });
});
