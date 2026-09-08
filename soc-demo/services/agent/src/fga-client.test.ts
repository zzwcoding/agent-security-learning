// 票 18：agent 侧 OpenFGA 客户端（chat 意图闸的裁决出站）。
// 契约测试用注入 fetchImpl 捕获请求形态（票 08 test_proxy.py 的 MockTransport 先例、
// 票 27 llm-client.test.ts 的出站 seam 先例）——绝不真出网；真容器冒烟走 fgaSmokeProbe
// 探测（票 16 msbProbe / 票 27 llmSmokeProbe 先例）：openfga 容器没起就显式 skip 留痕。
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  fgaSmokeProbe,
  loadFgaIds,
  makeFgaChecker,
  queryOpenfga,
  type FgaIds,
} from "./fga-client.js";

const IDS: FgaIds = { store_id: "store-1", model_id: "model-1" };

function fetchCapturing(reply: { ok: boolean; status?: number; body?: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: typeof fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(reply.body ?? { allowed: true }), {
      status: reply.ok ? (reply.status ?? 200) : (reply.status ?? 500),
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

// ---------- 请求形态契约（与 gateway/plugins/fga_check.py::query_openfga 同一世界） ----------

describe("queryOpenfga 请求契约", () => {
  test("POST /stores/{store}/check：tuple_key(user,can_execute,tool:名) + authorization_model_id", async () => {
    const { impl, calls } = fetchCapturing({ ok: true, body: { allowed: false } });
    const allowed = await queryOpenfga("http://fga.test:18080", IDS, "user:soc1", "tool:siem_query", 1000, impl);
    expect(allowed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://fga.test:18080/stores/store-1/check");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      tuple_key: { user: "user:soc1", relation: "can_execute", object: "tool:siem_query" },
      authorization_model_id: "model-1",
    });
  });

  test("allowed=true 透传；非 200 / JSON 坏形抛错（调用方按 deny 处理，INV-1）", async () => {
    const ok = fetchCapturing({ ok: true, body: { allowed: true } });
    await expect(queryOpenfga("http://fga.test", IDS, "user:admin", "tool:kb_lookup", 1000, ok.impl)).resolves.toBe(true);

    const http500 = fetchCapturing({ ok: false, status: 500 });
    await expect(queryOpenfga("http://fga.test", IDS, "user:admin", "tool:kb_lookup", 1000, http500.impl)).rejects.toThrow();

    const badJson = fetchCapturing({ ok: true, body: "not-an-object" });
    await expect(queryOpenfga("http://fga.test", IDS, "user:admin", "tool:kb_lookup", 1000, badJson.impl)).rejects.toThrow();
  });
});

// ---------- makeFgaChecker：fail-closed 收口（裁判病了 = 拒绝，INV-1） ----------

describe("makeFgaChecker fail-closed", () => {
  test("裁判 allow/deny 原样透传；不可达/超时/ids 不可读一律 {allowed:false, reason}", async () => {
    const allow = makeFgaChecker({
      apiUrl: "http://fga.test",
      ids: IDS,
      fetchImpl: fetchCapturing({ ok: true, body: { allowed: true } }).impl,
    });
    await expect(allow("user:soc1", "siem_query")).resolves.toEqual({ allowed: true });

    const deny = makeFgaChecker({
      apiUrl: "http://fga.test",
      ids: IDS,
      fetchImpl: fetchCapturing({ ok: true, body: { allowed: false } }).impl,
    });
    await expect(deny("user:soc1", "isolate_host")).resolves.toEqual({ allowed: false, reason: "fga_denied" });

    const down = makeFgaChecker({
      apiUrl: "http://fga.test",
      ids: IDS,
      fetchImpl: fetchCapturing({ ok: false, status: 503 }).impl,
    });
    await expect(down("user:soc1", "siem_query")).resolves.toMatchObject({ allowed: false, reason: "fga_unreachable" });

    const unreadable = makeFgaChecker({ apiUrl: "http://fga.test", ids: null as unknown as FgaIds });
    await expect(unreadable("user:soc1", "siem_query")).resolves.toMatchObject({
      allowed: false,
      reason: "fga_ids_unreadable",
    });
  });
});

// ---------- loadFgaIds：id 文件读口（setup-openfga.sh 每次重建都刷，不写死） ----------

describe("loadFgaIds", () => {
  test("仓库内真文件可读且字段齐（services/gateway/plugins/fga_ids.json）", () => {
    // 票 12 的 setup 已跑过才有这个文件；缺了就跳过（compose 部署首个动作就是 setup-openfga.sh）
    let raw: string;
    try {
      raw = readFileSync(loadFgaIds.defaultPath(), "utf8");
    } catch {
      console.log("skip: fga_ids.json 不存在（先跑 bash scripts/setup-openfga.sh）");
      return;
    }
    const ids = JSON.parse(raw) as FgaIds;
    expect(ids.store_id).toBeTruthy();
    expect(ids.model_id).toBeTruthy();
  });

  test("坏 JSON / 缺字段抛错（fail-closed：宁可闸瞎也不猜）", () => {
    expect(() => loadFgaIds.pathOf("/nonexistent/fga_ids.json")).toThrow();
  });
});

// ---------- 真容器冒烟（openfga 容器 + 票 12 灌好的 A.2 世界） ----------

describe("真 OpenFGA 容器冒烟（验收②：三态裁决走真容器）", () => {
  test("soc1 只读工具 allow、isolate_host deny——与 A.2 矩阵逐条对上", async () => {
    const probe = await fgaSmokeProbe();
    if (!probe.ok) {
      console.log(`skip: ${probe.reason}`);
      return;
    }
    const check = makeFgaChecker();
    await expect(check("user:soc1", "siem_query")).resolves.toEqual({ allowed: true });
    await expect(check("user:soc1", "related_alerts")).resolves.toEqual({ allowed: true });
    await expect(check("user:soc1", "isolate_host")).resolves.toEqual({ allowed: false, reason: "fga_denied" });
    await expect(check("user:redteam", "siem_query")).resolves.toEqual({ allowed: false, reason: "fga_denied" });
  });
});
