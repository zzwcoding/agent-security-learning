// 图编排（m3 内部模块 graph）。票 23 起（ADR 0002 框架回补）：手写执行循环换成
// @langchain/langgraph 的 StateGraph 声明编排——节点/边/END 直接可读对应 m3 卡子图；
// L2 挂起/恢复走框架原生 interrupt()/Command(resume)（ApprovalInterrupt 控制流异常
// 已移除）；检查点由 EnvelopeCheckpointSaver（BaseCheckpointSaver）按框架节奏落盘，
// 信封 hash 链防篡改语义原样保留（checkpointer.ts）。
//
// 不变的部分（M2 对账面 / 外部契约，不在本票替换范围）：run 状态机（INV-10）、
// budget 三闸（60s/20 步/50k token）、SSE 事件（INV-7）、审批卡与验票闸（INV-2/3/9）。
// 执行语义照旧：每节点 node_enter/node_exit 事件、跑完盖检查点、失败强杀成 failed
// 并落审计 + error 事件（INV-1 不吞错）——「节点跑完」的盖章现在由框架在每个
// superstep 调 checkpointer.put 完成，节点包装层只管事件与进度回写。
import { randomUUID } from "node:crypto";
import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
  isGraphInterrupt,
} from "@langchain/langgraph";
import type { DB } from "./db.js";
import { getRun, requireRun, saveProgress, transitionRun, type RunCtx, type RunRow } from "./runs.js";
import { emitEvent, type SseEventType } from "./events.js";
import { resumeRun as restoreCheckpoint } from "./checkpointer.js";
import { EnvelopeCheckpointSaver } from "./checkpointer.js";
import { BudgetExceededError, budgetFromEnv, type RunBudget } from "./budget.js";
import type { AuditSink } from "./audit.js";
import { findDecidableCard, markApprovalExecuted, openApprovalCard, setApprovalExternalId, listPendingApprovalsByRun, type ApprovalGateway } from "./approvals.js";
import {
  paramsHash,
  type ApprovalClaims,
  type BurnRegistry,
} from "./verify-ticket.js";
import { makeGatedCall } from "./gated-call.js";
import type { TokenBurner, UsedTokenReader } from "./token-ports.js";
import { InvalidRunTransitionError } from "./statemachine.js";

/** 节点执行上下文：worker/确定性节点拿到的全部能力。emit 供 tool_call/tool_result 事件用；
 *  charge/checkLlm 是资源兜底的计费口（真 LLM 适配器接上后必须走这两个口）；
 *  executeApproved 是 L2 动作的唯一正门：开卡挂起 → 值班长批准 → 闸验签 → 执行 → 焚毁。 */
export interface NodeCtx {
  runId: string;
  state: Record<string, unknown>;
  emit(type: SseEventType, payload: Record<string, unknown>): void;
  charge(tokens: number): void;
  checkLlm(startedAtMs: number, nowMs: number): void;
  /** L2 审批闸口：首次调用开卡并经 LangGraph interrupt() 挂起本 run（awaiting_approval）；
   *  resume 后节点从头重跑，按卡上的决定返回。驳回 → {approved:false}。 */
  awaitApproval(tool: string, params: unknown, opts?: ApproveOpts): ApprovalDecision;
  /** L2 动作全程：awaitApproval 拿决定 → 驳回直接返回不执行 → 批准则过验票闸执行
   *  action → 焚毁登记 + 执行标记。闸拒（票过期/参数被换/重放）抛错强杀，绝不带病执行。
   *  票 17 起 action 允许异步（kb_write 的出站 chroma 写入是 promise）——本函数对
   *  「同步动作返回同步值、异步动作返回 promise」双形态；挂起判定（interrupt）保持
   *  同步抛出，sync 节点不 await 时票 11 演示图的挂起语义原样成立。 */
  executeApproved(
    tool: string,
    params: unknown,
    opts: ApproveOpts,
    action: (params: unknown) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): ExecutionOutcome | Promise<ExecutionOutcome>;
}

