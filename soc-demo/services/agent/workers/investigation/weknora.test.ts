import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  WEKNORA_TOOLS,
  WEKNORA_TOOL_SCHEMAS,
  MemoryPlaybookLibrary,
  MemoryWeknoraGraph,
  WEKNORA_FIXTURES,
  executeWeknoraTool,
  makeHuntRegisterSeam,
  validateWeknoraToolCall,
  type WeknoraGraphBackend,
} from "./weknora.js";
import { HUNT_QUERY_TOOLS } from "./hunt.js";
import { INVESTIGATION_TOOLS } from "./prompt.js";
import { MemoryAuditSink, type AuditEntry } from "../../src/audit.js";
import { tierOf } from "../../src/tools-manifest.js";
import { verifyTicket } from "../../src/verify-ticket.js";
import type { RegisterCall, RegisterRecord } from "../../src/orchestration/ports.js";
import type { GraphRelation } from "./weknora.js";

// 票 79③ 验收主战场：weknora 三工具的 Memory stub 契约。stub 是真接口假实现（换
// weknora HTTP 实现不换调用方，MemoryVectorStore 先例）；T22 口径（INV-5）——
// hypothesis_register 只写 proposed / graph_query 只回 approved。spec 验收表 T22 的
// 测试标识行（orchestration/graph-stub.test.ts）由 L0 授权改为本实际路径（L0 裁定③：
// stub 实现与测试落 m5/m2 领地，与实现同处）。

const NOW = 1757000100; // 冻结时钟（票 07 同款 fixture 时刻）
const KEY = (JSON.parse(
  readFileSync(new URL("../../../../fixtures/tickets/contract.json", import.meta.url), "utf8"),
) as { hmac_key: { value: string } }).hmac_key.value;
const OPTS = { hmacKey: KEY };
const GRAPH_FIXTURE = fileURLToPath(new URL("../../../../fixtures/weknora/graph.json", import.meta.url));

const call = (over: Partial<RegisterCall> = {}): RegisterCall & Record<string, unknown> => ({
  hypothesis_id: "hyp-t22",
  verdict: "miss",
  confidence: 0.8,
  evidence_hashes: ["sha256:aaa", "sha256:bbb"],
  ...over,
});

describe("weknora 三工具面与签名契约（票 79 / PRD §13.4b）", () => {
  test("WEKNORA_TOOLS = 三工具，与狩猎四维/调查六件零交集，面内无 L2（INV-3）", () => {
    expect([...WEKNORA_TOOLS]).toEqual(["playbook_lookup", "graph_query", "hypothesis_register"]);
    for (const t of WEKNORA_TOOLS) {
      expect(HUNT_QUERY_TOOLS).not.toContain(t); // 票 78 四维面零变化
      expect(INVESTIGATION_TOOLS).not.toContain(t); // 调查六件套零变化（旧链零回归）
      expect(["isolate_host", "block_ip", "kb_write"]).not.toContain(t);
      expect(tierOf(t), `${t} tier`).toBeLessThan(2); // L0×2 + L1×1，无 L2
    }
  });

  test("契约自证：register 的 required 全带（L1 写的最小凭证面）", () => {
    expect(WEKNORA_TOOL_SCHEMAS.hypothesis_register!.required).toEqual([
      "hypothesis_id",
      "verdict",
      "confidence",
      "evidence_hashes",
    ]);
    expect(WEKNORA_TOOL_SCHEMAS.graph_query!.required).toEqual(["entity"]);
  });

  test("签名把关：lookup 无过滤维度拒绝（防「全库捞」，kb_verify 同款）", () => {
    expect(validateWeknoraToolCall("playbook_lookup", {})).toEqual({ ok: false, error: "lookup_requires_filter" });
    expect(validateWeknoraToolCall("playbook_lookup", { tag: "webshell" })).toEqual({ ok: true });
    expect(validateWeknoraToolCall("playbook_lookup", { query: "外联" })).toEqual({ ok: true });
    expect(validateWeknoraToolCall("playbook_lookup", { tag: "x", max_results: 0 }).ok).toBe(false);
  });

  test("签名把关：graph_query 缺实体拒绝；register 逐字段把关（fail-closed 的签名版）", () => {
    expect(validateWeknoraToolCall("graph_query", {})).toEqual({ ok: false, error: "entity_required" });
    expect(validateWeknoraToolCall("graph_query", { entity: "web01", relation: "" }).ok).toBe(false);
    expect(validateWeknoraToolCall("graph_query", { entity: "web01" })).toEqual({ ok: true });

    expect(validateWeknoraToolCall("hypothesis_register", {})).toEqual({ ok: false, error: "hypothesis_id_required" });
    expect(
      validateWeknoraToolCall("hypothesis_register", call({ hypothesis_id: "" })),
    ).toEqual({ ok: false, error: "hypothesis_id_required" });
    expect(
      validateWeknoraToolCall("hypothesis_register", call({ verdict: "maybe" as never })),
    ).toEqual({ ok: false, error: "bad_verdict" });
    expect(
      validateWeknoraToolCall("hypothesis_register", call({ confidence: 1.5 })),
    ).toEqual({ ok: false, error: "bad_confidence" });
    expect(
      validateWeknoraToolCall("hypothesis_register", call({ evidence_hashes: [] })),
    ).toEqual({ ok: false, error: "evidence_hashes_required" });
    expect(validateWeknoraToolCall("hypothesis_register", call())).toEqual({ ok: true });
    expect(validateWeknoraToolCall("no_such_tool", {})).toEqual({ ok: false, error: "unknown_tool" });
  });
});

