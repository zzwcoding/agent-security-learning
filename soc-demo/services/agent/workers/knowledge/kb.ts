// m7 检索面 → m4 分诊 KB 视图的 adapter（票 17）。
//
// m4 卡依赖 m7 检索面（票 13 用 MemoryKb stub 打桩）。票 17 落真检索面后，生产装配
// 用本 adapter 实现 TriageKb：host/path/user 拼成查询文本 → 向量检索 top-k=5（决策
// 记录 #6）→ 映射成 KbHit。INV-5 在这里不必再查状态——检索面里只有 kb_write（人审
// 批准后）放进去的条目，proposed/rejected 物理不可见。
//
// 可用性口径（PRD §6-M7 异常与边界）：检索 0 命中/检索面不可达 → 正常降级（等价无 KB）
// ——知识库是提速件不是安全闸，chroma 病了不该打死分诊 run；告警照走，M2 侧提案照提。
import type { KbHit } from "../triage/prompt.js";
import type { KbLookupParams, TriageKb } from "../triage/kb.js";
import { KB_TOP_K, type VectorStore } from "./vector-store.js";

export class ChromaKb implements TriageKb {
  private readonly store: VectorStore;
  private readonly k: number;

  constructor(store: VectorStore, k: number = KB_TOP_K) {
    this.store = store;
    this.k = k;
  }

  async lookup(params: KbLookupParams): Promise<KbHit[]> {
    const q = [params.host, params.path, params.user].filter(Boolean).join(" ");
    if (!q) return [];
    let hits;
    try {
      hits = await this.store.query(q, this.k);
    } catch (e) {
      // fail-open（可用性）：检索面病了 → 等价无 KB（PRD 异常与边界），留下可见痕迹
      console.warn(`[kb] 检索面不可达，降级为 0 命中：${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
    return hits.map((h) => ({ kind: h.metadata.kind, title: h.metadata.title, body: h.text }));
  }
}
