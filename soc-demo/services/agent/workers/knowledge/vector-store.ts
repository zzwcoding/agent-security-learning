// m7 检索面 · 向量库 seam（票 17·ADR 0002 框架红线：真 chromadb 落 compose）。
//
// m7 卡 Seam：向量库（adapter：chroma 容器 / 内存 stub 供单测）。这里三个件：
//   1. MemoryVectorStore —— 内存 stub（单测确定性；m7 卡 Adapter 行授权的替身，
//      不是「手写检索冒充 chroma」：生产路径是 RealChromaClient → 真 chroma 容器）；
//   2. RealChromaClient —— chroma 官方容器 REST API v2 的 fetch client（HttpTriageM2
//      同款 HTTP adapter 思路：引擎是 chroma 的，我们只说它的 REST。不引 chromadb npm
//      client——把 server 版本耦合进 lockfile，出站形态用契约测试锁死）；
//   3. chromaSmokeProbe —— 真容器冒烟的能力探测（票 16 msbProbe / 票 27 llmSmokeProbe
//      先例）：容器不可达时测试显式 skip 并打印原因，绝不静默。
//
// embedding 选型（m7 卡/PRD §5.10 无口径 → 票内裁决，出入记票）：chroma 服务端默认
// embedding 会在首次写入时运行时下载 onnx 模型（~80MB），与 CI 离线纪律冲突。故
// embedding 做成注入件：默认 hashEmbedding（确定性本地 TF 哈希向量，离线零依赖，
// 词面匹配对教学/demo 的检索语义足够）；KB_EMBEDDING=chroma_default 时切换为服务端
// 默认模型（省略 embeddings 字段，语义向量，需容器能出网下载模型）。换模型不改代码。
//
// INV-5 的结构性保证在这里：本 seam 的 upsert 只被 kb_write 动作（ApprovalToken 正门）
// 调用——proposed/rejected 条目没有任何代码路径能写入检索面。

/** 检索注入 top-k（PRD 决策记录 #6：top-k 越小投毒演示攻击面越可控 → 定 5）。 */
export const KB_TOP_K = 5;

export interface VectorDoc {
  id: string;
  /** 进向量与正文的文本（kb_write 写入 title+body 拼接）。 */
  text: string;
  metadata: { kind: string; title: string; source_case_id: string | null; tags: string[] };
}

export interface VectorHit {
  id: string;
  /** 相似度得分（cosine 相似：越大越近；chroma 返回 distance 时取 1-distance）。 */
  score: number;
  text: string;
  metadata: VectorDoc["metadata"];
}

/** 向量库 seam：upsert 幂等（重复 approve/resume 重入安全），query 只查已入库条目。 */
export interface VectorStore {
  upsert(doc: VectorDoc): Promise<void>;
  query(text: string, k: number, where?: { kind?: string }): Promise<VectorHit[]>;
}

// ---------- embedding（确定性本地 TF 哈希向量） ----------

const DIM = 256;

/** FNV-1a 32 位：纯整数算术，跨进程跨平台逐位一致（不依赖 Math.random/时钟）。 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 分词：ascii 词 + CJK 单字（中文无空格，按字切）。检索语义 = 词面匹配。 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fff]/g) ?? [];
}

/** 稳定哈希 TF 向量：词频按 hash 投到 DIM 维，L2 归一化。同文本必得同向量。 */
export function hashEmbedding(text: string): number[] {
  const vec = new Array<number>(DIM).fill(0);
  for (const tok of tokenize(text)) {
    vec[fnv1a(tok) % DIM] += 1;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

export type EmbeddingFn = (text: string) => number[];

// ---------- 内存替身（单测；m7 卡 Adapter 行） ----------

interface MemoryEntry {
  vec: number[];
  doc: VectorDoc;
}

export class MemoryVectorStore implements VectorStore {
  private readonly docs = new Map<string, MemoryEntry>();
  private readonly embedding: EmbeddingFn;

  constructor(embedding: EmbeddingFn = hashEmbedding) {
    this.embedding = embedding;
  }

  async upsert(doc: VectorDoc): Promise<void> {
    this.docs.set(doc.id, { vec: this.embedding(doc.text), doc });
  }

  async query(text: string, k: number, where?: { kind?: string }): Promise<VectorHit[]> {
    const q = this.embedding(text);
    const hits: VectorHit[] = [];
    for (const { vec, doc } of this.docs.values()) {
      if (where?.kind && doc.metadata.kind !== where.kind) continue;
      let dot = 0;
      for (let i = 0; i < DIM; i++) dot += q[i] * vec[i];
      hits.push({ id: doc.id, score: dot, text: doc.text, metadata: doc.metadata });
    }
    // 分数降序，稳定次序（同分按 id）——确定性断言依赖它
    return hits.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1)).slice(0, k);
  }
}

// ---------- 真 chroma 容器 client（生产；REST API v2） ----------

