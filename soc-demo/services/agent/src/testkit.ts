// 票 47 测试工具箱（m3 侧）：异步 run 的等待原语。run 异步化后「POST 返回即终态」
// 的时序不再成立——测试一律显式等状态，不等时序。轮询 runs 表（:memory: 库进程内
// 可见；文件库同连接可见），SSE 等价物走 /events/stream 的补发/收流语义。
// 只被 *.test.ts 与 evals rig 引用（文件名不含 .test，vitest 不会跑它）。
import type { DB } from "./db.js";
import { getRun, type RunRow } from "./runs.js";

export interface WaitOpts {
  /** 超时毫秒（缺省 5s；真 LLM/子进程布景的调用方自己加大）。 */
  timeoutMs?: number;
  /** 轮询步长毫秒（缺省 20ms）。 */
  stepMs?: number;
}

/** 等到 run 进入给定状态集合之一，返回终值行；超时抛错（带上最后见到的状态）。 */
export async function waitForRunStatus(
  db: DB,
  runId: string,
  statuses: string | string[],
  opts: WaitOpts = {},
): Promise<RunRow> {
  const want = Array.isArray(statuses) ? statuses : [statuses];
  const timeoutMs = opts.timeoutMs ?? 5000;
  const stepMs = opts.stepMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  let last: RunRow | null = null;
  for (;;) {
    last = getRun(db, runId);
    if (last && want.includes(last.status)) return last;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForRunStatus 超时（${timeoutMs}ms）：run ${runId} 等 ${JSON.stringify(want)}，最后见 ${last?.status ?? "null"}`,
      );
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** 等到 run 进终态（completed/failed，CONTEXT.md run 状态机的两个吸收态）。 */
export async function waitForRunTerminal(db: DB, runId: string, opts: WaitOpts = {}): Promise<RunRow> {
  return waitForRunStatus(db, runId, ["completed", "failed"], opts);
}
