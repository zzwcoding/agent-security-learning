// m14 编排循环 · 子 run / 轮次 run 拉起件（票 73）。
//
// 拉起唯一通道 = m3 run 机器标准入口（m14 卡：kind=hunt_flow/hunt_task 与其他 kind 同权）。
// 本件只握 RunDoor（POST /internal/runs 的进程内壳）——铸票客户端一个字节不进机制目录
//（R11：票由 app.ts 装配按注册表票面铸，铸票唯一通道不变，票 76 再做两票 narrow-scope）。
// 簿记紧跟拉起落 ledger（parent_run_id + round_no + task 可查）。
import type { HuntLedger, PlannedTask, RunDoor } from "./ports.js";

export interface HuntLauncher {
  /** 拉起第 roundNo 轮的 hunt_flow run（relay 专用；幂等锚的查与占在 relay）。 */
  launchRound(req: { hypothesisId: string; roundNo: number }): Promise<string>;
  /** dispatch 按任务拉起 hunt_task 子 run（独立 run 行，parent/round/task 簿记）。 */
  launchTask(req: {
    hypothesisId: string;
    roundNo: number;
    parentRunId: string;
    task: PlannedTask;
  }): Promise<string>;
}

export function makeHuntLauncher(door: RunDoor, ledger: HuntLedger): HuntLauncher {
  return {
    async launchRound(req) {
      const runId = await door.post({ kind: "hunt_flow", case_id: req.hypothesisId });
      ledger.put({
        runId,
        role: "round",
        hypothesisId: req.hypothesisId,
        roundNo: req.roundNo,
        parentRunId: null,
        task: null,
      });
      return runId;
    },
    async launchTask(req) {
      // 票 76：任务上下文随拉起过门——子票的窄票面（allowed_tools = task.tool）由 m3
      // 正门内按注册表解析器解析现铸（子票铸于 dispatch），本件只递数据不碰铸票（R11）。
      const runId = await door.post({ kind: "hunt_task", case_id: req.hypothesisId, task: req.task });
      ledger.put({
        runId,
        role: "task",
        hypothesisId: req.hypothesisId,
        roundNo: req.roundNo,
        parentRunId: req.parentRunId,
        task: req.task,
      });
      return runId;
    },
  };
}