export interface ApproveOpts {
  reason?: string;
  caseId?: string;
}

export interface ApprovalDecision {
  approved: boolean;
  approvalId: string;
  /** 批准时铸出的 ApprovalToken wire 串（验票闸唯一依据，INV-9：验签不信文本）。 */
  token?: string;
}

export type ExecutionOutcome =
  | { executed: true; approvalId: string; jti: string; result: Record<string, unknown> }
  | { executed: false; outcome: "rejected"; approvalId: string };

export interface FlowNode {
  name: string;
  /** 票 13 起允许异步：triage worker 的出站调用（guards 扫描 / LLM / M2 REST）都是
   *  promise，LangGraph 节点包装层在这里 await——同步节点不受影响，失败兜底/审批
   *  挂起语义不变。 */
  run(ctx: NodeCtx): void | Promise<void>;
}

// PRD 图：alert_flow: intake(已落库) → triage → …。薄径只保留确定性节点：
export const THIN_ALERT_FLOW: FlowNode[] = [
  {
    name: "intake",
    // 交接上下文确认（PRD：状态信封只携带 case_id/alert_id/run_id/ticket）——
    // 真正读 M2 告警、拉起分诊子图是票 13 的事
    run: (ctx) => {
      if (!ctx.state.alert_id) throw new Error("missing alert_id in handoff state");
    },
  },
  {
    name: "route",
    // supervisor 的路由点。票 13 起生产默认图是 triage 子图（index.ts makeNodes 组图），
    // 薄径作为无 worker 时的兜底保留（测试/演示）
    run: (ctx) => {
      ctx.state.route = "end";
    },
  },
];

// 票 11 演示布景：带一个 L2 动作的最小 alert_flow（调查建议遏制 → isolate_host）。
// AGENT_FLOW=approval_demo 时 index.ts 挂它，curl 就能走通「挂起 → 审批 → resume」全回路；
// mock 执行只写状态与审计（PRD §11：响应动作一律 mock，不对接真实 EDR）。
export const APPROVAL_DEMO_FLOW: FlowNode[] = [
  {
    name: "response_advice",
    run: (ctx) => {
      ctx.state.recommendation = { tool: "isolate_host", params: { host: "centos7" } };
    },
  },
  {
    name: "execute_action",
    // 票 34 起 executeApproved 决定已决的执行路径带跨进程焚毁查询（异步）——节点须
    // await（与 knowledge/chat worker 的 async 节点同款；挂起仍由同步段同步抛出）。
    run: async (ctx) => {
      ctx.state.execution = await ctx.executeApproved(
        "isolate_host",
        { host: "centos7" },
        { reason: "调查报告建议遏制" },
        (p) => ({ mock_edr: "isolated", host: (p as { host: string }).host }),
      );
    },
  },
];

export interface ExecuteOpts {
  nodes?: FlowNode[];
  budget?: RunBudget;
  audit?: AuditSink;
  requestId?: string;
  /** L2 执行后的焚毁登记口（INV-2；生产 = HttpTokenBurner → M2 used_tokens）。 */
  burn?: TokenBurner;
  /** L2 执行前验票闸的重放读口（INV-2 进程内真相；不传 = 闸不查，测试便利）。
   *  票 34 起与 usedReader 并存时取「或」：任一路说已焚即拒（装填是叠加不是替换）。 */
  used?: BurnRegistry;
  /** 票 34：跨进程焚毁真相读口（M2 GET /internal/used-tokens/:jti，INV-2 生产装配）。
   *  查询在进闸【前】异步完成——闸本体保持同步（票 07 契约测试面 + interrupt 同步抛出
   *  契约都不动）；查询失败时读口哑掉，闸内 has() 抛异常归 signature_invalid
   *  （INV-1 fail-closed：查不到真相 ≠ 真相是没有，拒绝执行而不是放行）。 */
  usedReader?: UsedTokenReader;
  /** 验票 HMAC 密钥（缺省读 env SOC_HMAC_KEY，与闸同口径）。 */
  hmacKey?: string;
  /** 狗粮票 58：审批外接端口（生产 = JiaoTuApprovalGateway，JIAOTU_GATEWAY_URL 设定时
   *  index.ts 装配）。挂起分支用它把新开的本地卡申报到椒图 g4（external_id 落卡，
   *  之后批准/驳回/对账都拿它寻址）；未传 = 内部模式，挂起语义逐字节不变。 */
  approvalGateway?: ApprovalGateway;
  /** 票 18：交接态覆写。chat_flow 的消息/角色不在 run 行里（它是用户触发不是内部触发），
   *  由调用方（POST /api/v1/chat）随启动注入；缺省仍按 run 行拼 kind/alert_id/case_id。 */
  initialState?: Record<string, unknown>;
}

