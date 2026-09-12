// m3 内部模块 run-dispatcher（票 47·ADR 0004-1 裁决 1）：run 异步化的分发循环。
//
// 同步时代的形态：POST /internal/runs 在请求内直跑到终态才 202——HTTP 客户端替
// supervisor 背了整个执行期。本票翻转时序：POST 落 queued 即秒回，执行由本循环在
// agent 进程内接管（autorun.ts 同款后台轮询形态，票 40 先例）。
//
// 队列是什么（ADR 0004-1：不引入消息中间件产品）：agent 自持 SQLite。
//   start  诉求 ← POST /internal/runs（chat_flow 除外，见 app.ts 的同步口径）
//   resume 诉求 ← 审批裁决落卡（approve/reject 秒回，续跑进队）
// 两种诉求统一落 run_jobs 表（runs.status='queued' 是 run 自己的生命周期态，
// awaiting_approval→queued 不是合法迁移——CONTEXT.md 状态机一字不动，所以 resume
// 的「待办」必须有自己的落点）。消费循环每轮：①扫审批卡保质期 ②在并发上限内领任务执行。
//
// 记票口径（本票定夺，非拍脑袋）：
//   并发上限：RUN_DISPATCH env，缺省 1；非正整数一律回 1（不猜）。
//   优雅停机：stop() 不再领新任务，等在跑任务落定再返回（app.close 钩子兜底）。
//   进程被杀的孤儿：重启恢复（recoverDispatcherState）把孤儿 running 判
//     failed(reason=orphaned_by_restart) 而不是重置 queued 重跑——重跑会让图从头
//     重放节点，M2 时间线/审计重复留痕；failed 在 autorun 防重口径里允许重拉
//     （事件再来自动补跑），人工场景也能从 Web 直接看到失败原因。
//   resume 重复诉求：同 run 未完结的 resume 任务复用一条（陈旧双批不叠加执行）。
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import type { AuditSink } from "./audit.js";
import type { RunCtx } from "./runs.js";
import { transitionRun } from "./runs.js";
import { emitEvent } from "./events.js";
import { runKindOf } from "./run-kinds.js";
import { expireApprovalCard, listDeclaredPendingApprovals, listExpiredPendingApprovals, type ApprovalGateway } from "./approvals.js";

/** 任务动作：start = 从 queued 开跑；resume = 从审批挂起处续跑。 */
export type RunJobAction = "start" | "resume";

export interface RunJobRow {
  id: number;
  runId: string;
  action: RunJobAction;
  /** 入队时的附加态（JSON）：start 带 actor（票 39 确认审计记人头，异步后请求头
   *  早没了，只能随任务落盘）；resume 无附加态（决定在审批卡上，重启照读）。 */
  payload: Record<string, unknown> | null;
  state: "pending" | "claimed" | "done";
  createdAt: number;
  claimedAt: number | null;
}

const nowMs = () => Date.now();

function mapJob(row: Record<string, unknown> | undefined): RunJobRow | null {
  if (!row) return null;
  return {
    id: row.id as number,
    runId: row.run_id as string,
    action: row.action as RunJobAction,
    payload: row.payload ? (JSON.parse(row.payload as string) as Record<string, unknown>) : null,
    state: row.state as RunJobRow["state"],
    createdAt: row.created_at as number,
    claimedAt: (row.claimed_at as number | null) ?? null,
  };
}

/** 入队（start 不去重：一个 run 一个 start；resume 去重：同 run 未完结的复用一条）。 */
export function enqueueRunJob(
  db: DB,
  runId: string,
  action: RunJobAction,
  payload?: Record<string, unknown>,
): RunJobRow {
  if (action === "resume") {
    const existing = mapJob(
      db
        .prepare("SELECT * FROM run_jobs WHERE run_id = ? AND action = 'resume' AND state != 'done' ORDER BY id LIMIT 1")
        .get(runId) as Record<string, unknown>,
    );
    if (existing) return existing;
  }
  const res = db
    .prepare("INSERT INTO run_jobs (run_id, action, payload, state, created_at) VALUES (?, ?, ?, 'pending', ?)")
    .run(runId, action, payload ? JSON.stringify(payload) : null, nowMs());
  return mapJob(
    db.prepare("SELECT * FROM run_jobs WHERE id = ?").get(res.lastInsertRowid) as Record<string, unknown>,
  ) as RunJobRow;
}

