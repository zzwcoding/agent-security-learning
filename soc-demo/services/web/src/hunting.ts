// 狩猎页状态层（票 82，pipeline.ts 同款纪律：纯函数归约/重建，React 之外可单测）。
//
// 数据面只有页面映射「狩猎页」六行的落点（零 Web 专属接口）：
//   轮次视图 = m2 假设详情读面（轮次归集段，权威账面） + m2 审计（objectType=hypothesis
//   条目里的父 run 锚，details.run_id / requestId hunt_<run_id>） + m3 SSE（流水线页
//   同款 /api/v1/events/stream，INV-7 落盘总线）。
//   实时推进的分工：SSE 是「发生了什么」的信号（组合声明/子 run 回归/轮间接力/run 状态
//   镜像），账面数字一律以详情读面为准——页面在关键帧后重取详情，本模块只管把帧归约成
//   可渲染的轻状态 + 把重建所需的两半（详情段+审计锚）装配成轮次卡视图。
import type { SseEvent } from "./sse";

/** 假设五态（CONTEXT.md 语义核心 / case-backend statemachine TRANSITIONS.hypothesis）。 */
export const HYPOTHESIS_STATUSES = ["proposed", "hunting", "concluded", "refuted", "cancelled"] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];

/** 五态 Tag 档（label 人话 + antd color）；未知态在页面侧落「未知」不崩。 */
export const HYPOTHESIS_STATUS_META: Record<HypothesisStatus, { label: string; color: string }> = {
  proposed: { label: "待开跑", color: "default" },
  hunting: { label: "狩猎中", color: "processing" },
  concluded: { label: "已命中", color: "green" },
  refuted: { label: "已证伪", color: "orange" },
  cancelled: { label: "已取消", color: "default" },
};

export interface AuditEntryLike {
  id: string;
  action: string;
  actor?: unknown;
  objectType: string;
  objectId: string;
  details: Record<string, unknown>;
  requestId: string;
  result: string;
  createdAt: number;
}

/** 轮次视图卡（页面渲染的最小形状；wire 透传字段保持 snake_case 与 m2 出线同形）。 */
export interface HuntRoundView {
  roundNo: number;
  /** 组合 C_k（planner 产物 [{tool,params,rationale}]，原样透传）。 */
  tasks: unknown[];
  /** N 个子 run 状态（[{run_id,status}]）。 */
  children: { run_id: string; status: string }[];
  /** judge 裁决（JudgeOutput {sufficient,verdict,confidence,gap_description}；缺席 null）。 */
  judge: unknown;
  hasJudge: boolean;
  verdict: string | null;
  /** gap 缺口（GapOutput {gap_description,unknown,suggested_focus}；缺席 null）。 */
  gap: unknown;
  /** 该轮父 hunt_flow run（审计锚重建；SSE 断线重订阅用）。 */
  runId: string | null;
  /** 轮间接力在途（round_relay 已知下一轮、详情归集段还没到）：占位卡，不猜数。 */
  pending: boolean;
}

export interface HypothesisDetailLike {
  id: string;
  status: string;
  rounds: {
    round_no: number;
    tasks: unknown[];
    children: { run_id: string; status: string }[];
    judge: unknown;
    gap: unknown;
  }[];
}

/** 父 run 锚：五要素 details.run_id 优先，退回 requestId 的 hunt_<run_id> 关联
 *  （orchestration/audit-log.ts 的 requestId 口径——planner DENIED 等无 run_id 字段的
 *  条目也能归位到发出它的轮次 run）。都不是 → null（不猜）。 */
export function runAnchorOf(entry: AuditEntryLike): string | null {
  const runId = (entry.details as Record<string, unknown> | undefined)?.run_id;
  if (typeof runId === "string" && runId) return runId;
  if (typeof entry.requestId === "string" && entry.requestId.startsWith("hunt_")) {
    return entry.requestId.slice("hunt_".length) || null;
  }
  return null;
}

/** 审计 → 轮号 → 父 run 锚。只吃 objectType=hypothesis 的条目（run 对象条目另有语义），
 *  按 createdAt 升序后写覆盖（同轮多次上报取最新）。 */
export function roundRunAnchors(
  detail: HypothesisDetailLike,
  audit: AuditEntryLike[],
): Record<number, string> {
  void detail;
  const anchors: Record<number, string> = {};
  for (const e of [...audit].sort((a, b) => a.createdAt - b.createdAt)) {
    if (e.objectType !== "hypothesis") continue;
    const runId = runAnchorOf(e);
    if (!runId) continue;
    const rn = (e.details as Record<string, unknown> | undefined)?.round_no;
    if (typeof rn === "number" && rn >= 1) anchors[rn] = runId;
  }
  return anchors;
}

function verdictOf(judge: unknown): string | null {
  const v = (judge as Record<string, unknown> | undefined)?.verdict;
  return typeof v === "string" ? v : null;
}

/** 断线刷新重建（页面映射「轮次视图」行的「run 行+审计」半边）：
 *  详情轮次归集段（权威账面）+ 审计父 run 锚 → 每轮卡视图。
 *  pendingRoundNo：SSE 已见 round_relay 的下一轮——详情还没这轮时给占位卡（如实标注，
 *  不编造组合/子 run）。 */
