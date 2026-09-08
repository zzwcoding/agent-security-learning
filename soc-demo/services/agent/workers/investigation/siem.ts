// m5 调查 worker · SIEM 后端 seam + fixture 告警集检索 adapter（票 14）。
//
// m5 卡 Seam：「SIEM 后端（adapter：fixture 告警集检索 / 将来真 Wazuh）」。
// demo 阶段拿 fixtures/alerts/ 的 11 条真 Wazuh 告警当 SIEM 语料——FR-M5.1
// 「按实体（ip/user/host）+ 强制时间窗的 pivot 查询，后端为 fixture 告警集的
// 全文/字段检索」。换真 Wazuh 时只换 adapter，循环与闸一行不动（tracer bullet）。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type EntityType = "ip" | "user" | "host";

/** PRD §6-M5 mock SIEM 工具签名（LLM tool schema 的执行侧参数）。 */
export interface SiemQueryParams {
  entity_type: EntityType;
  entity: string;
  time_window: { from: string; to: string };
  max_results?: number;
}

export interface SiemHit {
  id: string;
  timestamp: string;
  rule_id: string;
  rule_description: string;
  agent_name: string;
  full_log: string;
}

export interface SiemResult {
  total: number;
  hits: SiemHit[];
}

export interface SiemBackend {
  query(params: SiemQueryParams): Promise<SiemResult>;
}

interface CorpusEvent {
  timestamp?: unknown;
  id?: unknown;
  rule?: { id?: unknown; description?: unknown };
  agent?: { name?: unknown };
  data?: { srcip?: unknown; srcuser?: unknown };
  full_log?: unknown;
}

const DEFAULT_MAX_RESULTS = 50;

/** 字段检索（结构化实体字段）+ 全文检索（full_log 包含）双口径，任一命中即算。 */
function matchesEntity(w: CorpusEvent, entityType: EntityType, entity: string): boolean {
  const fullLog = typeof w.full_log === "string" ? w.full_log : "";
  if (fullLog.includes(entity)) return true; // 全文口径
  if (entityType === "ip") return w.data?.srcip === entity;
  if (entityType === "user") return w.data?.srcuser === entity;
  return w.agent?.name === entity;
}

export class FixtureSiem implements SiemBackend {
  private readonly corpusDir: string;
  private cache: CorpusEvent[] | null = null;

  constructor(corpusDir: string) {
    this.corpusDir = corpusDir;
  }

  private corpus(): CorpusEvent[] {
    if (!this.cache) {
      this.cache = readdirSync(this.corpusDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(this.corpusDir, f), "utf8")) as CorpusEvent);
    }
    return this.cache;
  }

  async query(params: SiemQueryParams): Promise<SiemResult> {
    const from = Date.parse(params.time_window.from);
    const to = Date.parse(params.time_window.to);
    const hits = this.corpus()
      .filter((w) => typeof w.timestamp === "string")
      .map((w) => ({
        raw: w,
        ts: Date.parse(w.timestamp as string),
        id: typeof w.id === "string" ? w.id : "",
        ruleId: typeof w.rule?.id === "string" || typeof w.rule?.id === "number" ? String(w.rule.id) : "",
        desc: typeof w.rule?.description === "string" ? w.rule.description : "",
        agent: typeof w.agent?.name === "string" ? w.agent.name : "",
        fullLog: typeof w.full_log === "string" ? w.full_log : "",
      }))
      .filter((e) => e.ts >= from && e.ts <= to)
      .filter((e) => matchesEntity(e.raw, params.entity_type, params.entity))
      .sort((a, b) => a.ts - b.ts);

    const sliced = hits.slice(0, params.max_results ?? DEFAULT_MAX_RESULTS);
    return {
      total: hits.length,
      hits: sliced.map((e) => ({
        id: e.id,
        timestamp: new Date(e.ts).toISOString(),
        rule_id: e.ruleId,
        rule_description: e.desc,
        agent_name: e.agent,
        full_log: e.fullLog,
      })),
    };
  }
}