/** 领任务（事务内 pending→claimed，防双吃）：FIFO，一次最多 limit 条。
 *  返回的行已是 claimed 态（领取即认账，返回值与库面一致）。 */
export function claimRunJobs(db: DB, limit: number): RunJobRow[] {
  return db.transaction(() => {
    const rows = (
      db.prepare("SELECT * FROM run_jobs WHERE state = 'pending' ORDER BY id LIMIT ?").all(limit) as Record<string, unknown>[]
    ).map((r) => mapJob(r) as RunJobRow);
    const at = nowMs();
    for (const j of rows) {
      db.prepare("UPDATE run_jobs SET state = 'claimed', claimed_at = ? WHERE id = ?").run(at, j.id);
      j.state = "claimed";
      j.claimedAt = at;
    }
    return rows;
  })();
}

/** 完结任务（成功/失败/跳过都算消费完毕——毒丸不重试，重试是 autorun 的事）。 */
export function completeRunJob(db: DB, id: number): void {
  db.prepare("UPDATE run_jobs SET state = 'done' WHERE id = ?").run(id);
}

// ---------- env 解析（fail-closed 缺省，不猜） ----------

/** 消费循环并发上限：RUN_DISPATCH，缺省 1；非正整数回 1。 */
export function runDispatchConcurrency(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.RUN_DISPATCH ?? 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** 审批卡保质期秒数：APPROVAL_TTL_SECONDS，缺省 86400（一天）；非有限正数回缺省。 */
export function approvalTtlSecondsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.APPROVAL_TTL_SECONDS ?? 86400);
  return Number.isFinite(n) && n > 0 ? n : 86400;
}

// ---------- 启动恢复：进程被杀后的盘面收口（记票口径见文件头） ----------

export interface RecoveryResult {
  /** 回到 pending 的任务 id（claimed 没人认领 → 回队）。 */
  requeued: number[];
  /** 判孤儿失败的 run id（running → failed(orphaned_by_restart)）。 */
  failed: string[];
}

/** 重启恢复（startRunDispatcher 开工前跑一次；单进程部署假设：此刻没有别人在跑）：
 *  ① claimed 任务回 pending（claimed 是进程内的手，进程没了手就松开）；
 *  ② 孤儿 running → failed + 审计 + error 事件（不重置 queued：重放节点会重复留痕）；
 *  ③ run 已不在 queued 的 start 任务直接完结（run 都终局了，start 没有意义）。 */
export function recoverDispatcherState(db: DB, ctx: RunCtx): RecoveryResult {
  return db.transaction(() => {
    const claimed = db.prepare("SELECT id FROM run_jobs WHERE state = 'claimed'").all() as { id: number }[];
    for (const { id } of claimed) {
      db.prepare("UPDATE run_jobs SET state = 'pending', claimed_at = NULL WHERE id = ?").run(id);
    }
    const orphans = db.prepare("SELECT id FROM runs WHERE status = 'running'").all() as { id: string }[];
    const failed: string[] = [];
    for (const { id } of orphans) {
      transitionRun(db, id, "failed", ctx, "orphaned_by_restart");
      // 迁移审计（transitionRun 的 SUCCESS）之外再落一条强杀 FAILURE——与 runFlow
      // 的 kill 同口径：这 不是正常的状态推进，是兜底收口（INV-8 可回放）
      ctx.audit.record({
        action: "kill",
        actor: ctx.actor ?? { type: "system", id: "m3:dispatcher" },
        objectId: id,
        objectType: "run",
        details: { code: "orphaned_by_restart", status: { from: "running", to: "failed" } },
        requestId: ctx.requestId,
        result: "FAILURE",
        createdAt: Date.now(),
      });
      emitEvent(db, id, "error", { code: "orphaned_by_restart", message: "进程重启：上次执行中断，按失败收口（可重拉）" });
      failed.push(id);
    }
    // 孤儿已终局，它们的 start 任务随之作废（防止恢复后从头重放节点）
    for (const { id } of orphans) {
      db.prepare(
        "UPDATE run_jobs SET state = 'done' WHERE run_id = ? AND action = 'start' AND state != 'done'",
      ).run(id);
    }
    return { requeued: claimed.map((c) => c.id), failed };
  })();
}

