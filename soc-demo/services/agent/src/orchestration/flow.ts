// m14 编排循环 · 轮次链图（票 73）。
//
// 轮次链六节点固定：intake→planner→dispatch→await_children→judge→outcome——FlowNode[]
// 走 graph.ts 既有节点包装（node_enter/exit 事件、budget.step、每 superstep 框架检查点
// 与其他 run 同口径）；compileFlowGraph 的串行链模型一字不动。循环性不在图里：round k
// 的 outcome 发 round_relay 事件（本 run 的 audit 事件流，SSE 可回放），relay（relay.ts，
// dispatcher 层）拉起 round k+1 的 hunt_flow run——图内永远一轮一条串行链（ADR 0005）。
//
// planner/judge/gap 本票是确定性最小桩（llm-stubs.ts）；hunt prompt 与真工具归票 78/79，
// 预算分档归票 77，两票 narrow-scope 铸票归票 76。行为约定里的防转（T06）、预算双闸
//（T18）、取消停止语义（T10）由后续票在 outcome/dispatch 的既有缝上落。
import type { FlowNode } from "../graph.js";
import { paramsHash } from "../verify-ticket.js";
import type { AuditSink } from "../audit.js";
import type {
  ChildOutcome,
  ChildWaiter,
  GapOutput,
  HypothesisDetail,
  LoopLlm,
  HypothesisPort,
  HuntLedger,
  LoopEventBus,
  PlannedTask,
  RunDoor,
  RoundReport,
  RoundRecord,
  TemplateSource,
} from "./ports.js";
import { makeChildWaiter } from "./await-children.js";
import { makeHuntLauncher } from "./launcher.js";
import { taskFingerprint } from "./llm-stubs.js";

/** m14 机制件的注入总面（生产装配在 index.ts；注册表 RunKindGraphDeps.orchestration）。 */
export interface OrchestrationDeps {
  port: HypothesisPort;
  ledger: HuntLedger;
  bus: LoopEventBus;
  door: RunDoor;
  templates: TemplateSource;
  llm: LoopLlm;
}

const ACTOR = { type: "agent", id: "agent:hunt_flow" } as const;

/** 五要素审计（INV-8）带 run 关联的 requestId（异步执行无 HTTP 头可借，dispatch_* 同款口径）。 */
function recordAudit(
  audit: AuditSink,
  runId: string,
  entry: {
    action: string;
    objectId: string;
    objectType: string;
    details: Record<string, unknown>;
    result: "SUCCESS" | "FAILURE" | "DENIED";
  },
): void {
  audit.record({ ...entry, actor: ACTOR, requestId: `hunt_${runId}`, createdAt: Date.now() });
}

/** 六节点轮次链工厂（run-kinds.ts 注册表 hunt_flow.makeGraph 调；测试直接调）。
 *  waiter 在工厂构造时即挂上事件订阅——先于 dispatch 发生，子 run 终局事件不会错过。 */
