// m14 编排循环 · 轮次链图（票 73 建链，票 74 planner 节点定稿）。
//
// 轮次链六节点固定：intake→planner→dispatch→await_children→judge→outcome——FlowNode[]
// 走 graph.ts 既有节点包装（node_enter/exit 事件、budget.step、每 superstep 框架检查点
// 与其他 run 同口径）；compileFlowGraph 的串行链模型一字不动。循环性不在图里：round k
// 的 outcome 发 round_relay 事件（本 run 的 audit 事件流，SSE 可回放），relay（relay.ts，
// dispatcher 层）拉起 round k+1 的 hunt_flow run——图内永远一轮一条串行链（ADR 0005）。
//
// planner/judge 节点自票 74/75 起是真节点（planner.ts planRound：防注入消毒 → schema
// 降级 → 菜单 fail-closed → 截断 → 建议/拒绝审计；judge.ts judgeRound：判据 schema 化 →
// 防改写留底 → 低置信 fail-closed → 收敛分岔 converge：hit 建案 / miss 归档+register；
// gap.ts analyzeGap：缺口翻译 → 结构化缺口）。票 77 在本件落：节点包装层（取消信号逐
// 节点前检查 + 轮级三闸，T18/T10）、max_rounds 硬顶（intake 的 rounds 预算闸，T09）、
// 防转指纹对比（dispatch 拒组合，T06）——取消原因落账在 cancel.ts 的订阅半边。
import type { FlowNode } from "../graph.js";
import type { AuditSink } from "../audit.js";
import { budgetForKind, assertRoundsBudget, type RunBudget } from "../budget.js";
import type {
  ChildOutcome,
  ChildWaiter,
  HypothesisDetail,
  OrchestrationDeps,
  PlannedTask,
  RoundRecord,
} from "./ports.js";
import { throwIfCancelled } from "./cancel.js";
import { recordAudit } from "./audit-log.js";
import { makeChildWaiter } from "./await-children.js";
import { makeHuntLauncher } from "./launcher.js";
import { planRound } from "./planner.js";
import { converge, judgeRound } from "./judge.js";
import { analyzeGap } from "./gap.js";
import { spinFingerprint } from "./llm-stubs.js";

// 注入总面接口本体上移 ports.ts（票 74）；此处保留再出口——既有消费方
//（run-kinds.ts/index.ts/task-flow.ts/测试）的 import 路径不动。
export type { OrchestrationDeps };

/** 六节点轮次链工厂（run-kinds.ts 注册表 hunt_flow.makeGraph 调；测试直接调）。
 *  waiter 在工厂构造时即挂上事件订阅——先于 dispatch 发生，子 run 终局事件不会错过。 */
