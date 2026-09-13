import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { HUNT_QUERY_TOOLS, HUNT_TOOL_SCHEMAS, executeHuntTool, validateHuntToolCall } from "./hunt.js";
import { INVESTIGATION_TOOLS } from "./prompt.js";
import { FixtureSiem, type FileChangeQueryParams, type HuntQueryBackend, type HuntResult, type OutboundConnQueryParams, type ProcLineageQueryParams, type WebAccessQueryParams } from "./siem.js";
import { resetToolsManifestCache, tierOf } from "../../src/tools-manifest.js";
import { verifyTicket } from "../../src/verify-ticket.js";

// 票 78 验收的主战场：狩猎查询工具 ×4 的签名契约 + FixtureSiem 四维度索引 + 登记闸。
// 口径与 siem_query（contract.test.ts）同款：查询强制 time_window（缺窗报错不替 LLM 补）、
// 数据源 = fixtures/alerts 语料（每维度含注入变体——攻击者可控字段埋点惯例照旧）、
// 登记单一来源 = fixtures/tools.manifest.json（未登记一律 L1 的 fail-closed）。

const FIXTURES = fileURLToPath(new URL("../../../../fixtures/alerts/", import.meta.url));
const DAY = { from: "2023-04-25T00:00:00.000Z", to: "2023-04-26T00:00:00.000Z" };
const YEAR_2020 = { from: "2020-01-01T00:00:00.000Z", to: "2020-01-02T00:00:00.000Z" };
const NOW = 1757000100; // 冻结时钟（tools-manifest.test 同款 fixture 时刻）
const KEY = (JSON.parse(
  readFileSync(new URL("../../../../fixtures/tickets/contract.json", import.meta.url), "utf8"),
) as { hmac_key: { value: string } }).hmac_key.value;
const OPTS = { hmacKey: KEY };

