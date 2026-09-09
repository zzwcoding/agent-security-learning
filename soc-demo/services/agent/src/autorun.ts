// m3 内部模块 autorun（票 40·G2-9 清偿）：事件驱动自动拉起——M2 outbox 的消费循环。
//
// 线头（checkup G2-9）：alert.created 进了 outbox 没人消费（票 09 起只有生产端）、
// case.closed 同样悬空（票 17 补的 emit）。PRD 消息旅程 step4/step11 与 m3 卡接口契约
// 写的「内部触发：M2 alert.created 事件 → POST /internal/runs」在本票接通：agent 进程内
// 后台轮询 M2 事件游标，把两类事件折成对自家正门的拉起——
//   alert.created → alert_flow（分诊，TP 后同 run 链调查富化，票 36）
//   case.closed   → knowledge_flow（提炼，kb_propose → 人审闸，票 17）
// close_flow 不挂自动：SOC1 手动确认是票 39 的语义（AI 出主意，人按按钮）。
//
// 三个口径（记票）：
//   开关：EVENT_DRIVEN，缺省 on（PRD 主链路），=off 关（手动 POST /internal/runs 与
//         evals 不受影响——evals 组装 buildApp 从不经 index.ts 的生产装配）。
//   游标：消费水位持久化在 agent 自己的库（db.ts 的 event_cursors 表），重启不重放。
//   防重：即使游标丢失重放也不重复拉起（验收 INV-6）——
//     alert_flow：已有非 failed 的同对象 run → 跳过；并发双拉由票 13 verdict 锁兜底
//                 （PATCH 条件更新，同一告警只有先到者分诊）。
//     knowledge_flow：已有非 failed 的同 case run、或 M2 账面已有 proposed/approved
//                 提案 → 跳过（failed 的 run 允许重拉 = 重试语义）。
// 拉起失败（/internal/runs 非 2xx、出站病了）= at-least-once：本批中止、游标不动、
// 下轮重试——「不丢」优先于「不阻塞」，重试安全由上面的防重兜底保证。
import type { DB } from "./db.js";

/** 消费游标名（单消费者，固定一条水位线）。 */
export const AUTORUN_CURSOR = "m2_outbox";

/** 每批最多消费多少条（与 M2 pollEvents 缺省 limit 同口径）。 */
const BATCH_LIMIT = 100;

/** M2 outbox 事件（GET /api/v1/events 的 wire 行，camelCase）。 */
export interface OutboxEvent {
  id: number;
  topic: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

/** 事件读口 seam：生产 HttpOutboxReader（M2 REST），测试换内存数组。 */
export interface OutboxReader {
  eventsAfter(after: number, limit?: number): Promise<OutboxEvent[]>;
}

export class HttpOutboxReader implements OutboxReader {
  private readonly baseUrl: string;

  constructor(baseUrl = process.env.CASE_BACKEND_URL ?? "http://case-backend:3002") {
    this.baseUrl = baseUrl;
  }

  async eventsAfter(after: number, limit = BATCH_LIMIT): Promise<OutboxEvent[]> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/events?after=${encodeURIComponent(after)}&limit=${encodeURIComponent(limit)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) throw new Error(`outbox events read failed: HTTP ${res.status}`);
    const json = (await res.json()) as { events?: OutboxEvent[] };
    return json.events ?? [];
  }
}

/** 消费游标 seam：get/set 一条具名水位线。 */
export interface CursorStore {
  get(name: string): number;
  set(name: string, cursor: number): void;
}

/** 生产游标：agent 自己的 SQLite（event_cursors 表）。INSERT OR REPLACE 语义的
 *  upsert——set 重复调不炸（同批逐事件推进会写多次）。 */
export function dbCursorStore(db: DB): CursorStore {
  return {
    get(name: string): number {
      const row = db.prepare("SELECT cursor FROM event_cursors WHERE name = ?").get(name) as
        | { cursor: number }
        | undefined;
      return row ? Number(row.cursor) : 0;
    },
    set(name: string, cursor: number): void {
      db.prepare(
        "INSERT INTO event_cursors (name, cursor) VALUES (?, ?) " +
        "ON CONFLICT(name) DO UPDATE SET cursor = excluded.cursor",
      ).run(name, cursor);
    },
  };
}

