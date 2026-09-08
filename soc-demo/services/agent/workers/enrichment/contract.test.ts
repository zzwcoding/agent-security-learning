import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { ENRICHMENT_TOOLS, TOOL_SCHEMAS, validateToolCall } from "./tools.js";
import { ANALYZERS, FixtureAnalyzerTable, tlpPapGate, type AnalyzerCall } from "./analyzers.js";
import { renderReportMarkdown, worstLevel, type EnrichedItem } from "./report.js";

// 票 15 验收的主战场之一：Cortex 契约子集（analyzer 调用/返回契约照 PRD §6-M6）
// + TLP/PAP 闸门的确定性半边（源：m6 卡公开接口/Seam）。契约 = 本目录 tools.ts +
// analyzers.ts，闸在 flow 的工具包装层，行为面见 flow.test.ts。

const TI = fileURLToPath(new URL("../../../../fixtures/ti/", import.meta.url));

describe("工具面与签名契约（PRD 附录 A.1 富化行 / §6-M6 接口契约）", () => {
  test("ENRICHMENT_TOOLS = A.1 富化三件套 + 共用写 add_timeline_entry，无任何 L2", () => {
    expect([...ENRICHMENT_TOOLS]).toEqual([
      "vt_lookup",
      "ip_reputation",
      "add_observable",
      "add_timeline_entry",
    ]);
    for (const t of ENRICHMENT_TOOLS) {
      expect(["isolate_host", "block_ip", "kb_write"]).not.toContain(t); // INV-3
    }
  });

  test("契约自证：vt_lookup/ip_reputation 的 required 就是 Cortex 调用契约四元组", () => {
    for (const t of ["vt_lookup", "ip_reputation"] as const) {
      expect(TOOL_SCHEMAS[t].required).toEqual(["data", "dataType", "tlp", "pap"]);
    }
  });

  test("PRD §6-M6 调用示例原样通过（契约对齐的试金石）", () => {
    // PRD 原文：{"name":"vt_lookup","params":{"data":"44d88612fea8a8f36de82e1278abb02f","dataType":"hash","tlp":2,"pap":2}}
    expect(
      validateToolCall("vt_lookup", { data: "44d88612fea8a8f36de82e1278abb02f", dataType: "hash", tlp: 2, pap: 2 }),
    ).toEqual({ ok: true });
    expect(
      validateToolCall("ip_reputation", { data: "18.18.18.18", dataType: "ip", tlp: 2, pap: 2 }),
    ).toEqual({ ok: true });
  });

  test("未知 dataType → 拒绝（PRD 异常与边界）；越界的 analyzer×类型组合同样拒绝", () => {
    expect(
      validateToolCall("vt_lookup", { data: "1.2.3.4", dataType: "ip", tlp: 2, pap: 2 }).ok,
    ).toBe(false); // ip 不在 vt_lookup 的 dataTypeList 里（那是 ip_reputation 的活）
    expect(
      validateToolCall("ip_reputation", { data: "44d88612", dataType: "hash", tlp: 2, pap: 2 }).ok,
    ).toBe(false);
    expect(
      validateToolCall("vt_lookup", { data: "x", dataType: "bin", tlp: 2, pap: 2 }).ok,
    ).toBe(false);
  });

  test("缺 data / tlp、pap 越界或非整数 → 一律拒绝（闸门吃的是可信数值）", () => {
    const base = { data: "44d88612fea8a8f36de82e1278abb02f", dataType: "hash" };
    expect(validateToolCall("vt_lookup", { ...base, tlp: 2 })).toEqual({ ok: false, error: "pap_required" });
    expect(validateToolCall("vt_lookup", { dataType: "hash", tlp: 2, pap: 2 })).toEqual({
      ok: false,
      error: "data_required",
    });
    expect(validateToolCall("vt_lookup", { ...base, tlp: 5, pap: 2 }).ok).toBe(false); // tlp 上限 4
    expect(validateToolCall("vt_lookup", { ...base, tlp: 2, pap: 4 }).ok).toBe(false); // pap 上限 3（PRD §5.3 PAP 0-3，越界样例取 4；pap=3 过签名、由 max_pap=2 闸门拒——与 tlp=4 同一分层）
    expect(validateToolCall("vt_lookup", { ...base, tlp: 2.5, pap: 2 }).ok).toBe(false);
    expect(validateToolCall("vt_lookup", { ...base, tlp: "2", pap: 2 }).ok).toBe(false);
  });

  test("tlp=4 的调用签名合法——拒它是 TLP 闸门的活，不是签名契约的活（分层）", () => {
    expect(
      validateToolCall("vt_lookup", { data: "44d88612", dataType: "hash", tlp: 4, pap: 2 }).ok,
    ).toBe(true);
  });

  test("add_observable：case_id/dataType/data 必填，dataType 限 §5.3 十类枚举", () => {
    expect(validateToolCall("add_observable", {})).toEqual({ ok: false, error: "case_id_required" });
    expect(validateToolCall("add_observable", { case_id: "case_000001" }).ok).toBe(false);
    expect(
      validateToolCall("add_observable", { case_id: "case_000001", dataType: "hash" }).ok,
    ).toBe(false);
    expect(
      validateToolCall("add_observable", { case_id: "case_000001", dataType: "sha256", data: "ab" }).ok,
    ).toBe(false); // 十类之外
    expect(
      validateToolCall("add_observable", {
        case_id: "case_000001",
        dataType: "uri_path",
        data: "/admin/login",
        tags: ["from:analyzer"],
      }),
    ).toEqual({ ok: true });
    expect(
      validateToolCall("add_observable", {
        case_id: "case_000001",
        dataType: "hash",
        data: "ab",
        tags: "not-an-array",
      }).ok,
    ).toBe(false);
  });

  test("add_timeline_entry：kind 限 §5.5 枚举（富化报告的落库通道）", () => {
    expect(
      validateToolCall("add_timeline_entry", { case_id: "case_000001", kind: "enrichment_report", body: "报告" }),
    ).toEqual({ ok: true });
    expect(
      validateToolCall("add_timeline_entry", { case_id: "case_000001", kind: "freeform", body: "x" }).ok,
    ).toBe(false);
    expect(validateToolCall("merge_alert", { alert_id: "a", case_id: "c" })).toEqual({
      ok: false,
      error: "unknown_tool",
    });
  });
});