interface DriveDeps {
  ctx: RunCtx;
  nodes: FlowNode[];
  budget: RunBudget;
  burn?: TokenBurner;
  used?: BurnRegistry;
  usedReader?: UsedTokenReader;
  hmacKey?: string;
  approvalGateway?: ApprovalGateway;
}

function makeDeps(opts: ExecuteOpts): DriveDeps {
  return {
    ctx: {
      audit: opts.audit ?? { record: () => {} }, // 不传审计 sink = 丢弃（仅测试便利）
      requestId: opts.requestId ?? randomUUID(),
      actor: { type: "system", id: "m3:supervisor" },
    },
    nodes: opts.nodes ?? THIN_ALERT_FLOW,
    budget: opts.budget ?? budgetFromEnv(),
    burn: opts.burn,
    used: opts.used,
    usedReader: opts.usedReader,
    hmacKey: opts.hmacKey,
    approvalGateway: opts.approvalGateway,
  };
}

// LangGraph 图状态：单一 run 通道（LastValue：后写覆盖前写）。worker 的 FlowNode 语义
// 是「原地改 ctx.state」——节点包装层把通道值浅拷贝成 working 交给节点，节点返回后
// 作为新通道值写回。所有 m4-m6 子图的产物（alert/verdict/report/…）都装在这个通道里，
// 因此每个检查点的字节都盖着信封 hash——防篡改面对 worker 产出同样生效。
const RunFlowState = Annotation.Root({
  run: Annotation<Record<string, unknown>>({
    reducer: (_prev, next) => next,
    default: () => ({}),
  }),
});

interface CompilePlan {
  db: DB;
  runId: string;
  deps: DriveDeps;
  /** 进度账本：progress.completed = 已跑完的节点数（挂起/失败的节点不算），
   *  resume 时从 run 行接续——run.steps 口径与票 10 保持一致。 */
  progress: { completed: number };
  cursor: { node: string };
}

/** 把 FlowNode[] 声明成 StateGraph：节点一一对应，边按序串联，末节点接 END——
 *  m3 卡子图（intake→route→END / load_alert→…→outcome→END）在 addNode/addEdge
 *  里直接可读。每 run 编译一次（节点工厂捕获本 run 的 db/deps）。 */