describe("狩猎工具面与签名契约（票 78 / PRD §13.4b）", () => {
  test("HUNT_QUERY_TOOLS = 四维度工具，与调查六工具零交集，无任何 L2（INV-3）", () => {
    expect([...HUNT_QUERY_TOOLS]).toEqual([
      "file_change_query",
      "outbound_conn_query",
      "web_access_query",
      "proc_lineage_query",
    ]);
    for (const t of HUNT_QUERY_TOOLS) {
      expect(INVESTIGATION_TOOLS).not.toContain(t); // 调查六工具面零变化（旧链零回归）
      expect(["isolate_host", "block_ip", "kb_write"]).not.toContain(t);
    }
  });

  test("契约自证：四个工具的 required 里都有 time_window（无默认值，FR-M5.5 同款）", () => {
    for (const t of HUNT_QUERY_TOOLS) {
      expect(HUNT_TOOL_SCHEMAS[t]!.required).toContain("time_window");
    }
  });

  test("四工具缺 time_window 一律报 time_window_required（缺窗报错，不替 LLM 补）", () => {
    expect(validateHuntToolCall("file_change_query", { field: "path", value: "/var/www" })).toEqual({
      ok: false,
      error: "time_window_required",
    });
    expect(validateHuntToolCall("outbound_conn_query", { field: "dst_ip", value: "198.51.100.66" })).toEqual({
      ok: false,
      error: "time_window_required",
    });
    expect(validateHuntToolCall("web_access_query", { url_pattern: "/uploads" })).toEqual({
      ok: false,
      error: "time_window_required",
    });
    expect(validateHuntToolCall("proc_lineage_query", { process: "sh" })).toEqual({
      ok: false,
      error: "time_window_required",
    });
  });

  test("窗口残缺/乱序同样拒绝（与 siem_query 同一口径）", () => {
    expect(
      validateHuntToolCall("web_access_query", { url_pattern: "/x", time_window: { from: "2023-04-25T00:00:00Z" } }),
    ).toEqual({ ok: false, error: "bad_time_window.to" });
    expect(
      validateHuntToolCall("web_access_query", { url_pattern: "/x", time_window: { from: "nope", to: DAY.to } }).ok,
    ).toBe(false);
    expect(
      validateHuntToolCall("web_access_query", { url_pattern: "/x", time_window: { from: DAY.to, to: DAY.from } }),
    ).toEqual({ ok: false, error: "bad_time_window.order" });
  });

  test("各工具坏参数逐一把关（fail-closed 的签名版）", () => {
    const w = DAY;
    // file_change_query：field 非法 / value 空 / max_results 非法
    expect(validateHuntToolCall("file_change_query", { field: "owner", value: "/x", time_window: w })).toEqual({
      ok: false,
      error: "bad_field",
    });
    expect(validateHuntToolCall("file_change_query", { field: "path", value: "", time_window: w }).ok).toBe(false);
    expect(
      validateHuntToolCall("file_change_query", { field: "path", value: "/x", time_window: w, max_results: 0 }).ok,
    ).toBe(false);
    // outbound_conn_query：field 非法 / freq 非正整数
    expect(validateHuntToolCall("outbound_conn_query", { field: "src_ip", value: "1.1.1.1", time_window: w })).toEqual({
      ok: false,
      error: "bad_field",
    });
    expect(validateHuntToolCall("outbound_conn_query", { field: "freq", value: "0", time_window: w })).toEqual({
      ok: false,
      error: "bad_freq_value",
    });
    expect(validateHuntToolCall("outbound_conn_query", { field: "freq", value: "many", time_window: w })).toEqual({
      ok: false,
      error: "bad_freq_value",
    });
    // web_access_query：pattern 空
    expect(validateHuntToolCall("web_access_query", { url_pattern: "", time_window: w })).toEqual({
      ok: false,
      error: "pattern_required",
    });
    // proc_lineage_query：process 空 / role 非法
    expect(validateHuntToolCall("proc_lineage_query", { process: "", time_window: w })).toEqual({
      ok: false,
      error: "process_required",
    });
    expect(
      validateHuntToolCall("proc_lineage_query", { process: "sh", role: "sibling", time_window: w }),
    ).toEqual({ ok: false, error: "bad_role" });
  });

  test("合法调用放行；面外工具（含旧 siem_query）一律 unknown_tool（面隔离）", () => {
    const w = DAY;
    expect(validateHuntToolCall("file_change_query", { field: "hash", value: "cafe", time_window: w })).toEqual({
      ok: true,
    });
    expect(validateHuntToolCall("outbound_conn_query", { field: "domain", value: "evil.example", time_window: w })).toEqual({
      ok: true,
    });
    expect(validateHuntToolCall("web_access_query", { url_pattern: "/uploads", time_window: w })).toEqual({ ok: true });
    expect(validateHuntToolCall("proc_lineage_query", { process: "sh", role: "parent", time_window: w })).toEqual({
      ok: true,
    });
    expect(validateHuntToolCall("proc_lineage_query", { process: "sh", time_window: w })).toEqual({ ok: true }); // role 缺省 = any
    expect(
      validateHuntToolCall("siem_query", { entity_type: "ip", entity: "1.1.1.1", time_window: w }),
    ).toEqual({ ok: false, error: "unknown_tool" });
    expect(validateHuntToolCall("no_such_tool", {})).toEqual({ ok: false, error: "unknown_tool" });
  });
});

