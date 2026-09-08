// 票 17 · 检索面测试：RealChromaClient 请求形态（mock fetch 锁死，绝不真出网）
// + 真容器冒烟（chromaSmokeProbe 能力探测：不可达显式 skip 打印原因——票 16 msbProbe
// / 票 27 llmSmokeProbe 先例）+ MemoryVectorStore 替身语义（m7 卡 Adapter 行）。
import { afterEach, describe, expect, test } from "vitest";
import {
  chromaSmokeProbe,
  hashEmbedding,
  KB_TOP_K,
  MemoryVectorStore,
  RealChromaClient,
  type VectorHit,
} from "./vector-store.js";

describe("MemoryVectorStore（单测内存替身：m7 卡 Adapter 行授权）", () => {
  test("cosine 排序 + top-k 截断 + kind 过滤 + upsert 幂等", async () => {
    const store = new MemoryVectorStore();
    // 唯一高相关条目（查询词全中）+ 6 条只有单词重合的噪声
    await store.upsert({
      id: "kb_hit",
      text: "centos7 sshd 暴力破解 授权红队演练 环境事实",
      metadata: { kind: "env_fact", title: "t0", source_case_id: null, tags: [] },
    });
    for (let i = 1; i <= 6; i++) {
      await store.upsert({
        id: `kb_${i}`,
        text: `centos7 无关条目 噪声词堆 ${i} 蜜罐 邮件 工单 巡检`,
        metadata: { kind: i <= 2 ? "runbook" : "env_fact", title: `t${i}`, source_case_id: null, tags: [] },
      });
    }
    await store.upsert({ // upsert 幂等：同 id 覆盖不重复
      id: "kb_hit",
      text: "centos7 sshd 暴力破解 授权红队演练 环境事实（重写版）",
      metadata: { kind: "env_fact", title: "t0", source_case_id: null, tags: [] },
    });

    const hits = await store.query("centos7 sshd 暴力破解", 5);
    expect(hits).toHaveLength(5); // top-k 截断（共 7 条）
    expect(hits[0].id).toBe("kb_hit"); // 词面重合最多者第一
    const scores = hits.map((h) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores); // 分数降序

    const onlyRunbook = await store.query("centos7 sshd 暴力破解", 5, { kind: "runbook" });
    expect(onlyRunbook.every((h) => h.metadata.kind === "runbook")).toBe(true);
    expect(onlyRunbook).toHaveLength(2);

    const none = await store.query("完全无关的查询词 蜜罐", 5);
    expect(none[0].score).toBeLessThan(scores[0]); // 相关性单调
  });
});

// ---------- RealChromaClient 请求形态（出站 seam 注入假 fetch，票 27 mockProxyFetch 先例） ----------

interface SeenReq { url: string; method: string; body: Record<string, unknown> }