function compileFlowGraph(plan: CompilePlan) {
  const { db, runId, deps, progress, cursor } = plan;
  const actor = deps.ctx.actor ?? { type: "system", id: "m3:supervisor" };

  // ---- L2 审批闸口（决定绑定 (run, tool_call)：审批卡字段是唯一锚）----

  const awaitApproval = (tool: string, params: unknown, opts?: ApproveOpts): ApprovalDecision => {
    const o: ApproveOpts = opts ?? {};
    for (;;) {
      const existing = findDecidableCard(db, runId, tool, paramsHash(params));
      if (existing?.status === "rejected") return { approved: false, approvalId: existing.id };
      if (existing?.status === "approved" && existing.token) {
        return { approved: true, approvalId: existing.id, token: existing.token };
      }
      // pending = 决定还没落（重启后批准前的重入），幂等再中断，不重复开卡。
      // LangGraph 原生 interrupt：未决即抛 GraphInterrupt 挂起本 superstep。resume 后
      // 节点从头重跑，interrupt() 可能回吞旧 resume 值直接返回——决定以 DB 为准，
      // 回到循环顶重查卡；卡仍未决就再次中断，直到没有新 resume 值真正挂起。
      const card = existing ?? openApprovalCard(db, {
        runId,
        node: cursor.node,
        tool,
        params,
        caseId: o.caseId ?? null,
        reason: o.reason ?? null,
      }, deps.ctx);
      interrupt(card.id);
    }
  };

  // 票 34：从 wire 票解 payload.jti（未验签）——只作跨进程焚毁查询的键，不作信任依据：
  // 伪造/篡改票在闸的验签步就会被拒，装填结果根本轮不到被读。解不出（坏票）→ 不查询，
  // 闸照常按 signature_invalid 拒。
  const jtiFromWire = (token: string): string | null => {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    try {
      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
      return typeof payload.jti === "string" ? payload.jti : null;
    } catch {
      return null;
    }
  };

  // 闸前的读口装填（票 34）：把 M2 跨进程焚毁真相并进一个一次性 BurnRegistry 再进闸。
  // 合并取「或」：M2 说已焚 → true；否则问本地表（进程内真相，如 MemoryBurnRegistry）——
  // 叠加不是替换，任何一路说已焚都必须拒。查询失败 → 哑读口：闸内 has() 抛异常，
  // 落进闸的 fail-closed 桶 signature_invalid（INV-1：查不到真相 ≠ 真相是没有）。
  const resolveUsed = async (token: string): Promise<BurnRegistry | undefined> => {
    if (!deps.used && !deps.usedReader) return undefined; // 两路都没接 = 不查（既有测试便利口径）
    if (!deps.usedReader) return deps.used;
    let burned: boolean | null = null;
    let failure: unknown = null;
    const wireJti = jtiFromWire(token);
    if (wireJti !== null) {
      try {
        burned = await deps.usedReader.lookup(wireJti);
      } catch (e) {
        failure = e; // INV-1：读口病了闸必须病
      }
    }
    const local = deps.used;
    return {
      has: (jti: string) => {
        if (failure !== null) throw failure;
        if (burned === true && jti === wireJti) return true;
        return local ? local.has(jti) : false;
      },
    };
  };

  const executeApproved: NodeCtx["executeApproved"] = (tool, params, opts, action) => {
    // 同步段：awaitApproval 里的 interrupt() 必须同步抛出——本函数刻意不是 async 函数，
    // async 节点（票 17 起 worker 全体）与 sync 节点（approval_demo）都先原样走完这段
    // （票 11 契约）。
    const decision = awaitApproval(tool, params, opts);
    if (!decision.approved || !decision.token) {
      return { executed: false, outcome: "rejected", approvalId: decision.approvalId };
    }
    emitEvent(db, runId, "tool_call", {
      node: cursor.node,
      tool,
      params_hash: paramsHash(params),
      approval_id: decision.approvalId,
    });
    // 异步尾段（票 34）：决定已落、后面不再有 interrupt——先把 M2 焚毁真相装进读口
    // （含网络 RTT），再进同步闸。调用方（决定已决路径）拿到 Promise，节点须 await。
    // token 收窄进局部 const（闭包内 TS 不追踪 decision.token 的非空收窄）。
    const token = decision.token;
    return (async () => {
      const used = await resolveUsed(token);
      // 票 43（F1）：验票 + 闸拒（DENIED 审计条目与 `${prefix}_gate_denied` 错误拼法）
      // 走共享 makeGatedCall——审批变体与 worker 任务票闸的差异只剩凭据形态
      // （ApprovalToken + 焚毁读口，非任务票）与放行后的收尾（下面的焚毁/执行标记/
      // 带 result 的 tool_result 事件，事件顺序一动就是行为变化，不并进共享件）。
      let jti = "";
      const gatedApproval = makeGatedCall({
        prefix: "approval",
        hmacKey: deps.hmacKey,
        creds: () => ({ approvalToken: token, caseId: opts.caseId, used }),
        deny: () => ({
          record: (entry) =>
            deps.ctx.audit.record({
              ...entry,
              actor,
              requestId: deps.ctx.requestId,
              createdAt: Date.now(),
            }),
          objectId: decision.approvalId,
          objectType: "approval",
        }),
        onAllow: (v) => {
          jti = (v.payload as ApprovalClaims).jti;
        },
      });
      // 闸拒 = 授权链有缺口（票过期/参数被换/重放/读口不可达），共享件内 fail-closed：
      // 审计 DENIED 后抛错强杀。票 17：动作允许异步（kb_write 出站 chroma）。
      const result = await gatedApproval(nctx, tool, params as Record<string, unknown>, async () =>
        (await action(params)) as Record<string, unknown>);
      deps.burn?.burn(jti, "approval"); // INV-2：用后即焚（生产 = M2 used_tokens）
      markApprovalExecuted(db, decision.approvalId, jti, deps.ctx);
      emitEvent(db, runId, "tool_result", {
        node: cursor.node,
        tool,
        ok: true,
        approval_id: decision.approvalId,
        result,
      });
      return { executed: true, approvalId: decision.approvalId, jti, result };
    })();
  };

  const nctx: NodeCtx = {
    runId,
    state: {}, // 每节点注入各自的 working 拷贝（见包装层）
    emit: (type, payload) => void emitEvent(db, runId, type, payload),
    charge: (tokens) => deps.budget.charge(tokens),
    checkLlm: (startedAtMs, now) => deps.budget.checkLlm(cursor.node, startedAtMs, now),
    awaitApproval,
    executeApproved,
  };

  // ---- FlowNode → LangGraph 节点包装：事件 + 预算 + 状态拷贝进出 ----
  // addSequence 一次登记全部节点（节点名集合进入图的节点类型，后续 addEdge 可读名字）；
  // 边按 FlowNode 顺序串联，末节点接 END——m3 卡子图在声明里直接可读。
  type FlowUpdate = { run: Record<string, unknown> };
  const entries: [string, (state: typeof RunFlowState.State) => Promise<FlowUpdate>][] =
    deps.nodes.map((node) => [
      node.name,
      async (state) => {
        cursor.node = node.name;
        emitEvent(db, runId, "node_enter", { node: node.name });
        deps.budget.step(); // 资源兜底之一：max_steps（默认 20）
        const working = { ...state.run };
        await node.run({ ...nctx, state: working });
        emitEvent(db, runId, "node_exit", { node: node.name });
        progress.completed += 1;
        saveProgress(db, runId, progress.completed, deps.budget.tokens);
        return { run: working };
      },
    ]);

  const sg = new StateGraph(RunFlowState).addSequence(entries);
  sg.addEdge(START, deps.nodes[0].name);
  for (let i = 0; i < deps.nodes.length - 1; i++) {
    sg.addEdge(deps.nodes[i].name, deps.nodes[i + 1].name);
  }
  sg.addEdge(deps.nodes[deps.nodes.length - 1].name, END);

  // checkpointer = 信封 hash 链（BaseCheckpointSaver）；nodeLabel 让每个节点跑完后的
  // 框架检查点盖上「刚跑完的节点名」，框架簿记检查点（输入态）落成 __input__。
  const checkpointer = new EnvelopeCheckpointSaver(db, () => cursor.node);
  return sg.compile({ checkpointer });
}