describe("FixtureSiem 四维度索引（m5 卡 Seam：同一 adapter 同一语料，票 78）", () => {
  const siem: HuntQueryBackend = new FixtureSiem(FIXTURES);

  test("file_change_query：按路径命中 webshell 落盘（含注入变体 probe.php），全部落窗口内", async () => {
    const r = await siem.queryFileChanges({ field: "path", value: "/var/www/html/uploads", time_window: DAY });
    expect(r.total).toBe(2);
    const paths = r.hits.map((h) => h.file.path);
    expect(paths.some((p) => p.endsWith("sh.php"))).toBe(true);
    expect(paths.some((p) => p.endsWith("probe.php"))).toBe(true); // inject-webshell（攻击者可控字段埋点）
    for (const h of r.hits) {
      expect(Date.parse(h.timestamp)).toBeGreaterThanOrEqual(Date.parse(DAY.from));
      expect(Date.parse(h.timestamp)).toBeLessThanOrEqual(Date.parse(DAY.to));
    }
  });

  test("file_change_query：按哈希精确命中 sh.php；窗口外/无此路径为空集", async () => {
    const hit = await siem.queryFileChanges({
      field: "hash",
      value: "3f2a9c1d7b8e4a605c9d1e2f3a4b5c6d",
      time_window: DAY,
    });
    expect(hit.total).toBe(1);
    expect(hit.hits[0]!.file.path).toBe("/var/www/html/uploads/sh.php");
    expect(hit.hits[0]!.file.sha256).toBeTypeOf("string");
    const none = await siem.queryFileChanges({ field: "path", value: "/no/such/dir", time_window: DAY });
    expect(none).toEqual({ total: 0, hits: [] });
    const outside = await siem.queryFileChanges({ field: "path", value: "/var/www/html/uploads", time_window: YEAR_2020 });
    expect(outside).toEqual({ total: 0, hits: [] });
  });

  test("outbound_conn_query：按目的 IP 命中 C2 外联；按域名含注入变体信标", async () => {
    const byIp = await siem.queryOutboundConns({ field: "dst_ip", value: "203.0.113.66", time_window: DAY });
    expect(byIp.total).toBe(3); // beacon #1 + beacon-repeat #2 + c2-domain
    const injectedIp = await siem.queryOutboundConns({ field: "dst_ip", value: "198.51.100.66", time_window: DAY });
    expect(injectedIp.total).toBe(1); // inject-beacon（攻击者可控 dst 字段埋点）
    const byDomain = await siem.queryOutboundConns({ field: "domain", value: "c2.evil-baseline.example", time_window: DAY });
    expect(byDomain.total).toBe(1);
    expect(byDomain.hits[0]!.conn.domain).toBe("c2.evil-baseline.example");
    // 注入变体（inject-beacon）：dst 域名是攻击者可控字段——全文口径可查
    // （命中 inject-beacon 的载荷域名 + c2-domain 的正常解析域名，共 2 条）
    const injected = await siem.queryOutboundConns({ field: "domain", value: "evil-baseline.example", time_window: DAY });
    expect(injected.total).toBe(2);
  });

  test("outbound_conn_query：按频率（firedtimes ≥ N）命中重复信标；空集口径", async () => {
    const freq2 = await siem.queryOutboundConns({ field: "freq", value: "2", time_window: DAY });
    expect(freq2.total).toBe(1);
    expect(freq2.hits[0]!.conn.firedtimes).toBeGreaterThanOrEqual(2);
    const freq3 = await siem.queryOutboundConns({ field: "freq", value: "3", time_window: DAY });
    expect(freq3).toEqual({ total: 0, hits: [] });
    const all = await siem.queryOutboundConns({ field: "freq", value: "1", time_window: DAY });
    expect(all.total).toBe(4); // 语料里外联维度共 4 条（含注入变体）
    const outside = await siem.queryOutboundConns({ field: "dst_ip", value: "203.0.113.66", time_window: YEAR_2020 });
    expect(outside).toEqual({ total: 0, hits: [] });
  });

  test("web_access_query：按 URL 模式命中 webshell 探针/SQLi/注入变体；空集口径", async () => {
    const shell = await siem.queryWebAccess({ url_pattern: "/uploads/sh.php", time_window: DAY });
    expect(shell.total).toBe(1);
    expect(shell.hits[0]!.access.url).toContain("/uploads/sh.php");
    const sqli = await siem.queryWebAccess({ url_pattern: "UNION%20SELECT", time_window: DAY });
    expect(sqli.total).toBe(1);
    const injected = await siem.queryWebAccess({ url_pattern: "ignore all previous instructions", time_window: DAY });
    expect(injected.total).toBe(1); // inject-url（攻击者可控 URL 埋点，全文口径可查）
    const none = await siem.queryWebAccess({ url_pattern: "/no/such/url", time_window: DAY });
    expect(none).toEqual({ total: 0, hits: [] });
    const outside = await siem.queryWebAccess({ url_pattern: "/uploads/sh.php", time_window: YEAR_2020 });
    expect(outside).toEqual({ total: 0, hits: [] });
  });

  test("proc_lineage_query：按进程名查父子（持久化 cron / 提权 sudo / 注入变体 python3）；空集口径", async () => {
    const persistence = await siem.queryProcLineage({ process: "cron", role: "parent", time_window: DAY });
    expect(persistence.total).toBe(2); // proc-100300 + inject-lineage
    const shell = await siem.queryProcLineage({ process: "sh", role: "child", time_window: DAY });
    expect(shell.total).toBe(1);
    expect(shell.hits[0]!.lineage.parent).toBe("cron");
    const privesc = await siem.queryProcLineage({ process: "sudo", role: "parent", time_window: DAY });
    expect(privesc.total).toBe(1);
    expect(privesc.hits[0]!.lineage.child).toBe("bash");
    const injected = await siem.queryProcLineage({ process: "python3", role: "child", time_window: DAY });
    expect(injected.total).toBe(1); // inject-lineage（攻击者可控 cmdline 埋点）
    expect(injected.hits[0]!.lineage.parent).toBe("cron");
    const none = await siem.queryProcLineage({ process: "no_such_bin", time_window: DAY });
    expect(none).toEqual({ total: 0, hits: [] });
    const outside = await siem.queryProcLineage({ process: "cron", time_window: YEAR_2020 });
    expect(outside).toEqual({ total: 0, hits: [] });
  });

  test("max_results 截断 hits 不改 total（PRD 返回形状口径与 siem_query 一致）", async () => {
    const r = await siem.queryOutboundConns({ field: "freq", value: "1", time_window: DAY, max_results: 2 });
    expect(r.hits).toHaveLength(2);
    expect(r.total).toBe(4);
  });
});