describe("MemoryPlaybookLibrary（playbook_lookup 的本地剧本库 fixture）", () => {
  const lib = new MemoryPlaybookLibrary(WEKNORA_FIXTURES);

  test("按族 tag 命中三族剧本；max_results 截断 hits 不改 total", async () => {
    const webshell = await lib.lookup({ tag: "webshell" });
    expect(webshell.total).toBe(1);
    expect(webshell.hits[0]!.id).toBe("pb-webshell-001");
    const c2 = await lib.lookup({ tag: "c2" });
    expect(c2.total).toBe(1);
    const all = await lib.lookup({ query: "狩猎" });
    expect(all.total).toBe(3);
    const capped = await lib.lookup({ query: "狩猎", max_results: 1 });
    expect(capped.hits).toHaveLength(1);
    expect(capped.total).toBe(3);
    const none = await lib.lookup({ tag: "no_such_family" });
    expect(none).toEqual({ total: 0, hits: [] });
  });
});

describe("MemoryWeknoraGraph（graph_query 只回 approved / register 只写 proposed——T22，INV-5）", () => {
  const graph = new MemoryWeknoraGraph(GRAPH_FIXTURE);

  test("proposed_only_unlisted：approved 关系命中；proposed seed 关系对检索面不存在（T22）", async () => {
    const approved = await graph.query({ entity: "web01" });
    expect(approved.total).toBe(1);
    expect(approved.hits[0]!.predicate).toBe("resolved_to");
    expect(approved.hits.every((r) => r.status === "approved")).toBe(true);

    // seed 里的 proposed 探针（hosts_webshell）匹配同一实体——检索面必须看不见
    const r = await graph.query({ entity: "web01" });
    expect(r.hits.some((x) => x.predicate === "hosts_webshell")).toBe(false);

    const byIp = await graph.query({ entity: "203.0.113.66" });
    expect(byIp.total).toBe(2); // resolved_to 的 object 侧 + beacons_to 的 subject 侧
    const filtered = await graph.query({ entity: "203.0.113.66", relation: "beacons_to" });
    expect(filtered.total).toBe(1);
    expect(filtered.hits[0]!.object.value).toBe("c2.evil-baseline.example");
    const none = await graph.query({ entity: "no-such-entity" });
    expect(none).toEqual({ total: 0, hits: [] });
  });

  test("register 只写 proposed：状态字面量唯一，写进图的关系检索面不可见（T08/T22）", async () => {
    const g = new MemoryWeknoraGraph(GRAPH_FIXTURE);
    const before = await g.query({ entity: "hyp-t22" });
    expect(before.total).toBe(0);

    const record = await g.register(call());
    expect(record.status).toBe("proposed"); // 入图一律 proposed（INV-5）
    expect(record.hypothesis_id).toBe("hyp-t22");
    expect(record.verdict).toBe("miss");
    expect(record.evidence_hashes).toEqual(["sha256:aaa", "sha256:bbb"]);
    expect(typeof record.registered_at).toBe("number");

    // 第二次登记同样 proposed——没有任何翻 approved 的写通道
    const second = await g.register(call({ hypothesis_id: "hyp-t22b", verdict: "hit" }));
    expect(second.status).toBe("proposed");
    expect(g.entries).toHaveLength(2);

    // 登记后的关系在 graph_query 检索面依旧不可见（人审通道票 83 才进面）
    const after = await g.query({ entity: "hyp-t22" });
    expect(after.total).toBe(0);
  });

  test("换真实现不换调用方：seam 消费者对任意 WeknoraGraphBackend 形状成立（HTTP adapter 落点）", async () => {
    // 最小假 HTTP 形态（同接口另实现）——调用方（executeWeknoraTool/注册缝）一行不改
    class FakeHttpGraph implements WeknoraGraphBackend {
      calls: string[] = [];
      async query(params: { entity: string }): Promise<{ total: number; hits: GraphRelation[] }> {
        this.calls.push(`query:${params.entity}`);
        return { total: 0, hits: [] };
      }
      async register(c: RegisterCall): Promise<RegisterRecord> {
        this.calls.push(`register:${c.hypothesis_id}`);
        return { ...c, status: "proposed", registered_at: 0 };
      }
    }
    const http = new FakeHttpGraph();
    await executeWeknoraTool(new MemoryPlaybookLibrary(WEKNORA_FIXTURES), http, "graph_query", { entity: "web01" });
    await executeWeknoraTool(new MemoryPlaybookLibrary(WEKNORA_FIXTURES), http, "hypothesis_register", {
      ...call(),
    });
    expect(http.calls).toEqual(["query:web01", "register:hyp-t22"]);
  });
});