export function rebuildRoundViews(
  detail: HypothesisDetailLike,
  audit: AuditEntryLike[],
  opts: { pendingRoundNo?: number | null } = {},
): HuntRoundView[] {
  const anchors = roundRunAnchors(detail, audit);
  const known = new Set(detail.rounds.map((r) => r.round_no));
  const views: HuntRoundView[] = detail.rounds.map((r) => ({
    roundNo: r.round_no,
    tasks: r.tasks,
    children: r.children,
    judge: r.judge,
    hasJudge: r.judge !== null && r.judge !== undefined,
    verdict: verdictOf(r.judge),
    gap: r.gap,
    runId: anchors[r.round_no] ?? null,
    pending: false,
  }));
  const pending = opts.pendingRoundNo ?? null;
  if (pending !== null && !known.has(pending)) {
    views.push({ roundNo: pending, tasks: [], children: [], judge: null, hasJudge: false, verdict: null, gap: null, runId: null, pending: true });
  }
  return views.sort((a, b) => a.roundNo - b.roundNo);
}

// ---- SSE 实时归约（复用 ./sse 事件总线客户端）----

export interface HuntLogEntry {
  id: number;
  type: string;
  text: string;
  ts: number;
  /** 账面相关帧（声明/回归/接力/状态镜像/出错）：页面在关键帧后重取 m2 详情的触发器。 */
  ledger?: boolean;
}

export interface HuntLiveState {
  /** INV-7 游标：同 id 重放/游标内乱序帧不二次应用（恰一次的归约侧半边）。 */
  lastEventId: number;
  /** 订阅中父 run 的状态（audit 镜像 status.to，CONTEXT.md 语义核心）。 */
  runStatus: string | null;
  failed: boolean;
  /** round_no → dispatch 声明的子 run ids（hunt_children_declared）。 */
  declared: Record<string, string[]>;
  /** round_no → await_children 回归的子 run 终态（hunt_children_joined）。 */
  joined: Record<string, { run_id: string; status: string }[]>;
  /** round_relay 见到的下一轮号（轮间接力在途信号）。 */
  relayedTo: number | null;
  log: HuntLogEntry[]; // 新到在上，封顶 200 条（流水线页同款）
}

const LOG_CAP = 200;

export function initHuntLive(): HuntLiveState {
  return { lastEventId: 0, runStatus: null, failed: false, declared: {}, joined: {}, relayedTo: null, log: [] };
}

function describe(type: string, payload: Record<string, unknown>): string {
  if (type === "error") return `出错：${String(payload.message ?? payload.code ?? "?")}`;
  const action = payload.action;
  if (action === "hunt_children_declared") {
    const n = Array.isArray(payload.children) ? payload.children.length : 0;
    return `第 ${String(payload.round_no)} 轮组合已扇出（${n} 个子 run）`;
  }
  if (action === "hunt_children_joined") {
    const n = Array.isArray(payload.children) ? payload.children.length : 0;
    return `第 ${String(payload.round_no)} 轮子取证回归（${n} 个）`;
  }
  if (action === "round_relay") return `接力：下一轮 第 ${String(payload.next_round)} 轮已拉起`;
  const to = (payload.status as { to?: string } | undefined)?.to;
  if (to) return `run 状态：${(payload.status as { from?: string }).from ?? "?"} → ${to}`;
  return `审计：${String(action ?? "?")}`;
}

/** 账面相关帧判定：组合声明/子 run 回归/轮间接力/run 状态镜像/error——
 *  这些帧意味着 m2 详情读面的轮次段已变或将变，页面据此重取账面。 */
export function isLedgerFrame(type: string, payload: Record<string, unknown>): boolean {
  if (type === "error") return true;
  if (type !== "audit") return false;
  const a = payload.action;
  return (
    a === "hunt_children_declared" ||
    a === "hunt_children_joined" ||
    a === "round_relay" ||
    (payload.status !== undefined && typeof (payload.status as { to?: string }).to === "string")
  );
}

/** 归约一个事件 → 新状态（不可变；INV-7 恰一次：ev.id ≤ 游标的帧原样返回）。 */
export function applyHuntEvent(st: HuntLiveState, ev: SseEvent): HuntLiveState {
  if (ev.id > 0 && ev.id <= st.lastEventId) return st;
  const { type, payload } = ev;

  let declared = st.declared;
  let joined = st.joined;
  let relayedTo = st.relayedTo;
  let runStatus = st.runStatus;

  if (type === "audit") {
    if (payload.action === "hunt_children_declared" && typeof payload.round_no === "number") {
      declared = { ...declared, [String(payload.round_no)]: (payload.children as string[]) ?? [] };
    } else if (payload.action === "hunt_children_joined" && typeof payload.round_no === "number") {
      joined = {
        ...joined,
        [String(payload.round_no)]: ((payload.children as { run_id: string; status: string }[]) ?? []).map((c) => ({
          run_id: c.run_id,
          status: c.status,
        })),
      };
    } else if (payload.action === "round_relay" && typeof payload.next_round === "number") {
      relayedTo = payload.next_round;
    } else if (payload.status && typeof (payload.status as { to?: string }).to === "string") {
      runStatus = (payload.status as { to: string }).to;
    }
  }

  const entry: HuntLogEntry = {
    id: ev.id,
    type,
    text: describe(type, payload),
    ts: ev.ts,
    ...(isLedgerFrame(type, payload) ? { ledger: true } : {}),
  };
  return {
    lastEventId: Math.max(st.lastEventId, ev.id),
    runStatus,
    failed: st.failed || type === "error",
    declared,
    joined,
    relayedTo,
    log: [entry, ...st.log].slice(0, LOG_CAP),
  };
}