export function makeHuntFlow(deps: { runId: string; orch: OrchestrationDeps; audit: AuditSink }): FlowNode[] {
  const { runId, orch, audit } = deps;
  const launcher = makeHuntLauncher(orch.door, orch.ledger);
  const waiter: ChildWaiter = makeChildWaiter(orch.bus);

  // ---- 票 77 节点包装层（轮次链六个节点统一过闸）----
  // 取消信号逐节点前检查（T10/行为 11/12，cancel.ts 唯一实现）+ 轮级三闸（T18：每轮
  // 独立计步/墙钟/token——token 经 charge 转记，run 级闸先抛、轮级闸后抛，fail_reason
  // 可区分）。强杀只经 BudgetExceededError 既有 runner 路径，本层不自写第二套状态改写。
  const board = orch.cancel?.board;
  const now = orch.now ?? Date.now;
  const round: RunBudget | null = orch.roundBudget ? orch.roundBudget() : budgetForKind("hunt_flow").round;
  let roundStart = 0;
  const guarded = (node: FlowNode): FlowNode => ({
    name: node.name,
    run: async (ctx) => {
      throwIfCancelled(board, typeof ctx.state.case_id === "string" ? ctx.state.case_id : "");
      if (round) {
        round.step(); // 轮步（第 maxSteps+1 步在计数前被拒）
        if (roundStart === 0) roundStart = now();
        round.checkLlm("round", roundStart, now()); // 轮时（轮次 run 首节点入场起表，注入钟）
      }
      await node.run(
        round
          ? { ...ctx, charge: (t: number) => { ctx.charge(t); round.charge(t); } }
          : ctx,
      );
    },
  });

  const nodes: FlowNode[] = [
    // ---- 1. intake：交接态装配（hypothesis/round/模板/菜单）+ 首轮前置 hunting ----
    {
      name: "intake",
      run: async (ctx) => {
        // 拉起实体：hunt_flow 的 hypothesis_id 走 runs.hypothesis_id 专用列（票 90 正名，
        // case_id 位承载已清偿；信封键位保持 case_id=graph.ts 派生口径，值源换专用列）
        const hypothesisId = typeof ctx.state.case_id === "string" ? ctx.state.case_id : "";
        if (!hypothesisId) throw new Error("missing hypothesis_id in handoff state (case_id)");

        // 轮号：簿记先行（relay 拉起即记）；竞态窗口（intake 先于 launcher 补账）按
        // 既往轮数推导——两条路殊途同归，轮号漂移会在轮次归集处暴露
        const link = orch.ledger.get(runId);
        const priorRounds = orch.ledger.rounds(hypothesisId).filter((l) => l.runId !== "" && l.runId !== runId);
        const roundNo = link?.roundNo ?? priorRounds.length + 1;

        const detail: HypothesisDetail | null = await orch.port.getDetail(hypothesisId);
        if (!detail) throw new Error(`hypothesis_not_found:${hypothesisId}`);
        const template = orch.templates.of(detail.template_id);
        if (!template) throw new Error(`template_unregistered:${detail.template_id}`);
        // 票 77 T09：max_rounds 硬顶——超顶轮在开跑前即拒（含 hunting 前置之前，不给
        // 该轮留任何副作用）。BudgetExceededError(rounds) 走既有强杀路径（failed + 审计
        // + error 事件）；假设侧 cancelled(budget_rounds) 由取消机制消费强杀事件落账。
        assertRoundsBudget(roundNo, template.maxRounds);
        if (roundNo === 1) {
          // 行为约定 1：hunt_flow 首轮开始前置 hunting（proposed→hunting，INV-10 迁移；
          // 远端 409 原样上抛 = fail-closed，不带病开跑）
          if (detail.status !== "proposed") throw new Error(`hypothesis_not_proposed:${detail.status}`);
          await orch.port.startHunting(hypothesisId);
        } else if (detail.status !== "hunting") {
          // 轮间被取消/终局：不再起轮（行为约定 12 停止语义的骨架形态）
          throw new Error(`hypothesis_inactive:${detail.status}`);
        }

        const lastGap = detail.rounds.length > 0 ? detail.rounds[detail.rounds.length - 1].gap : null;
        // 连续两轮 planner 失败的判定原料（行为 3 后半）：失败轮归集形 = 空组合且无 judge
        //（正常轮 judge 恒非空——judge 节点只在 planner 失败时被跳过）
        const lastRound = detail.rounds[detail.rounds.length - 1];
        const prevPlannerFailed = lastRound !== undefined && lastRound.judge === null && lastRound.tasks.length === 0;
        // 票 77 T06 防转原料：上一轮的防转指纹（任务集 + 该轮规划时输入的 gap 摘要）。
        // 真相源是 m2 轮次归集（重算不新存）；「该轮规划时的 gap」= 上上轮的 gap（首轮
        // 规划无 gap → null）。当前轮指纹由 planner 以同函数产出，dispatch 处对比。
        const prevPrevGap = detail.rounds.length > 1 ? detail.rounds[detail.rounds.length - 2].gap : null;
        ctx.state.hypothesis_id = hypothesisId;
        ctx.state.hypothesis_text = detail.text;
        ctx.state.round_no = roundNo;
        ctx.state.max_rounds = template.maxRounds;
        ctx.state.max_tasks = template.maxTasks;
        ctx.state.menu = [...template.menu];
        ctx.state.gap = lastGap;
        ctx.state.prev_planner_failed = prevPlannerFailed;
        ctx.state.prev_fingerprint = lastRound ? spinFingerprint(lastRound.tasks, prevPrevGap) : "";
        ctx.state.evidence_so_far = detail.rounds.map((r) => `round${r.round_no}:${r.tasks.map((t) => t.tool).join("+")}`);
      },
    },
    // ---- 2. planner：选组合（1..max_tasks；菜单子集内）——票 74 真节点（planner.ts：
    //         消毒 → schema 降级 → 菜单 fail-closed → 截断 → 建议/拒绝审计分痕）----
    {
      name: "planner",
      run: async (ctx) => {
        await planRound({ orch, audit, runId }, ctx);
      },
    },
    // ---- 3. dispatch：按组合扇出 hunt_task 子 run（独立 run 行 + parent/round 簿记）----
    {
      name: "dispatch",
      run: async (ctx) => {
        if (ctx.state.planner_failed === true) {
          // 本轮终止（planner fail-closed，行为 3/4）：无决定 → 无 B 半边审计、无子 run
          //（DENIED 已由 planner 落 hunt_plan_denied；run 不死，outcome 归集空轮）
          ctx.state.children_ids = [];
          return;
        }
        const tasks = (ctx.state.tasks as PlannedTask[]) ?? [];
        const hypothesisId = String(ctx.state.hypothesis_id);
        const roundNo = Number(ctx.state.round_no);
        // 票 77 T06/行为约定 10 防转：相邻轮指纹相同（任务集 + gap 摘要双双原地踏步）
        // → 拒组合（无子 run、无接力）、假设 cancelled(spin)——不冒充 refuted。gap 实质
        // 变化（新证据改写缺口）的豁免已在指纹内表达（含 gap hash，max_repeat=1）。
        const fingerprint = String(ctx.state.tasks_fingerprint ?? "");
        const prevFingerprint = String(ctx.state.prev_fingerprint ?? "");
        if (fingerprint !== "" && fingerprint === prevFingerprint) {
          recordAudit(audit, runId, {
            action: "hunt_round_spin_denied",
            objectId: hypothesisId,
            objectType: "hypothesis",
            details: {
              round_no: roundNo,
              hypothesis_id: hypothesisId,
              fingerprint,
              max_repeat: 1,
            },
            result: "DENIED",
          });
          ctx.emit("audit", { action: "hunt_round_spin_denied", round_no: roundNo, fingerprint });
          await orch.port.transition(hypothesisId, "cancelled", { reason: "spin" });
          ctx.state.spin_detected = true;
          ctx.state.children_ids = [];
          return;
        }
        const children: string[] = [];
        for (const task of tasks) {
          // 铸票在 m3 正门内走（票 76：launchTask 随任务过门，窄票面由门内解析现铸
          // ——子票铸于 dispatch；门失败（含铸票失败）= 任务不执行、无悬置）。
          try {
            children.push(await launcher.launchTask({ hypothesisId, roundNo, parentRunId: runId, task }));
          } catch (err) {
            // T15（INV-1/8）：铸票失败先落五要素 DENIED（该任务 + 原因可回放），再原样
            // 上抛交 runner 强杀路径收口（run 不带病续跑、无半拉子 run）——fail-closed。
            recordAudit(audit, runId, {
              action: "hunt_dispatch_mint_denied",
              objectId: hypothesisId,
              objectType: "hypothesis",
              details: { round_no: roundNo, tool: task.tool, reason: String(err) },
              result: "DENIED",
            });
            throw err;
          }
        }
        ctx.state.children_ids = children;
        // 铸票失败/门失败原样上抛 = 不落任何五要素 SUCCESS——fail-closed 的审计口径在 runner 强杀路径。
        // 审计分痕 B（路由决定，INV-8）：实际执行的组合——与 planner 的建议条目
        //（hunt_plan_suggest）两个 action 可区分可查。
        recordAudit(audit, runId, {
          action: "hunt_dispatch_decide",
          objectId: runId,
          objectType: "run",
          details: { round_no: roundNo, hypothesis_id: hypothesisId, children, tasks_fingerprint: ctx.state.tasks_fingerprint },
          result: "SUCCESS",
        });
        ctx.emit("audit", {
          action: "hunt_children_declared",
          round_no: roundNo,
          children,
        });
      },
    },
    // ---- 4. await_children：只经事件唤醒（子 run 终态事件），禁轮询（T19）----
    {
      name: "await_children",
      run: async (ctx) => {
        const childIds = (ctx.state.children_ids as string[]) ?? [];
        const outcomes: ChildOutcome[] = await waiter.wait(childIds);
        ctx.state.children = outcomes.map((o) => ({
          run_id: o.runId,
          status: o.ok ? "completed" : "failed",
          result_summary: o.resultSummary,
          params_hash: o.paramsHash,
        }));
        ctx.emit("audit", {
          action: "hunt_children_joined",
          round_no: ctx.state.round_no,
          children: ctx.state.children,
        });
      },
    },
    // ---- 5. judge：裁证据充分性（票 75 真节点：judge.ts 判据 schema 化 + 防改写 + 低置信
    //         fail-closed；引用痕/消毒/降级审计全在节点体）----
    {
      name: "judge",
      run: async (ctx) => {
        if (ctx.state.spin_detected === true) return; // 防转轮：组合已拒，无子报告可裁
        await judgeRound({ orch, audit, runId }, ctx);
      },
    },
    // ---- 6. outcome：轮次归集落账 + 收敛分岔 / 轮间接力 ----
    {
      name: "outcome",
      run: async (ctx) => {
        const hypothesisId = String(ctx.state.hypothesis_id);
        const roundNo = Number(ctx.state.round_no);
        const tasks = (ctx.state.tasks as PlannedTask[]) ?? [];
        const joined = (ctx.state.children as RoundRecord["children"]) ?? [];
        const judge = ctx.state.judge as RoundRecord["judge"];

        // 防转终止轮（票 77 T06）：组合已拒 → 空轮归集（拒组合事实可回放），无接力——
        // 假设已 cancelled(spin) 终态（INV-10 不可回退），cancelled 不冒充 refuted。
        if (ctx.state.spin_detected === true) {
          await orch.port.recordRound(hypothesisId, { round_no: roundNo, tasks: [], children: [], judge: null, gap: null });
          ctx.state.outcome = { round_no: roundNo, recorded: true, relayed: false };
          recordAudit(audit, runId, {
            action: "hunt_round_outcome",
            objectId: hypothesisId,
            objectType: "hypothesis",
            details: { round_no: roundNo, run_id: runId, spin: true, relayed: false },
            result: "SUCCESS",
          });
          return;
        }

        // planner 失败轮（行为 3 后半）：空轮归集 → 连续两轮失败 cancelled(planner_broken)，
        // 否则接力下一轮换输入再试；无 gap 翻译（judge 缺席）。DENIED 已由 planner 落账。
        if (ctx.state.planner_failed === true) {
          const prevFailed = ctx.state.prev_planner_failed === true;
          await orch.port.recordRound(hypothesisId, { round_no: roundNo, tasks: [], children: [], judge: null, gap: null });
          let relayed = false;
          if (prevFailed) {
            // 连续两轮 planner 失败 → 假设 cancelled（原因 planner_broken，m2 PATCH 写半边）
            await orch.port.transition(hypothesisId, "cancelled", { reason: "planner_broken" });
          } else {
            // 轮间接力（max_rounds 硬顶不在此设卡：超顶轮由下一轮 intake 的 rounds 预算闸
            // 统一拒——强杀/取消/审计全走同一套口径，票 77 T09）
            relayed = true;
            ctx.emit("audit", {
              action: "round_relay",
              hypothesis_id: hypothesisId,
              next_round: roundNo + 1,
              parent_run_id: runId,
              fingerprint: "",
            } as Record<string, unknown>);
          }
          ctx.state.outcome = { round_no: roundNo, recorded: true, relayed };
          recordAudit(audit, runId, {
            action: "hunt_round_outcome",
            objectId: hypothesisId,
            objectType: "hypothesis",
            details: { round_no: roundNo, run_id: runId, planner_failed: true, relayed },
            result: "SUCCESS",
          });
          return;
        }

        // 不充分 → gap 翻译缺口（票 75 真节点：gap.ts 消毒 + 结构化缺口 schema 降级）
        let gap: RoundRecord["gap"] = null;
        if (judge && !judge.sufficient) {
          gap = await analyzeGap({ orch, audit, runId }, ctx);
        }

        // 轮次归集：m2 假设详情轮次段（children[{run_id,status}] 即父子 run 簿记的假设侧视图）
        await orch.port.recordRound(hypothesisId, {
          round_no: roundNo,
          tasks,
          children: joined.map((c) => ({ run_id: c.run_id, status: c.status })),
          judge,
          gap,
        });
        ctx.state.gap = gap;

        // 收敛分岔（行为约定 9，票 75 converge）：hit → concluded + 建 Case 挂
        // hypothesis_id（复用 m2 建案公开路径）；miss → refuted + note 结论条目 +
        // hypothesis_register（proposed）。收敛落账与审计在 judge.ts converge。
        if (judge?.sufficient) {
          await converge({ orch, audit, runId }, ctx);
        } else {
          // 轮间接力（dispatcher 层 relay 消费本事件拉起 round k+1，ADR 0005 拓扑约束）。
          // max_rounds 硬顶不在此设卡（票 77 T09）：超顶轮由下一轮 intake 的 rounds 预算
          // 闸统一拒——run 强杀走 BudgetExceededError 既有口径，假设侧由取消机制落
          // cancelled(budget_rounds)，与预算/超时触发同一套停止链（行为 11）。
          ctx.emit("audit", {
            action: "round_relay",
            hypothesis_id: hypothesisId,
            next_round: roundNo + 1,
            parent_run_id: runId,
            fingerprint: ctx.state.tasks_fingerprint,
          } as Record<string, unknown>);
        }
        const relayed = judge?.sufficient !== true;
        ctx.state.outcome = { round_no: roundNo, recorded: true, relayed };
        // 五要素审计（INV-8）：轮次 outcome 落账（归集/结论/接力三类事实一张条目可回放）
        recordAudit(audit, runId, {
          action: "hunt_round_outcome",
          objectId: hypothesisId,
          objectType: "hypothesis",
          details: {
            round_no: roundNo,
            run_id: runId,
            sufficient: judge?.sufficient ?? false,
            verdict: judge?.verdict ?? null,
            relayed,
            tasks_fingerprint: ctx.state.tasks_fingerprint,
            children: joined.map((c) => ({ run_id: c.run_id, status: c.status })),
          },
          result: "SUCCESS",
        });
      },
    },
  ];
  // 票 77：六节点统一过节点包装层（取消信号逐节点前检查 + 轮级三闸）——在 return 处
  // 包一层，节点体只管业务机制语义，资源兜底/停止链在包装层一处可读。
  return nodes.map(guarded);
}

export { recordAudit };