describe("executeWeknoraTool（执行分发：契约校验后的唯一分发点）", () => {
  test("三工具各分发到 backend 对应方法（参数收口成强类型透传）", async () => {
    const lib = new MemoryPlaybookLibrary(WEKNORA_FIXTURES);
    const graph = new MemoryWeknoraGraph(GRAPH_FIXTURE);
    const pb = await executeWeknoraTool(lib, graph, "playbook_lookup", { tag: "c2" });
    expect((pb as { total: number }).total).toBe(1);
    const gq = await executeWeknoraTool(lib, graph, "graph_query", { entity: "web01", max_results: 5 });
    expect((gq as { total: number }).total).toBe(1);
    const reg = await executeWeknoraTool(lib, graph, "hypothesis_register", { ...call() });
    expect((reg as RegisterRecord).status).toBe("proposed");
    await expect(
      executeWeknoraTool(lib, graph, "siem_query", {}),
    ).rejects.toThrow("unreachable_tool:siem_query");
  });
});

describe("register 循环缝（L0 裁定②：五要素审计在 seam 实现内，INV-8）", () => {
  test("seam 落账：写 proposed + 五要素审计条目带全 record（可回放）", async () => {
    const audit = new MemoryAuditSink();
    const graph = new MemoryWeknoraGraph(GRAPH_FIXTURE);
    const seam = makeHuntRegisterSeam({ graph, audit });
    const record = await seam(call({ verdict: "miss" }));
    expect(record.status).toBe("proposed");
    expect(graph.entries).toHaveLength(1);
    const entry = audit.entries.find((e) => e.action === "hypothesis_register") as AuditEntry;
    expect(entry).toBeTruthy();
    expect(entry.actor).toEqual({ type: "agent", id: "agent:hunt_flow" });
    expect(entry.objectId).toBe("hyp-t22");
    expect(entry.objectType).toBe("hypothesis");
    expect(entry.requestId).toBe("hunt_register_seam");
    expect(entry.result).toBe("SUCCESS");
    expect(typeof entry.createdAt).toBe("number");
    expect(entry.details).toMatchObject({ hypothesis_id: "hyp-t22", status: "proposed", verdict: "miss" });
  });
});

describe("登记闸（m9：三工具的分级语义——验票半边，票面三件套之一）", () => {
  test("playbook_lookup/graph_query = L0 免验；hypothesis_register = L1 无票 403 no_ticket", () => {
    expect(tierOf("playbook_lookup")).toBe(0);
    expect(tierOf("graph_query")).toBe(0);
    expect(tierOf("hypothesis_register")).toBe(1);
    expect(verifyTicket({ name: "playbook_lookup", params: {} }, {}, NOW, OPTS)).toEqual({
      allow: true,
      reason: "allow",
    });
    expect(verifyTicket({ name: "graph_query", params: {} }, {}, NOW, OPTS)).toEqual({
      allow: true,
      reason: "allow",
    });
    expect(verifyTicket({ name: "hypothesis_register", params: {} }, {}, NOW, OPTS)).toEqual({
      allow: false,
      code: 403,
      reason: "no_ticket",
    });
  });
});