export function makeHuntFlow(deps: { runId: string; orch: OrchestrationDeps; audit: AuditSink }): FlowNode[] {
  const { runId, orch, audit } = deps;
  const launcher = makeHuntLauncher(orch.door, orch.ledger);
  const waiter: ChildWaiter = makeChildWaiter(orch.bus);

  const nodes: FlowNode[] = [
    // ---- 1. intake：交接态装配（hypothesis/round/模板/菜单）+ 首轮前置 hunting ----
    {
      name: "intake",
      run: async (ctx) => {
        // 拉起实体：hunt_flow 经 m3 标准入口吃 case_id 位承载 hypothesis_id（run 行无
        // hypothesis 列；本票不扩 runs schema——见 run-kinds.ts 注册表注释）
        const hypothesisId = typeof ctx.state.case_id === "string" ? ctx.state.case_id : "";
        if (!hypothesisId) throw new Error("missing hypothesis_id in handoff state (case_id)");

        // 轮号：簿记先行（relay 拉起即记）；竞态窗口（intake 先于 launcher 补账）按
        // 既往轮数推导——两条路殊途同归，轮号漂移会在轮次归集处暴露
        const link = orch.ledger.get(runId);
        const priorRounds = orch.ledger.rounds(hypothesisId).filter((l) => l.runId !== "" && l.runId !== runId);
        const roundNo = link?.roundNo ?? priorRounds.length + 1;

        const detail: HypothesisDetail | null = await orch.port.getDetail(hypothesisId);
        if (!detail) throw new Error(`hypothesis_not_found:${hypothesisId}`);
        if (roundNo === 1) {
          // 行为约定 1：hunt_flow 首轮开始前置 hunting（proposed→hunting，INV-10 迁移；
          // 远端 409 原样上抛 = fail-closed，不带病开跑）
          if (detail.status !== "proposed") throw new Error(`hypothesis_not_proposed:${detail.status}`);
          await orch.port.startHunting(hypothesisId);
        } else if (detail.status !== "hunting") {
          // 轮间被取消/终局：不再起轮（行为约定 12 停止语义的骨架形态）
          throw new Error(`hypothesis_inactive:${detail.status}`);
        }

        const template = orch.templates.of(detail.template_id);
        if (!template) throw new Error(`template_unregistered:${detail.template_id}`);
        const lastGap = detail.rounds.length > 0 ? detail.rounds[detail.rounds.length - 1].gap : null;
        ctx.state.hypothesis_id = hypothesisId;
        ctx.state.hypothesis_text = detail.text;
        ctx.state.round_no = roundNo;
        ctx.state.max_rounds = template.maxRounds;
        ctx.state.max_tasks = template.maxTasks;
        ctx.state.menu = [...template.menu];
        ctx.state.gap = lastGap;
        ctx.state.evidence_so_far = detail.rounds.map((r) => `round${r.round_no}:${r.tasks.map((t) => t.tool).join("+")}`);
      },
    },
    // ---- 2. planner：选组合（1..max_tasks；菜单子集内）----
    {
      name: "planner",
      run: async (ctx) => {
        const planInput = {
          hypothesis_text: String(ctx.state.hypothesis_text ?? ""),
          evidence_so_far: (ctx.state.evidence_so_far as string[]) ?? [],
          gap: (ctx.state.gap as GapOutput | null) ?? null,
          menu: (ctx.state.menu as string[]) ?? [],
          template: { max_rounds: Number(ctx.state.max_rounds), max_tasks: Number(ctx.state.max_tasks) },
        };
        const started = Date.now();
        const plan = await orch.llm.planner(planInput);
        ctx.charge(plan.tokens);
        ctx.checkLlm(started, Date.now());
        // 单轮任务数上限（spec 预算档：≤2）：超限截断不拒整轮（T03 的机器半边，审计随 outcome 落）
        const capped = plan.tasks.slice(0, Math.max(1, Number(ctx.state.max_tasks)));
        ctx.state.tasks = capped;
        ctx.state.tasks_truncated = plan.tasks.length > capped.length;
        ctx.state.tasks_fingerprint = taskFingerprint(capped);
        ctx.emit("audit", { action: "hunt_plan", round_no: ctx.state.round_no, tasks: capped, truncated: ctx.state.tasks_truncated });
      },
    },
    // ---- 3. dispatch：按组合扇出 hunt_task 子 run（独立 run 行 + parent/round 簿记）----
    {
      name: "dispatch",
      run: async (ctx) => {
        const tasks = (ctx.state.tasks as PlannedTask[]) ?? [];
        const hypothesisId = String(ctx.state.hypothesis_id);
        const roundNo = Number(ctx.state.round_no);
        const children: string[] = [];
        for (const task of tasks) {
          // 铸票在 m3 正门内按注册表票面走（本票 menu 级票面；逐任务 narrow-scope 归票 76）。
          // 门失败（含铸票失败）原样上抛 = 任务不执行、无悬置（fail-closed，T15 机器半边）。
          children.push(await launcher.launchTask({ hypothesisId, roundNo, parentRunId: runId, task }));
        }
        ctx.state.children_ids = children;
        // 铸票失败/门失败原样上抛 = 不落任何五要素 SUCCESS——fail-closed 的审计口径在 runner 强杀路径
        recordAudit(audit, runId, {
          action: "hunt_dispatch",
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
    // ---- 5. judge：裁证据充分性（只引用子报告，params_hash 引用痕）----
    {
      name: "judge",
      run: async (ctx) => {
        const tasks = (ctx.state.tasks as PlannedTask[]) ?? [];
        const joined = (ctx.state.children as { run_id: string; status: string; result_summary: string; params_hash: string }[]) ?? [];
        const roundReports: RoundReport[] = tasks.map((task, i) => ({
          task,
          result_summary: joined[i]?.result_summary ?? "",
          params_hash: joined[i]?.params_hash ?? paramsHash(task.params),
        }));
        const started = Date.now();
        const verdict = await orch.llm.judge({
          hypothesis_text: String(ctx.state.hypothesis_text ?? ""),
          round_reports: roundReports,
          prior_rounds: Number(ctx.state.round_no) - 1,
        });
        ctx.charge(verdict.tokens);
        ctx.checkLlm(started, Date.now());
        ctx.state.judge = { sufficient: verdict.sufficient, verdict: verdict.verdict, confidence: verdict.confidence, gap_description: verdict.gap_description };
        ctx.state.round_reports = roundReports;
        ctx.emit("audit", { action: "hunt_judge", round_no: ctx.state.round_no, judge: ctx.state.judge });
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
        const evidence = (ctx.state.evidence_so_far as string[]) ?? [];

        // 不充分 → gap 翻译缺口（下一轮 planner 的换组合输入）
        let gap: RoundRecord["gap"] = null;
        if (judge && !judge.sufficient) {
          const started = Date.now();
          const g = await orch.llm.gap({ judge_output: judge, evidence_so_far: evidence });
          ctx.charge(g.tokens);
          ctx.checkLlm(started, Date.now());
          gap = { gap_description: g.gap_description, unknown: g.unknown, suggested_focus: g.suggested_focus };
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

        // 收敛分岔（行为约定 9）：hit → concluded（建 Case 挂 hypothesis_id 归票 74/75，
        // 复用建案路径）；miss → refuted（note TimelineEntry + hypothesis_register 同票）。
        if (judge?.sufficient) {
          await orch.port.transition(hypothesisId, judge.verdict === "miss" ? "refuted" : "concluded");
        } else if (roundNo < Number(ctx.state.max_rounds)) {
          // 轮间接力：dispatcher 层 relay 消费本事件拉起 round k+1（ADR 0005 拓扑约束）
          ctx.emit("audit", {
            action: "round_relay",
            hypothesis_id: hypothesisId,
            next_round: roundNo + 1,
            parent_run_id: runId,
            fingerprint: ctx.state.tasks_fingerprint,
          } as Record<string, unknown>);
        } else {
          // 轮次上限未收敛 → cancelled(budget)（行为约定 11：cancelled 不冒充 refuted）
          await orch.port.transition(hypothesisId, "cancelled", { reason: "budget" });
        }
        const relayed = !judge?.sufficient && roundNo < Number(ctx.state.max_rounds);
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
  return nodes;
}

export { recordAudit };