describe("analyzer 描述符与 TLP/PAP 闸门（m6 卡 Seam：确定性中间件，不靠 prompt）", () => {
  test("A.1 一字不差：vt_lookup / ip_reputation 都是 max_tlp=2 / max_pap=2", () => {
    expect(ANALYZERS.vt_lookup).toMatchObject({ max_tlp: 2, max_pap: 2 });
    expect(ANALYZERS.ip_reputation).toMatchObject({ max_tlp: 2, max_pap: 2 });
    expect(ANALYZERS.vt_lookup.dataTypes).toContain("hash");
    expect(ANALYZERS.ip_reputation.dataTypes).toEqual(["ip"]);
  });

  test("PRD §6-M6 TLP 拒绝样例：tlp=4 撞 max_tlp=2 → 逐字同款 errorMessage", () => {
    const call: AnalyzerCall = { data: "44d88612", dataType: "hash", tlp: 4, pap: 2 };
    expect(tlpPapGate(call, ANALYZERS.vt_lookup)).toEqual({
      ok: false,
      errorMessage: "tlp_exceeded: observable tlp=4 > max_tlp=2",
    });
  });

  test("边界不冤枉：tlp=2/pap=2 放行；pap=3 撤 max_pap=2 → pap_exceeded", () => {
    expect(tlpPapGate({ data: "x", dataType: "ip", tlp: 2, pap: 2 }, ANALYZERS.ip_reputation)).toEqual({ ok: true });
    expect(tlpPapGate({ data: "x", dataType: "ip", tlp: 1, pap: 3 }, ANALYZERS.ip_reputation)).toEqual({
      ok: false,
      errorMessage: "pap_exceeded: observable pap=3 > max_pap=2",
    });
  });
});

