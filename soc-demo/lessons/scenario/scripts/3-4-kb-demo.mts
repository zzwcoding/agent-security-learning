// 场景 3 步 3.4 教具：检索面解剖（vector-store seam / hashEmbedding / top-k / INV-5）。
//
// 运行（栈起着、chroma 可达时全量；否则 S3/S4 自动降级说明）：
//   cd services/agent && pnpm exec tsx ../../lessons/scenario/scripts/3-4-kb-demo.mts
//
// 四幕：
//   S1  hashEmbedding 确定性 —— 同文本同向量、异文本异向量（词面语义的根基）
//   S2  MemoryVectorStore top-k —— 内存替身上的余弦排序与 k 截断
//   S3  RealChromaClient 真容器 —— 对着 3.3 正门入库的那条 env_fact 打真实查询
//   S4  ChromaKb 视角 —— 分诊 kb_check 眼里的同一个检索面（KbHit 映射 + fail-open）
import { MemoryVectorStore, RealChromaClient, chromaSmokeProbe, hashEmbedding, tokenize, KB_TOP_K,
         type VectorStore } from "../../../services/agent/workers/knowledge/vector-store.js";
import { ChromaKb } from "../../../services/agent/workers/knowledge/kb.js";

const CHROMA_BASE = process.env.KB_CHROMA_SMOKE_URL ?? "http://127.0.0.1:18000";

function head(title: string): void {
  console.log(`\n━━━ ${title} ━━━`);
}

// ---------- S1 hashEmbedding 确定性 ----------
head("S1 · hashEmbedding：同文本必得同向量（离线确定性）");
const a1 = hashEmbedding("环境事实：centos7 授权红队演练");
const a2 = hashEmbedding("环境事实：centos7 授权红队演练");
const b1 = hashEmbedding("处置 runbook：web-01 webshell 取证");
const same = a1.every((v, i) => v === a2[i]);
const dot = a1.reduce((s, v, i) => s + v * b1[i], 0);
console.log(`同文本向量逐位一致: ${same}`);
console.log(`分词样例（ascii 词 + 中文单字）: ${JSON.stringify(tokenize("centos7 演练").slice(0, 8))} …`);
console.log(`异文本余弦相似度: ${dot.toFixed(4)}（词面无交集 → 接近 0）`);

// ---------- S2 MemoryVectorStore：top-k 与确定性排序 ----------
head("S2 · MemoryVectorStore：余弦排序 + k 截断（单测替身同款语义）");
const mem: VectorStore = new MemoryVectorStore();
await mem.upsert({ id: "kb_A", text: "环境事实：centos7 授权红队演练（DX-2026-09）", metadata: { kind: "env_fact", title: "环境事实 centos7", source_case_id: "case_000004", tags: ["centos7"] } });
await mem.upsert({ id: "kb_B", text: "处置 runbook：web-01 webshell 取证与遏制", metadata: { kind: "runbook", title: "runbook web-01", source_case_id: "case_000003", tags: ["web-01"] } });
await mem.upsert({ id: "kb_C", text: "FP 模式：db-01 fim 告警为运维噪声", metadata: { kind: "fp_pattern", title: "FP db-01", source_case_id: "case_000001", tags: ["db-01"] } });
for (const k of [5, 2]) {
  const hits = await mem.query("centos7 演练 是否授权", k);
  console.log(`k=${k}: ${hits.map((h) => `${h.id}(score=${h.score.toFixed(3)})`).join("  ") || "(空)"}`);
}

// ---------- S3 RealChromaClient：真容器、真 REST ----------
head("S3 · RealChromaClient：对真 chroma 打查询（3.3 正门入库的那条）");
const probe = await chromaSmokeProbe(CHROMA_BASE);
if (!probe.ok) {
  console.log(`[skip] ${probe.reason}`);
} else {
  const real = new RealChromaClient({ baseUrl: CHROMA_BASE });
  for (const q of ["centos7 演练 授权", "web-01 webshell 攻击取证", "量子纠缠态"]) {
    const hits = await real.query(q, KB_TOP_K);
    console.log(
      `q="${q}"  top-${KB_TOP_K}: ` +
      (hits.length
        ? hits.map((h) => `${h.id.slice(0, 11)}(score=${h.score.toFixed(3)}, ${h.metadata.kind})`).join("  ")
        : "(0 命中)"),
    );
  }
}

// ---------- S4 ChromaKb：分诊 kb_check 眼里的检索面 ----------
head("S4 · ChromaKb：KbHit 映射 + 检索面病了降级为 0 命中（fail-open）");
if (!probe.ok) {
  console.log(`[skip] ${probe.reason}`);
} else {
  const chromaKb = new ChromaKb(new RealChromaClient({ baseUrl: CHROMA_BASE }));
  const hits = await chromaKb.lookup({ host: "centos7", path: "/var/log/secure", user: "root" });
  console.log(`lookup({host:"centos7", path:"/var/log/secure", user:"root"}) → 查询文本 "centos7 /var/log/secure root"`);
  for (const h of hits) {
    console.log(`  命中: kind=${h.kind} | ${h.title} | body 前 40 字: ${h.body.slice(0, 40)}…`);
  }
  if (hits.length === 0) console.log("  (0 命中——分诊照走，R1 KB 优先不触发)");
}
// ---------- 附：任意查询探针（捣乱实验 A 用）----------
// 用法：pnpm exec tsx ../../lessons/scenario/scripts/3-4-kb-demo.mts "任意查询文本"
const probeQuery = process.argv[2];
if (probeQuery && probe.ok) {
  head(`附 · 任意查询探针："${probeQuery}"`);
  const real = new RealChromaClient({ baseUrl: CHROMA_BASE });
  const hits = await real.query(probeQuery, KB_TOP_K);
  console.log(
    hits.length
      ? hits.map((h) => `${h.id.slice(0, 11)}(score=${h.score.toFixed(3)}, ${h.metadata.kind})`).join("  ")
      : "(0 命中)",
  );
  console.log("读法：top-k 无分数门槛——库越空，「命中」越廉价；相关性要看 score 与自己的人脑。");
}
console.log("\n（完）INV-5 现场版：真容器此刻只有走正门的那一条——chroma count 见 3-3.md 对账。");