/** 挂起判定：LangGraph 在 invoke 返回值里带 __interrupt__ 通道 = run 停在 interrupt 处
 *  （此时审批卡已开、run 已被 openApprovalCard 原子地转入 awaiting_approval）。 */
function isSuspended(result: unknown): boolean {
  return result !== null && typeof result === "object" && "__interrupt__" in result;
}

type FlowPlan =
  | { mode: "start"; initialState: Record<string, unknown> }
  | { mode: "resume" };

/** 跑一张图到终态或挂起。状态迁移/审计镜像/失败强杀的口径与票 10 一致：
 *  任何失败都强杀成 failed 并落审计 + error 事件（不吞错）；interrupt 挂起不是失败，
 *  卡已开、run 已在 awaiting_approval，原地返回。 */
async function runFlow(db: DB, runId: string, deps: DriveDeps, plan: FlowPlan): Promise<RunRow> {
  const { ctx, budget, nodes } = deps;
  const actor = ctx.actor ?? { type: "system", id: "m3:supervisor" };
  // 审计 → SSE 的镜像：审计是真相源，事件流是它的广播（PRD §6-M3 事件类型含 audit）
  const mirrorAudit = (entry: Record<string, unknown>) => emitEvent(db, runId, "audit", entry);
  const transitionAndMirror = (to: RunRow["status"]) => {
    const from = (getRun(db, runId) as RunRow).status;
    transitionRun(db, runId, to, ctx);
    mirrorAudit({ action: "update", result: "SUCCESS", status: { from, to } });
  };
  transitionAndMirror("running");

  // 空图：老执行循环对空 FlowNode[] 是「直跑完」——StateGraph 编不出空节点链，保持语义
  if (nodes.length === 0) {
    transitionAndMirror("completed");
    return getRun(db, runId) as RunRow;
  }

  const progress = { completed: plan.mode === "resume" ? (getRun(db, runId) as RunRow).steps : 0 };
  const cursor = { node: "" };
  const graph = compileFlowGraph({ db, runId, deps, progress, cursor });
  // durability "sync"：每个 superstep 的检查点（信封）落库后才进下一步——与票 10
  // 「每节点一信封」的持久化纪律同强度；thread_id 即 run_id（信封链的 run_id）。
  const config = { configurable: { thread_id: runId }, durability: "sync" as const };

  let result: unknown;
  try {
    result = plan.mode === "resume"
      ? await graph.invoke(new Command({ resume: true }), config) // resume 值仅作唤醒信号，决定以审批卡为准
      : await graph.invoke({ run: plan.initialState }, config);
  } catch (e) {
    if (isGraphInterrupt(e)) {
      // 框架通常在 invoke 内消化挂起；这里只兜住逃逸形态——不是失败，原样收手
      saveProgress(db, runId, progress.completed, budget.tokens);
      return getRun(db, runId) as RunRow;
    }
    const kill = (failReason: string, details: Record<string, unknown>) => {
      saveProgress(db, runId, progress.completed, budget.tokens);
      transitionRun(db, runId, "failed", ctx, failReason);
      ctx.audit.record({
        action: "kill",
        actor,
        objectId: runId,
        objectType: "run",
        details: { ...details, status: { from: "running", to: "failed" } },
        requestId: ctx.requestId,
        result: "FAILURE",
        createdAt: Date.now(),
      });
      emitEvent(db, runId, "error", details); // 资源兜底触发要 Web 可见（PRD 异常与边界）
    };
    if (e instanceof BudgetExceededError) {
      kill(`budget_exceeded:${e.kind}`, {
        code: "budget_exceeded",
        kind: e.kind,
        limit: e.limit,
        used: e.used,
        node: cursor.node || undefined,
      });
    } else {
      kill(`node_error:${cursor.node}`, {
        code: "node_error",
        node: cursor.node || undefined,
        message: e instanceof Error ? e.message : String(e),
      });
    }
    return getRun(db, runId) as RunRow;
  }

  if (isSuspended(result)) {
    saveProgress(db, runId, progress.completed, budget.tokens); // 挂起前的计费照记（token 兜底跨 resume 连续）
    // resume 重入后再次挂起（卡仍未决，幂等再中断）时 run 已被 transitionAndMirror
    // 转回 running——挂起态必须落回 awaiting_approval，状态机与 Web 观察面才一致
    // （首次挂起由 openApprovalCard 在开卡事务里完成这一步）。
    if ((getRun(db, runId) as RunRow).status === "running") {
      transitionAndMirror("awaiting_approval");
    }
    // 狗粮票 58（批准中继·申报步）：外部模式（approvalGateway 在位）把本 run 尚未
    // 申报的 pending 卡申报到椒图 g4，external_id 落卡（申报幂等：已申报的跳过）。
    // 申报失败不杀死挂起——审计 FAILURE + error 事件，卡留 pending 可重试（下次
    // 挂起分支重入再试）；awaitApproval/interrupt 的同步契约不碰，申报只在挂起
    // 落定之后异步补做。内部模式无端口，这段整体跳过（零回归）。
    if (deps.approvalGateway) {
      for (const card of listPendingApprovalsByRun(db, runId)) {
        try {
          const { externalId } = await deps.approvalGateway.declare({
            tool: card.tool,
            params: card.params,
            paramsHash: card.paramsHash,
            reason: card.reason,
            caseId: card.caseId,
          });
          setApprovalExternalId(db, card.id, externalId, ctx);
        } catch (err) {
          ctx.audit.record({
            action: "declare",
            actor,
            objectId: card.id,
            objectType: "approval",
            details: {
              run_id: runId,
              tool: card.tool,
              params_hash: card.paramsHash,
              error: err instanceof Error ? err.message : String(err),
            },
            requestId: ctx.requestId,
            result: "FAILURE",
            createdAt: Date.now(),
          });
          emitEvent(db, runId, "error", {
            code: "approval_declare_failed",
            approval_id: card.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    return getRun(db, runId) as RunRow;
  }
  transitionAndMirror("completed");
  return getRun(db, runId) as RunRow;
}

/** 跑一个 run 到终态（从 queued 开跑）。调用方 await 到终态（仍无真并发调度，
 *  后台化等 worker 全接入的票再换），签名兜底语义不变。 */
export async function executeRun(db: DB, runId: string, opts: ExecuteOpts = {}): Promise<RunRow> {
  const run = requireRun(db, runId);
  return runFlow(db, runId, makeDeps(opts), {
    mode: "start",
    // 票 17：knowledge_flow 带 case_id（无 alert），交接信封按 run 行拼齐两种 kind；
    // 票 18：chat_flow 由调用方注入完整交接态（message/role 随请求来，不在 run 行）
    initialState: opts.initialState ?? (run.caseId
      ? { kind: run.kind, case_id: run.caseId }
      : { kind: run.kind, alert_id: run.alertId }),
  });
}

/** 审批 resume（票 11）：经 LangGraph Command(resume) 从信封链末态续跑挂起的 run。
 *  只有 awaiting_approval 能被 resume（INV-10 状态门）；信封链复核失败 → 拒绝恢复 +
 *  审计 FAILURE（FR-M3.3）；兜底口径（steps/tokens）从 run 行接续，不因重启清零。 */
export async function resumeRun(db: DB, runId: string, opts: ExecuteOpts = {}): Promise<RunRow> {
  const run = requireRun(db, runId);
  if (run.status !== "awaiting_approval") {
    throw new InvalidRunTransitionError(run.status, "running");
  }
  const deps = makeDeps(opts);
  // 先验货再放行：链被动时状态原样不动（checkpointer 里已落审计 FAILURE）；
  // LangGraph 真正读盘（EnvelopeCheckpointSaver.getTuple，内含第二次整链复核）之前拦截。
  restoreCheckpoint(db, runId, {
    audit: deps.ctx.audit,
    requestId: deps.ctx.requestId,
  });
  deps.budget.steps = run.steps;
  deps.budget.tokens = run.tokensUsed;
  return runFlow(db, runId, deps, { mode: "resume" });
}