// ---------- 消费循环 ----------

/** 分发循环依赖面（全 seam）：execute 由装配层注入（app.ts：铸票组图 + executeRun/resumeRun）；
 *  测试换假件（本文件测试从不执行真图）。 */
export interface RunDispatcherDeps {
  db: DB;
  audit: AuditSink;
  /** 执行一个已领取的任务。抛错 = 本任务失败（完结不重试，循环不崩）。 */
  execute(job: RunJobRow): Promise<void>;
  /** 并发上限（每轮最多领几个任务；缺省读 RUN_DISPATCH，默认 1）。 */
  concurrency?: number;
  /** 审批卡保质期秒数（缺省读 APPROVAL_TTL_SECONDS，默认 86400）。 */
  approvalTtlSeconds?: number;
  /** 狗粮票 58（G9 对账）：审批外接端口（生产 = JiaoTuApprovalGateway）。在位时对
   *  已申报椒图且仍 pending 的卡用公开面对账——椒图 900s 先过期而本地 TTL（86400s）
   *  未到时本地镜像结算，run 不永远挂在 awaiting_approval。未传 = 内部模式跳过。 */
  approvalGateway?: ApprovalGateway;
  /** 结构化日志（缺省静默；生产打 console）。 */
  log?(entry: Record<string, unknown>): void;
}

export interface DispatchTickResult {
  /** 本轮扫掉的超时审批卡 id。 */
  expired: string[];
  /** 执行完的任务。 */
  executed: { id: number; runId: string; action: RunJobAction }[];
  /** 领了但没执行（run 不在可执行态等——陈旧诉求的安静收口）。 */
  skipped: { id: number; runId: string; action: RunJobAction; reason: string }[];
  /** 执行抛错的任务（任务已完结，错误只进日志面）。 */
  failed: { id: number; runId: string; error: string }[];
}

/** 分发循环的一轮：先扫审批卡保质期（时间出的裁决优先），再在并发上限内领任务执行。
 *  execute 抛错按任务完结处理（毒丸不崩循环、不无限重试）。 */
export async function dispatchOnce(deps: RunDispatcherDeps): Promise<DispatchTickResult> {
  const ctx: RunCtx = {
    audit: deps.audit,
    requestId: `dispatch_${randomUUID()}`,
    actor: { type: "system", id: "m3:dispatcher" },
  };
  const res: DispatchTickResult = { expired: [], executed: [], skipped: [], failed: [] };

  // ① 审批卡保质期：超时 pending 卡自动作废 → run failed(approval_expired) + 审计
  const ttl = deps.approvalTtlSeconds ?? approvalTtlSecondsFromEnv();
  for (const card of listExpiredPendingApprovals(deps.db, ttl)) {
    try {
      expireApprovalCard(deps.db, card.id, ctx, ttl);
      res.expired.push(card.id);
      deps.log?.({ info: "approval_expired", approval_id: card.id, run_id: card.runId });
    } catch (err) {
      // 竞态兜底（卡刚被裁决等）：状态机会抛 409——下轮再看，不崩循环
      deps.log?.({ warn: "approval_expire_failed", approval_id: card.id, error: String(err) });
    }
  }

  // ①b 狗粮票 58（G9 对账）：外部模式的已申报 pending 卡拿椒图公开面核对裁决状态。
  // 只有 expired 镜像结算（approved/rejected 的决定走批准/驳回中继响应落卡，不对账
  // 代写——仲裁真相在椒图，这里只收「时间出的裁决」）；对账口病了（404/5xx/网络）
  // 只记日志本轮跳过，绝不因此动卡（查不到真相 ≠ 真相是过期，INV-1 邻域口径）。
  if (deps.approvalGateway) {
    for (const card of listDeclaredPendingApprovals(deps.db)) {
      try {
        const { status } = await deps.approvalGateway.fetchStatus(card.externalId as string);
        if (status !== "expired") continue;
        expireApprovalCard(deps.db, card.id, ctx, ttl);
        res.expired.push(card.id);
        deps.log?.({
          info: "approval_expired_reconciled",
          approval_id: card.id,
          run_id: card.runId,
          external_id: card.externalId,
        });
      } catch (err) {
        deps.log?.({ warn: "approval_reconcile_failed", approval_id: card.id, error: String(err) });
      }
    }
  }

  // ② 领任务执行（上限内并发）
  const jobs = claimRunJobs(deps.db, deps.concurrency ?? runDispatchConcurrency());
  await Promise.all(
    jobs.map(async (job) => {
      try {
        await deps.execute(job);
        res.executed.push({ id: job.id, runId: job.runId, action: job.action });
      } catch (err) {
        res.failed.push({ id: job.id, runId: job.runId, error: String(err) });
        deps.log?.({ warn: "run_job_failed", job: job.id, run_id: job.runId, action: job.action, error: String(err) });
      } finally {
        completeRunJob(deps.db, job.id);
      }
    }),
  );
  return res;
}