/** 拉起请求（语义形，camelCase）：index.ts 折成 /internal/runs 的 snake wire。 */
export interface LaunchReq {
  kind: "alert_flow" | "knowledge_flow";
  alertId?: string;
  caseId?: string;
}

/** 依赖注入面（全 seam）：生产装配见 index.ts，测试全换假件。 */
export interface AutorunDeps {
  events: OutboxReader;
  cursor: CursorStore;
  /** 拉起 = 打 m3 正门 /internal/runs（与手动触发同门：铸票→组图→执行→审计全在轨道上）。
   *  非 2xx/抛错 = 拉起失败。 */
  launch(req: LaunchReq): Promise<void>;
  /** 防重一（agent runs 表）：该对象已有非 failed 的同类 run → true。 */
  hasActiveRun(kind: string, refId: string): boolean;
  /** 防重二（M2 kb 账面，仅 knowledge_flow 用）：该 case 已有 proposed/approved 提案 → true。 */
  hasKbEntryForCase(caseId: string): Promise<boolean>;
  /** 结构化日志（缺省静默；生产打 console）。 */
  log?(entry: Record<string, unknown>): void;
}

/** 生产防重一：查 runs 表——同一告警/案件已有非 failed 的同类 run 就不再拉。
 *  failed 不挡（重试语义）；并发窗口由 verdict 锁（票 13）做最后兜底。 */
export function runsLookup(db: DB): (kind: string, refId: string) => boolean {
  const q = db.prepare(
    "SELECT id FROM runs WHERE kind = ? AND (alert_id = ? OR case_id = ?) AND status != 'failed' LIMIT 1",
  );
  return (kind: string, refId: string) => !!q.get(kind, refId, refId);
}

/** 生产防重二：M2 kb 账面查（GET /api/v1/kb/proposals 全量拉回按 source_case_id 过滤
 *  ——端点没有按案件过滤的参数，演示规模一次全量最省事）。只数 proposed/approved：
 *  rejected 不挡（票面口径），查询失败抛给循环按拉起失败处理（游标不动）。 */
export function makeHttpKbEntryCheck(
  baseUrl = process.env.CASE_BACKEND_URL ?? "http://case-backend:3002",
): (caseId: string) => Promise<boolean> {
  return async (caseId: string) => {
    const res = await fetch(`${baseUrl}/api/v1/kb/proposals`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`kb proposals read failed: HTTP ${res.status}`);
    const json = (await res.json()) as {
      proposals?: { source_case_id?: string | null; status?: string }[];
    };
    return (json.proposals ?? []).some(
      (p) => p.source_case_id === caseId && (p.status === "proposed" || p.status === "approved"),
    );
  };
}

export interface AutorunSkip {
  topic: string;
  refId: string;
  reason: "ignored" | "malformed_payload" | "dup_batch" | "run_exists" | "kb_exists";
}

export interface AutorunPollResult {
  /** 本批读到的事件数。 */
  scanned: number;
  /** 拉起成功的 run（`${kind}:${refId}`）。 */
  launched: string[];
  skipped: AutorunSkip[];
  /** 拉起/防重查询失败（游标停在失败事件之前，下轮重试）。 */
  failed?: { topic: string; refId: string; error: string };
  /** 推进后的游标。 */
  cursor: number;
}

type Decision =
  | { action: "launched"; kind: string; refId: string }
  | { action: "skipped"; skip: AutorunSkip }
  | { action: "failed"; error: string };

/** 单事件裁决：拉 / 跳 / 败。跳过（含坏事件、防重命中）都推进游标——它们是
 *  「想清楚了不动作」；只有失败不动游标（下轮重试）。 */