function chromaFetch(reply: (req: SeenReq) => unknown) {
  const seen: SeenReq[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    const req: SeenReq = {
      url: String(url),
      method: init?.method ?? "GET",
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    seen.push(req);
    return new Response(JSON.stringify(reply(req)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, seen };
}

const FIX_CID = "col-1234";

function makeClient(reply?: (req: SeenReq) => unknown) {
  const { impl, seen } = chromaFetch(reply ?? (() => ({})));
  const client = new RealChromaClient({
    baseUrl: "http://chroma-stub:8000",
    collection: "kb_entries",
    embedding: hashEmbedding,
    fetchImpl: impl,
  });
  return { client, seen };
}

describe("RealChromaClient · chroma REST API v2 请求形态（生产路径；引擎是 chroma，我们只说它的 REST）", () => {
  test("upsert：get_or_create 集合 → /upsert 带 ids/documents/metadatas/显式 embeddings", async () => {
    const { client, seen } = makeClient(() => ({ id: FIX_CID }));
    await client.upsert({
      id: "kb_x",
      text: "环境事实：centos7 授权红队演练",
      metadata: { kind: "env_fact", title: "t", source_case_id: "case_000001", tags: ["centos7"] },
    });
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual([
      `POST http://chroma-stub:8000/api/v2/tenants/default_tenant/databases/default_database/collections`,
      `POST http://chroma-stub:8000/api/v2/tenants/default_tenant/databases/default_database/collections/${FIX_CID}/upsert`,
    ]);
    const create = seen[0].body;
    expect(create).toMatchObject({ name: "kb_entries", get_or_create: true });
    const upsert = seen[1].body;
    expect(upsert["ids"]).toEqual(["kb_x"]);
    expect(upsert["documents"]).toEqual(["环境事实：centos7 授权红队演练"]);
    expect((upsert["metadatas"] as unknown[])[0]).toMatchObject({ kind: "env_fact", source_case_id: "case_000001" });
    // hash 模式显式带 embedding（chroma 服务端不用运行时下载模型——CI 离线纪律）
    expect(Array.isArray((upsert["embeddings"] as number[][])[0])).toBe(true);
  });

  test("query：/query 带 n_results 与 query_embeddings；where kind 过滤；回包列式数组解一层", async () => {
    const { client, seen } = makeClient((req) => {
      // 集合 create 与 query 的回包形状不同，按路径区分（chroma 真实回包形态）
      if (req.url.endsWith("/collections")) return { id: FIX_CID };
      // chroma 回包 = 按查询批套一层的列式数组（{列: [[...]]}）
      return {
        ids: [["kb_a", "kb_b"]],
        documents: [["doc-a", "doc-b"]],
        metadatas: [[{ kind: "runbook", title: "a", source_case_id: null, tags: [] }, { kind: "fp_pattern", title: "b", source_case_id: null, tags: [] }]],
        distances: [[0.1, 0.6]],
      };
    });
    const hits: VectorHit[] = await client.query("centos7 处置", KB_TOP_K, { kind: "runbook" });
    const q = seen[1].body;
    expect(q["n_results"]).toBe(5);
    expect(Array.isArray((q["query_embeddings"] as number[][])[0])).toBe(true);
    expect(q["where"]).toEqual({ kind: "runbook" });
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ id: "kb_a", score: 0.9 }); // 1 - cosine distance
    expect(hits[0].metadata.title).toBe("a");
  });

  test("KB_EMBEDDING=chroma_default：省略 embeddings / 用 query_texts（服务端默认模型模式）", async () => {
    const { impl, seen } = chromaFetch((req) => (req.url.endsWith("/collections") ? { id: FIX_CID } : { ids: [[]] }));
    const client = new RealChromaClient({
      baseUrl: "http://chroma-stub:8000",
      collection: "kb_entries",
      embedding: null, // index.ts 生产装配按 KB_EMBEDDING=chroma_default 解析出 null
      fetchImpl: impl,
    });
    await client.upsert({ id: "kb_x", text: "t", metadata: { kind: "runbook", title: "t", source_case_id: null, tags: [] } });
    expect((seen[1].body)["embeddings"]).toBeUndefined(); // 服务端自己算
    await client.query("查询词", 5);
    expect((seen[2].body)["query_texts"]).toEqual(["查询词"]);
    expect((seen[2].body)["query_embeddings"]).toBeUndefined();
  });

  test("chroma 病了（5xx）→ 抛错（kb_write 路径强杀 = 提案挂起 Web 可见，PRD 异常与边界）", async () => {
    const impl = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const client = new RealChromaClient({ baseUrl: "http://chroma-stub:8000", fetchImpl: impl });
    await expect(client.upsert({ id: "kb_x", text: "t", metadata: { kind: "runbook", title: "t", source_case_id: null, tags: [] } })).rejects.toThrow("chroma_POST_failed:http_500");
  });
});

// ---------- 真容器冒烟（能力探测；docker 不可用显式 skip 打印原因） ----------

const probe = await chromaSmokeProbe();

describe("真 chroma 容器冒烟（ADR 0002 框架红线：本地真容器留证据；CI 无 docker 显式 skip）", async () => {
  if (!probe.ok) {
    console.warn(`[票 17 真容器冒烟 skip] ${probe.reason}`);
  }
  test.skipIf(!probe.ok)("真容器：get_or_create 集合 → upsert 3 条 → top-k 检索命中 → kind 过滤 → 清场", async () => {
    const name = `kb_smoke_${Date.now()}`;
    const client = new RealChromaClient({ baseUrl: process.env.KB_CHROMA_SMOKE_URL ?? "http://127.0.0.1:18000", collection: name, embedding: hashEmbedding });
    await client.upsert({ id: "kb_smoke_1", text: "centos7 sshd 暴力破解 授权红队演练 环境事实", metadata: { kind: "env_fact", title: "演练登记", source_case_id: "case_smoke", tags: ["centos7"] } });
    await client.upsert({ id: "kb_smoke_2", text: "web-01 sql注入 union select 处置 runbook", metadata: { kind: "runbook", title: "注入处置", source_case_id: null, tags: [] } });
    await client.upsert({ id: "kb_smoke_3", text: "web-01 遗留 CGI 5xx 运维噪声 FP 模式", metadata: { kind: "fp_pattern", title: "噪声", source_case_id: null, tags: [] } });

    const hits = await client.query("centos7 sshd 暴力破解", KB_TOP_K);
    expect(hits).toHaveLength(3); // 集合内全量不超过 k
    expect(hits[0].id).toBe("kb_smoke_1"); // 词面重合最多者第一
    expect(hits[0].metadata.kind).toBe("env_fact");

    const runbooks = await client.query("centos7 sshd 暴力破解", KB_TOP_K, { kind: "runbook" });
    expect(runbooks.map((h) => h.id)).toEqual(["kb_smoke_2"]); // where 过滤确定性

    // 清场（独立集合名，不影响生产 kb_entries；chroma 1.0.x 的 DELETE 按名字）
    const base = (process.env.KB_CHROMA_SMOKE_URL ?? "http://127.0.0.1:18000").replace(/\/$/, "");
    const del = await fetch(`${base}/api/v2/tenants/default_tenant/databases/default_database/collections/${name}`, { method: "DELETE" });
    expect(del.ok).toBe(true);
    console.log(`[票 17 真容器冒烟证据] chroma 1.0.0 集合 ${name}：3 upsert / top-k 检索 / kind 过滤 / 清场 全过`);
  });
});

afterEach(() => {
  // 占位：本文件无共享资源；保留钩子以对齐仓库测试风格
});