describe("executeHuntTool（执行封装：契约校验后的唯一分发点，fake 数据源 seam）", () => {
  class SpyHuntBackend implements HuntQueryBackend {
    calls: [string, unknown][] = [];
    private stub<H>(method: string, params: unknown): HuntResult<H> {
      this.calls.push([method, params]);
      return { total: 0, hits: [] };
    }
    async queryFileChanges(p: FileChangeQueryParams): Promise<HuntResult<never>> {
      return this.stub("queryFileChanges", p);
    }
    async queryOutboundConns(p: OutboundConnQueryParams): Promise<HuntResult<never>> {
      return this.stub("queryOutboundConns", p);
    }
    async queryWebAccess(p: WebAccessQueryParams): Promise<HuntResult<never>> {
      return this.stub("queryWebAccess", p);
    }
    async queryProcLineage(p: ProcLineageQueryParams): Promise<HuntResult<never>> {
      return this.stub("queryProcLineage", p);
    }
  }

  test("四工具各分发到 backend 的对应维度方法（参数透传不加工）", async () => {
    const spy = new SpyHuntBackend();
    await executeHuntTool(spy, "file_change_query", { field: "path", value: "/x", time_window: DAY });
    await executeHuntTool(spy, "outbound_conn_query", { field: "freq", value: "2", time_window: DAY, max_results: 5 });
    await executeHuntTool(spy, "web_access_query", { url_pattern: "/y", time_window: DAY });
    await executeHuntTool(spy, "proc_lineage_query", { process: "sh", role: "parent", time_window: DAY });
    expect(spy.calls.map(([m]) => m)).toEqual([
      "queryFileChanges",
      "queryOutboundConns",
      "queryWebAccess",
      "queryProcLineage",
    ]);
    expect(spy.calls[1]![1]).toEqual({ field: "freq", value: "2", time_window: DAY, max_results: 5 });
    expect(spy.calls[3]![1]).toEqual({ process: "sh", role: "parent", time_window: DAY, max_results: undefined });
  });

  test("面外工具直接炸响（unreachable，绝不静默吞）", async () => {
    const spy = new SpyHuntBackend();
    await expect(executeHuntTool(spy, "siem_query", {})).rejects.toThrow("unreachable_tool:siem_query");
  });
});

describe("登记闸（m9：未登记一律 L1 的 fail-closed 对四新工具生效，票 78）", () => {
  afterEach(() => {
    delete process.env.TOOLS_MANIFEST_FILE;
    resetToolsManifestCache();
  });

  test("登记后：四工具 = L0 只读，无票调用一律 allow（免验）", () => {
    for (const t of HUNT_QUERY_TOOLS) {
      expect(tierOf(t), `${t} tier`).toBe(0);
      expect(verifyTicket({ name: t, params: {} }, {}, NOW, OPTS), `${t} 无票调用`).toEqual({
        allow: true,
        reason: "allow",
      });
    }
  });

  test("登记前模拟：真表拷贝摘掉四行 → tierOf 落 policy 默认级 L1 → 无票 403 no_ticket", () => {
    const dir = mkdtempSync(join(tmpdir(), "ticket78-manifest-"));
    const manifestPath = join(dir, "tools.manifest.json");
    const manifest = JSON.parse(
      readFileSync(new URL("../../../../fixtures/tools.manifest.json", import.meta.url), "utf8"),
    ) as { tools: { name: string }[] };
    manifest.tools = manifest.tools.filter((t) => !HUNT_QUERY_TOOLS.includes(t.name as never));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    try {
      process.env.TOOLS_MANIFEST_FILE = manifestPath;
      resetToolsManifestCache();
      for (const t of HUNT_QUERY_TOOLS) {
        expect(tierOf(t), `${t} 未登记应落 L1`).toBe(1);
        expect(verifyTicket({ name: t, params: {} }, {}, NOW, OPTS), `${t} 未登记无票应 403`).toEqual({
          allow: false,
          code: 403,
          reason: "no_ticket",
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