export interface RealChromaOpts {
  /** chroma 容器 base（默认 env KB_CHROMA_URL，再默认 compose 服务名）。 */
  baseUrl?: string;
  /** 集合名（默认 kb_entries；冒烟测试用独立名避免污染）。 */
  collection?: string;
  /** REST v2 的租户/库（chroma 1.0.x 默认值；路径形如
   *  /api/v2/tenants/{t}/databases/{d}/collections）。 */
  tenant?: string;
  database?: string;
  /** embedding 注入件；缺省读 env KB_EMBEDDING（hash=本地确定性[默认] / chroma_default=
   *  服务端默认模型），传 null/函数则显式覆盖（测试注入确定性假件）。 */
  embedding?: EmbeddingFn | null;
  /** 出站 seam：测试注入假 fetch 锁请求形态；生产用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

export class RealChromaClient implements VectorStore {
  private readonly baseUrl: string;
  private readonly collectionName: string;
  private readonly embedding: EmbeddingFn | null;
  private readonly fetchImpl: typeof fetch;
  /** REST v2 路径前缀（chroma 1.0.x：集合操作全在 tenants/databases 前缀下，实测 openapi）。 */
  private readonly prefix: string;
  private collectionId: string | null = null;

  constructor(opts: RealChromaOpts = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.KB_CHROMA_URL ?? "http://chroma:8000").replace(/\/$/, "");
    this.collectionName = opts.collection ?? "kb_entries";
    this.prefix = `${this.baseUrl}/api/v2/tenants/${opts.tenant ?? "default_tenant"}/databases/${opts.database ?? "default_database"}`;
    this.embedding = opts.embedding === undefined
      ? (process.env.KB_EMBEDDING === "chroma_default" ? null : hashEmbedding)
      : opts.embedding;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  private async fetchJson(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    // path 传完整路径（prefix 已含 baseUrl）
    const res = await this.fetchImpl(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`chroma_${method}_failed:http_${res.status}`);
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  }

  /** get_or_create 集合（id 进程内缓存一次）。 */
  private async ensureCollection(): Promise<string> {
    if (this.collectionId) return this.collectionId;
    const c = await this.fetchJson("POST", `${this.prefix}/collections`, {
      name: this.collectionName,
      get_or_create: true,
    });
    const id = c["id"];
    if (typeof id !== "string") throw new Error("chroma_bad_shape:collection_id");
    this.collectionId = id;
    return id;
  }

  async upsert(doc: VectorDoc): Promise<void> {
    const cid = await this.ensureCollection();
    await this.fetchJson("POST", `${this.prefix}/collections/${cid}/upsert`, {
      ids: [doc.id],
      documents: [doc.text],
      metadatas: [doc.metadata],
      ...(this.embedding ? { embeddings: [this.embedding(doc.text)] } : {}),
    });
  }

  async query(text: string, k: number, where?: { kind?: string }): Promise<VectorHit[]> {
    const cid = await this.ensureCollection();
    const body: Record<string, unknown> = {
      n_results: k,
      include: ["documents", "metadatas", "distances"],
      ...(this.embedding
        ? { query_embeddings: [this.embedding(text)] }
        : { query_texts: [text] }),
      ...(where?.kind ? { where: { kind: where.kind } } : {}),
    };
    const r = await this.fetchJson("POST", `${this.prefix}/collections/${cid}/query`, body);
    // chroma 回包是按查询批套一层的列式数组：{ids: [[...]], documents: [[...]], ...}
    const ids = (r["ids"] as string[][] | undefined)?.[0];
    if (!ids) throw new Error("chroma_bad_shape:query");
    const documents = (r["documents"] as string[][] | undefined)?.[0] ?? [];
    const metadatas = (r["metadatas"] as VectorDoc["metadata"][][] | undefined)?.[0] ?? [];
    const distances = (r["distances"] as number[][] | undefined)?.[0] ?? [];
    return ids.map((id, i) => ({
      id,
      score: 1 - (distances[i] ?? 0),
      text: documents[i] ?? "",
      metadata: metadatas[i] ?? { kind: "", title: "", source_case_id: null, tags: [] },
    }));
  }
}

// ---------- 真容器冒烟能力探测（票 16 msbProbe 先例） ----------

export type ProbeResult = { ok: true } | { ok: false; reason: string };

/** chroma 容器可达才允许真冒烟；否则显式带原因返回（测试据此 skip 并打印）。
 *  CI 无 docker/容器 → 显式 skip 是合法结局，绝不静默装绿。
 *  默认宿主口 18000（compose 映射 18000:8000；8000 高频占用，见 compose 注释）。 */
export async function chromaSmokeProbe(baseUrl?: string): Promise<ProbeResult> {
  const base = (baseUrl ?? process.env.KB_CHROMA_SMOKE_URL ?? "http://127.0.0.1:18000").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/v2/heartbeat`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, reason: `chroma heartbeat http_${res.status}（${base}）` };
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: `chroma 容器不可达（${base}）——真容器冒烟 skip（CI 无 docker，显式 skip 留痕。` +
        "要跑：docker compose up -d chroma 后重跑本文件）",
    };
  }
}