describe("FixtureAnalyzerTable（m6 卡 Seam：fixture 表 mock analyzer，FR-M6.1）", () => {
  const ti = new FixtureAnalyzerTable(TI);

  test("enrich/01 的 hash：命中 VT 情报 → malicious taxonomy + full + artifacts", async () => {
    const r = await ti.lookup("vt_lookup", {
      data: "c05640e21ec2b1b4b4101c1a67a1a3c8af7c7ae9b6b98f8b1b1f0e9a2d3c4b5a",
      dataType: "hash",
      tlp: 2,
      pap: 2,
    });
    expect(r.success).toBe(true);
    expect(r.summary?.taxonomies).toEqual([
      { namespace: "VT", predicate: "reputation", value: "5/70", level: "malicious" },
    ]);
    expect(r.full).toMatchObject({ positives: 5, total: 70 });
    expect(r.artifacts).toEqual([{ dataType: "filename", data: "invoice_apr.zip" }]);
  });

  test("未命中 → no-record 而非错误（PRD：对齐 VT 无记录语义，原文逐字）", async () => {
    const r = await ti.lookup("ip_reputation", { data: "203.0.113.99", dataType: "ip", tlp: 2, pap: 2 });
    expect(r).toEqual({
      success: true,
      summary: { taxonomies: [{ level: "info", predicate: "no-record" }] },
    });
  });
});

describe("taxonomy 四档渲染（FR-M6.4：info/safe/suspicious/malicious 进富化报告）", () => {
  test("worstLevel 取最严重档：malicious > suspicious > safe > info", () => {
    expect(worstLevel([{ level: "info" }, { level: "malicious" }])).toBe("malicious");
    expect(worstLevel([{ level: "safe" }, { level: "suspicious" }])).toBe("suspicious");
    expect(worstLevel([{ level: "info" }])).toBe("info");
    expect(worstLevel([])).toBeUndefined();
  });

  test("四档 + 拒绝项 + 回写清单都渲染进 markdown，标记可 grep", () => {
    const results: EnrichedItem[] = [
      {
        analyzer: "vt_lookup", data: "c05640e2", dataType: "hash", tlp: 2, pap: 2, ok: true,
        level: "malicious",
        taxonomies: [{ namespace: "VT", predicate: "reputation", value: "5/70", level: "malicious" }],
      },
      {
        analyzer: "ip_reputation", data: "203.0.113.66", dataType: "ip", tlp: 4, pap: 2, ok: false,
        refused: "tlp_exceeded: observable tlp=4 > max_tlp=2",
      },
      {
        analyzer: "ip_reputation", data: "198.51.100.23", dataType: "ip", tlp: 2, pap: 2, ok: true,
        level: "suspicious",
        taxonomies: [{ namespace: "IPR", predicate: "reputation", value: "suspicious", level: "suspicious" }],
        flagged: true,
      },
    ];
    const md = renderReportMarkdown({
      case_id: "case_000001",
      title: "[wazuh_alert] - web-01 - 2023-04-25",
      summary: "查了 3 个 observable：malicious 1、suspicious 1；TLP 拒绝 1 项。",
      results,
      artifacts_written: [{ dataType: "filename", data: "invoice_apr.zip", dedup: false }],
      refused_count: 1,
      skipped_internal: 2,
    });
    expect(md).toContain("[malicious]");
    expect(md).toContain("[suspicious]");
    expect(md).toContain("[refused]");
    expect(md).toContain("tlp_exceeded: observable tlp=4 > max_tlp=2");
    expect(md).toContain("invoice_apr.zip");
    expect(md).toContain("guards"); // flag 标记可见（不吞内容，标记待人工复核）
    expect(md).toContain("malicious / suspicious / safe / info"); // 四档图例
  });
});
