// m14 编排循环 · hunt_task 子 run 图（票 73）。
//
// 子 run 契约（m14 卡）：kind=hunt_task，m3 标准机器拉起，复用调查 worker 的 plan/decide
// 循环。真循环的 hunt 版 prompt 与 SIEM/剧本工具归票 78/79——本票是最小桩：plan（唯一
// 任务一步）→ execute（事件轨迹 + canned 观察）→ report（子 run 终态事件，await_children
// 的唯一唤醒源）。终态事件 = audit 事件 payload.action="hunt_task_finished"，带
// result_summary/params_hash（judge 引用痕）；失败路径（强杀/铸票失败）由 runner 的
// error 事件折成终局——await-children.ts 两种都认（INV-1 不吞错，口径与现有 run 一致）。
import type { FlowNode } from "../graph.js";
import { paramsHash } from "../verify-ticket.js";
import type { AuditSink } from "../audit.js";
import type { PlannedTask } from "./ports.js";
import type { OrchestrationDeps } from "./flow.js";

const ACTOR = { type: "agent", id: "agent:hunt_task" } as const;

export function makeHuntTaskFlow(deps: { runId: string; orch: OrchestrationDeps; audit: AuditSink }): FlowNode[] {
  const { runId, audit } = deps;
  return [
    // ---- intake：交接态从簿记恢复（task 由 dispatch 在拉起前不可知，落 hunt_run_links）----
    {
      name: "intake",
      run: (ctx) => {
        const link = deps.orch.ledger.get(runId);
        if (!link || link.role !== "task" || !link.task) {
          throw new Error(`missing task handoff for hunt_task run ${runId}（簿记缺行 = 拉起路径绕开了 launcher）`);
        }
        ctx.state.task = link.task;
        ctx.state.hypothesis_id = link.hypothesisId;
        ctx.state.round_no = link.roundNo;
        ctx.state.parent_run_id = link.parentRunId;
      },
    },
    // ---- plan：plan/decide 循环的最小桩——唯一任务即唯一计划步 ----
    {
      name: "plan",
      run: (ctx) => {
        const task = ctx.state.task as PlannedTask;
        ctx.state.plan = [{ step: 1, tool: task.tool, params: task.params }];
        ctx.emit("audit", { action: "hunt_task_plan", round_no: ctx.state.round_no, steps: ctx.state.plan });
      },
    },
    // ---- execute：decide 循环的执行半边（stub：打 tool_call/tool_result 事件轨迹，
    // 不接真后端——票 78 落 SIEM 四维工具后换 makeGatedCall 正门 + 真执行体）----
    {
      name: "execute",
      run: (ctx) => {
        const task = ctx.state.task as PlannedTask;
        const hash = paramsHash(task.params);
        ctx.emit("tool_call", { node: "execute", tool: task.tool, params_hash: hash });
        ctx.charge(8); // stub 计费占位（真用量随票 78 的真执行体走 ctx.charge）
        const observation = { ok: true, summary: `stub observation for ${task.tool}`, params_hash: hash };
        ctx.emit("tool_result", { node: "execute", tool: task.tool, ok: true, result: observation });
        ctx.state.observation = observation;
        ctx.state.params_hash = hash;
      },
    },
    // ---- report：子 run 终态事件（await_children 的唯一唤醒源）----
    {
      name: "report",
      run: (ctx) => {
        const task = ctx.state.task as PlannedTask;
        const summary = String((ctx.state.observation as { summary?: string })?.summary ?? "");
        ctx.emit("audit", {
          action: "hunt_task_finished",
          run_id: runId,
          hypothesis_id: ctx.state.hypothesis_id,
          round_no: ctx.state.round_no,
          tool: task.tool,
          ok: true,
          result_summary: summary,
          params_hash: ctx.state.params_hash,
        });
        // 五要素审计（INV-8）：子 run 出证事实（事件流之外落到审计真相源）
        audit.record({
          action: "hunt_task_report",
          actor: ACTOR,
          objectId: runId,
          objectType: "run",
          details: {
            hypothesis_id: ctx.state.hypothesis_id,
            round_no: ctx.state.round_no,
            parent_run_id: ctx.state.parent_run_id,
            tool: task.tool,
            result_summary: summary,
            params_hash: ctx.state.params_hash,
          },
          requestId: `hunt_${runId}`,
          result: "SUCCESS",
          createdAt: Date.now(),
        });
        ctx.state.outcome = { reported: true };
      },
    },
  ];
}