/** 常驻循环：开工前先跑一次重启恢复（recoverDispatcherState），立即跑第一轮，
 *  之后每 intervalMs 一轮。串行不重叠（上轮跑完才排下轮，并发语义在 dispatchOnce
 *  内部）；轮询抛错只记日志不中断。stop() 优雅停机：不再领新任务，等在跑任务落定
 *  后才 resolve。 */
export function startRunDispatcher(
  deps: RunDispatcherDeps,
  opts: { intervalMs?: number } = {},
): { stop(): Promise<void> } {
  const intervalMs = opts.intervalMs ?? 500;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<unknown> = Promise.resolve();
  const ctx: RunCtx = {
    audit: deps.audit,
    requestId: `dispatch_${randomUUID()}`,
    actor: { type: "system", id: "m3:dispatcher" },
  };
  // 票 73（m14 fanout 的分发放行）：事件等待型 run（注册表 parksOnEvents 标记，即
  // await_children 在图内挂起等子 run 终态事件）对本循环「领了就放」——本循环串行，
  // 若被挂起的 execute 顶住，扇出的子 run 任务永远领不到（生产死锁）。放行后真完成
  // 句柄脱账自理：失败已由执行件（executeStartJob）落 run failed + 审计 + error 事件，
  // 进程重启的孤儿收口（recoverDispatcherState）照旧兜底。
  const kindStmt = deps.db.prepare("SELECT kind FROM runs WHERE id = ?");
  const loopDeps: RunDispatcherDeps = {
    ...deps,
    execute: (job) => {
      const real = deps.execute(job);
      const kind = (kindStmt.get(job.runId) as { kind?: string } | undefined)?.kind;
      if (kind !== undefined && runKindOf(kind)?.parksOnEvents === true) {
        real.catch((err: unknown) => {
          deps.log?.({ warn: "parkable_run_job_failed", run_id: job.runId, action: job.action, error: String(err) });
        });
        return Promise.resolve();
      }
      return real;
    },
  };
  // 开工恢复（进程重启的盘面收口：孤儿 running / 无主 claimed）。单进程部署假设：
  // 构造时刻没有别人在跑这个库。
  try {
    const rec = recoverDispatcherState(deps.db, ctx);
    if (rec.failed.length > 0) {
      deps.log?.({ warn: "dispatcher_recovered_orphans", failed: rec.failed, requeued: rec.requeued });
    }
  } catch (err) {
    deps.log?.({ warn: "dispatcher_recover_failed", error: String(err) });
  }
  const tick = async (): Promise<void> => {
    if (stopped) return;
    const run = dispatchOnce(loopDeps).catch((err) => {
      deps.log?.({ warn: "dispatcher_tick_failed", error: String(err) });
    });
    inflight = run;
    await run;
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  void tick();
  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inflight.catch(() => {}); // 等在跑任务落定（优雅停机）
    },
  };
}