async function decide(
  e: OutboxEvent,
  deps: AutorunDeps,
  batchSeen: Map<string, Set<string>>,
): Promise<Decision> {
  if (e.topic === "alert.created") {
    const alertId = typeof e.payload.alertId === "string" ? e.payload.alertId : "";
    if (!alertId) return { action: "skipped", skip: { topic: e.topic, refId: "", reason: "malformed_payload" } };
    const seen = batchSeen.get("alert_flow") ?? new Set<string>();
    if (seen.has(alertId)) return { action: "skipped", skip: { topic: e.topic, refId: alertId, reason: "dup_batch" } };
    if (deps.hasActiveRun("alert_flow", alertId)) {
      return { action: "skipped", skip: { topic: e.topic, refId: alertId, reason: "run_exists" } };
    }
    try {
      await deps.launch({ kind: "alert_flow", alertId });
    } catch (err) {
      return { action: "failed", error: String(err) };
    }
    seen.add(alertId);
    batchSeen.set("alert_flow", seen);
    return { action: "launched", kind: "alert_flow", refId: alertId };
  }
  if (e.topic === "case.closed") {
    const caseId = typeof e.payload.caseId === "string" ? e.payload.caseId : "";
    if (!caseId) return { action: "skipped", skip: { topic: e.topic, refId: "", reason: "malformed_payload" } };
    const seen = batchSeen.get("knowledge_flow") ?? new Set<string>();
    if (seen.has(caseId)) return { action: "skipped", skip: { topic: e.topic, refId: caseId, reason: "dup_batch" } };
    if (deps.hasActiveRun("knowledge_flow", caseId)) {
      return { action: "skipped", skip: { topic: e.topic, refId: caseId, reason: "run_exists" } };
    }
    try {
      if (await deps.hasKbEntryForCase(caseId)) {
        return { action: "skipped", skip: { topic: e.topic, refId: caseId, reason: "kb_exists" } };
      }
      await deps.launch({ kind: "knowledge_flow", caseId });
    } catch (err) {
      return { action: "failed", error: String(err) };
    }
    seen.add(caseId);
    batchSeen.set("knowledge_flow", seen);
    return { action: "launched", kind: "knowledge_flow", refId: caseId };
  }
  return { action: "skipped", skip: { topic: e.topic, refId: "", reason: "ignored" } };
}

/** 消费一轮：读一批 → 逐事件裁决 → 逐事件推游标（崩在批中间最多重放尾部，防重兜底）。 */
export async function pollAutorunOnce(deps: AutorunDeps): Promise<AutorunPollResult> {
  let cursor = deps.cursor.get(AUTORUN_CURSOR);
  const batch = await deps.events.eventsAfter(cursor, BATCH_LIMIT);
  const res: AutorunPollResult = { scanned: batch.length, launched: [], skipped: [], cursor };
  const batchSeen = new Map<string, Set<string>>();
  for (const e of batch) {
    const d = await decide(e, deps, batchSeen);
    if (d.action === "failed") {
      res.failed = { topic: e.topic, refId: String(e.payload.alertId ?? e.payload.caseId ?? ""), error: d.error };
      deps.log?.({ warn: "autorun_launch_failed", topic: e.topic, after: cursor, error: d.error });
      break; // 游标不动，下轮从失败事件重试（at-least-once）
    }
    cursor = e.id;
    deps.cursor.set(AUTORUN_CURSOR, cursor);
    if (d.action === "launched") {
      res.launched.push(`${d.kind}:${d.refId}`);
      deps.log?.({ info: "autorun_launched", kind: d.kind, refId: d.refId, event: e.id });
    } else {
      res.skipped.push(d.skip);
    }
  }
  res.cursor = cursor;
  return res;
}

/** 常驻循环：立即跑第一轮，之后每 intervalMs 一轮。串行不重叠（上轮跑完才排下轮）；
 *  轮询抛错只记日志不中断（M2 病了下轮再来）。stop 可重入。 */
export function startAutorun(deps: AutorunDeps, opts: { intervalMs?: number } = {}): { stop(): void } {
  const intervalMs = opts.intervalMs ?? 2000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await pollAutorunOnce(deps);
    } catch (err) {
      deps.log?.({ warn: "autorun_poll_failed", error: String(err) });
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  void tick();
  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** 开关解析（验收：可开关）：EVENT_DRIVEN 缺省 on（PRD 消息旅程主链路），=off 关。
 *  关掉只影响这个自动触发源——手动 POST /internal/runs 与 evals 组装面照旧。 */
export function eventDrivenEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.EVENT_DRIVEN ?? "on") !== "off";
}
