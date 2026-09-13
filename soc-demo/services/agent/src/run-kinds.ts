// m3 supervisor · run kind 描述符注册表（票 44·F2，体检结构-1/2 清偿）。
//
// 收敛前的局面：一个 run kind 的知识散在 9+ 处——app.ts 的 RUN_KINDS / CASE_KINDS /
// TICKET_SPECS 三张平行表、index.ts makeNodes 的 if 分支、autorun 拉起 payload 的
// alert/case 特判、web pipeline.ts 的 FLOW_NODES 手抄。加一个 kind 要全仓摸一遍，
// 漏一处就静默漂移。收敛后：kind → { 票面 spec、图工厂、预置节点清单 } 一张注册表，
// 新 kind 只在 REGISTRY 加一个条目，消费方（app.ts 校验/铸票、index.ts 组图、
// autorun 拉起、注册表完整性测试）各取所需。
//
// 职责边界（谁读哪一格）：
//   app.ts        —— 读 intake/requiresMessage 做拉起校验，读 ticket 铸任务票；
//                    chat_flow 的公开 SSE 面（launchChatRun）是 app 层路由，不进注册表。
//   index.ts      —— 用生产装配件（Http adapter / LLM 双 adapter / guards / FGA）构造
//                    RunKindGraphDeps，makeNodes 按 kind 取图工厂。
//   run-kinds.test—— 注册表完整性：五 kind 三件套齐全、INV-3 无 L2、预置骨架与
//                    fixtures/sse-events.json flow_nodes 契约锁（票 31 先例）、
//                    图工厂产出与骨架自洽。
//   web 不能 import agent 源码（m10 卡 + 边界规则 R6）——web 的 FLOW_NODES 保持手抄，
//                    与本表靠同一份 fixtures/sse-events.json flow_nodes 样品契约锁
//                    （两端测试各咬对端，票 36 契约先例的延续）。
import type { FlowNode } from "./graph.js";
import type { RunRow } from "./runs.js";
import type { AuditSink } from "./audit.js";
import { TRIAGE_TOOLS } from "../workers/triage/prompt.js";
import { KNOWLEDGE_TOOLS } from "../workers/knowledge/prompt.js";
import { INVESTIGATION_TOOLS } from "../workers/investigation/prompt.js";
import { ENRICHMENT_TOOLS } from "../workers/enrichment/tools.js";
import { CHAT_READONLY_TOOLS, makeChatFlow } from "../workers/chat/flow.js";
import { CASE_FLOW_NODES, makeCaseFlow } from "../workers/case-flow.js";
import { makeTriageFlow } from "../workers/triage/flow.js";
import { makeCloseFlow } from "../workers/triage/close.js";
import { HttpTriageM2 } from "../workers/triage/m2.js";
import { HttpInvestigationM2 } from "../workers/investigation/m2.js";
import { HttpEnrichmentM2 } from "../workers/enrichment/m2.js";
import { makeKnowledgeFlow } from "../workers/knowledge/flow.js";
import { HttpKnowledgeM2 } from "../workers/knowledge/m2.js";
import type { TriageKb } from "../workers/triage/kb.js";
import type { SiemBackend } from "../workers/investigation/siem.js";
import type { AnalyzerBackend } from "../workers/enrichment/analyzers.js";
import type { VectorStore } from "../workers/knowledge/vector-store.js";
import { FakeTriageLlm } from "../workers/triage/llm.js";
import { RealTriageLlm } from "../workers/triage/llm-real.js";
import { FakeInvestigationLlm } from "../workers/investigation/llm.js";
import { RealInvestigationLlm } from "../workers/investigation/llm-real.js";
import { FakeChatLlm } from "../workers/chat/llm.js";
import { RealChatLlm } from "../workers/chat/llm-real.js";
import { FakeKnowledgeLlm } from "../workers/knowledge/llm.js";
import { RealKnowledgeLlm } from "../workers/knowledge/llm-real.js";
import { GatewayLlmClient } from "./llm-client.js";
import { scanInjection } from "./guards-client.js";
import type { FgaChecker } from "./fga-client.js";
import { makeHuntFlow, type OrchestrationDeps } from "./orchestration/flow.js";
import { makeHuntTaskFlow } from "./orchestration/task-flow.js";
// 票 79（内容包）：hunt_flow 票面与 hunt_task 真执行体的单一来源都在内容层（m5 领地）——
// 本注册表只消费（票面 = huntFlowTicketFace()；执行体 = deps.huntExecutor 缺省桩）。
import { huntFlowTicketFace } from "../workers/investigation/hunt-pack.js";
import { wireHuntTaskExecutor, type HuntExecutorDeps } from "../workers/investigation/hunt-executor.js";

/** 每-kind 的任务票规格（FR-M3.4 worker 拉起即申领最小 scope 票；INV-3：票面永不含
 *  L2——kb_write 不在 knowledge 的 allowed_tools 里，L2 走审批卡铸 ApprovalToken）。 */
export interface RunKindTicket {
  sub: string;
  scope: string[];
  allowedTools: string[];
}

/** 每-run 的图工厂（原 buildApp opts.makeNodes 的签名，票 13 起的组图 seam）：
 *  拉起时 app.ts 先按注册表票面向 gateway 铸任务票，再把票交进来组图；
 *  ctx.actor 由 /internal/runs 的 x-actor-id 派生（票 39：close_flow 确认审计记人头）。 */
export type RunGraphFactory = (
  run: RunRow,
  ticket: string,
  ctx?: { actor?: { type: string; id: string } },
) => FlowNode[] | Promise<FlowNode[]>;

/** 生产装配件（index.ts 注入；注册表自己不碰 env/网络——组合根仍在 index.ts）。 */
export interface RunKindGraphDeps {
  audit: AuditSink;
  /** 分诊/调查/对话共用的 kb_lookup 检索面（票 17：chroma 容器或离线 MemoryKb）。 */
  kb: TriageKb;
  /** 沉淀 store（knowledge_flow 写面；生产真 chroma）。 */
  kbStore: VectorStore;
  /** fixture SIEM 语料（调查 siem_query / 对话只读面）。 */
  siem: SiemBackend;
  /** analyzer backend（富化 vt_lookup；fixture 情报表）。 */
  analyzers: AnalyzerBackend;
  /** chat 意图闸的 FGA 裁决面。 */
  fga: FgaChecker;
  /** AGENT_LLM 原值透传（fake = fixture 伪 LLM；其余 = 经凭证代理的 real adapter）。 */
  llmMode: string;
  /** 票 73：m14 编排循环的注入总面（port/ledger/bus/door/templates/llm——生产装配在
   *  index.ts，测试换假件）。hunt_flow/hunt_task 的 makeGraph 必需；缺 = 组图即炸响。 */
  orchestration?: OrchestrationDeps;
  /** 票 79（L0 裁定①）：hunt_task 真执行体装配面（78 四维查询 + 79 weknora 三工具）。
   *  生产 = index.ts 注入；缺省 = 机制 execute 桩原样（73 口径零回归——机制测试与
   *  INV-11 rig 不受影响）。换 weknora HTTP 实现（票 83）只换这里的成员，不换调用方。 */
  huntExecutor?: HuntExecutorDeps;
}

/** run kind 描述符：一个 kind 的全部静态知识（票 44 的「一处注册」）。 */
export interface RunKindDescriptor {
  /** 拉起请求吃哪个实体 id：alert = alert_id 必填；case = case_id 必填（run 行对应落列，
   *  autorun 拉起 payload 同口径）；hypothesis = hypothesis_id 必填（票 90 正名：hunt 两
   *  kind 的拉起实体落 runs.hypothesis_id 专用列，case_id 位承载清偿）。close_flow 虽然动作
   *  在案件上，入口仍吃 alert_id（票 39）。 */
  intake: "alert" | "case" | "hypothesis";
  /** 拉起请求必须带 message 交接态（chat_flow：没消息就没有图可跑 → 400，不造空 run）。 */
  requiresMessage?: boolean;
  ticket: RunKindTicket;
  /** 流水线视图预置骨架（FR-M10.2，web 消费）；没有 = 节点从 node_enter 动态发现
   *  （不超前猜图）。名单与 fixtures/sse-events.json flow_nodes 两端契约锁。 */
  pipelineNodes?: readonly string[];
  /** 事件等待型 run（票 73 m14：await_children 节点在图内挂起，等子 run 终态事件唤醒）。
   *  分发循环对这类 start 任务「领了就放」：串行循环若被挂起的 execute 顶住，扇出的
   *  子 run 永远领不到任务（生产死锁）；真完成句柄由循环脱账自理（失败已由执行件落
   *  run failed + 审计，重启孤儿收口照旧）。 */
  parksOnEvents?: boolean;
  /** 图工厂 maker：吃生产装配件、还一个每-run 组图函数（唯一允许碰 worker 装配的格子）。 */
  makeGraph?: (deps: RunKindGraphDeps) => RunGraphFactory;
}

// 调查+富化链的装配（票 36·B4 清偿，index.ts 原样搬入）：真件 = M2 REST + fixture SIEM
// 语料 + fixture TI 情报表 + guards scanInjection（GUARDS_URL，compose 服务名可达）。
// case_id 不在组图时给定——直拉来自 run 行（executeRun 拼进交接态），alert_flow 链上
// 来自 outcome 的 create_case 运行态写入。
function makeCaseChain(deps: RunKindGraphDeps, runId: string, ticket: string): FlowNode[] {
  const requestId = `launch_${runId}`;
  return makeCaseFlow({
    invest: {
      runId,
      requestId,
      ticket,
      m2: new HttpInvestigationM2(),
      siem: deps.siem,
      kb: deps.kb,
      llm: deps.llmMode === "fake"
        ? new FakeInvestigationLlm()
        : new RealInvestigationLlm(new GatewayLlmClient({ requestId, actor: "agent:investigation" })),
      scan: scanInjection,
      audit: deps.audit,
    },
    enrich: {
      runId,
      requestId,
      ticket,
      m2: new HttpEnrichmentM2(),
      analyzers: deps.analyzers,
      scan: scanInjection,
      audit: deps.audit,
    },
  });
}

// 注册表本体。条目顺序 = 原 RUN_KINDS 字面量顺序（拉起校验与测试快照都依赖稳定序）。
//   alert_flow    = 票 13 分诊六节点；票 36 起 TP 建案分支后同 run 链上调查+富化；
//   knowledge_flow = 票 17 沉淀子图（案件关闭 → 提炼 → kb_write 人审闸）；
//   chat_flow     = 票 18 对话 Copilot（公开面走 POST /api/v1/chat，编排侧同路进柴）；
//   case_flow     = 票 36 调查+富化链直拉（PRD §4.2 步骤 7-8 的下半场入口）；
//   close_flow    = 票 39 SOC1 一键确认关单（FR-M4.5：FP/BTP 建议的执行下半场）；
//   hunt_flow     = 票 73 m14 轮次链（intake→planner→dispatch→await_children→judge→outcome，
//                   一轮一条串行链；轮间接力在 dispatcher 层，见 orchestration/relay.ts）；
//   hunt_task     = 票 73 m14 扇出的取证子 run（复用 plan/decide 循环的 hunt 桩形）。

/** hunt_flow/hunt_task 的图工厂必需编排注入面；缺 = 组装错误要炸响，绝不静默换图。 */
function requireOrchestration(deps: RunKindGraphDeps): OrchestrationDeps {
  if (!deps.orchestration) {
    throw new Error("run kind hunt_flow/hunt_task 需要 RunKindGraphDeps.orchestration（生产装配见 index.ts）");
  }
  return deps.orchestration;
}

const REGISTRY: Record<string, RunKindDescriptor> = {
  alert_flow: {
    intake: "alert",
    pipelineNodes: [
      "load_alert", "kb_check", "merge_check", "self_audit_checkpoint", "verdict_llm", "outcome",
    ],
    ticket: {
      // 票 36（B4 清偿）：alert_flow 的 TP 建案分支后【同一 run 内】链上调查+富化，而任务票
      // 在拉起时铸、verdict 要跑到中途才知道——allowed_tools 取分诊∪调查∪富化三个 L1 工具族
      // 的并集（拉起时刻能证明需要的最小超集）。FP/merge 分支用不到链上工具：票里没执行的
      // 授权不等于执行（闸仍 fail-closed，且并集不含任何 L2——INV-3 依旧）。两票方案（链段
      // 单独铸票）要动 makeNodes 票务 seam，留待真需要时再说。
      sub: "agent:triage",
      scope: ["alert:update", "case:write"],
      allowedTools: [...new Set([...TRIAGE_TOOLS, ...INVESTIGATION_TOOLS, ...ENRICHMENT_TOOLS])],
    },
    // 分诊六节点 + 链上调查+富化（链上节点名见 case_flow 的 pipelineNodes）。只有 TP 的
    // create_case 分支会把 case_id 写进交接态——FP/merge 等分支链空转跳过。
    makeGraph: (deps) => (run, ticket) => [
      ...makeTriageFlow({
        runId: run.id,
        requestId: `launch_${run.id}`,
        ticket,
        m2: new HttpTriageM2(),
        kb: deps.kb,
        llm: deps.llmMode === "fake"
          ? new FakeTriageLlm()
          : new RealTriageLlm(new GatewayLlmClient({ requestId: `launch_${run.id}`, actor: "agent:triage" })),
        audit: deps.audit,
      }),
      ...makeCaseChain(deps, run.id, ticket),
    ],
  },
  knowledge_flow: {
    intake: "case",
    ticket: { sub: "agent:knowledge", scope: ["case:read", "kb:propose"], allowedTools: [...KNOWLEDGE_TOOLS] },
    makeGraph: (deps) => (run, ticket) =>
      makeKnowledgeFlow({
        runId: run.id,
        requestId: `launch_${run.id}`,
        ticket,
        caseId: run.caseId ?? "",
        m2: new HttpKnowledgeM2(),
        store: deps.kbStore,
        llm: deps.llmMode === "fake"
          ? new FakeKnowledgeLlm()
          : new RealKnowledgeLlm(new GatewayLlmClient({ requestId: `launch_${run.id}`, actor: "agent:knowledge" })),
        audit: deps.audit,
      }),
  },
  chat_flow: {
    intake: "case",
    requiresMessage: true,
    ticket: {
      // chat 票面 = 只读四件（FR-M8.4 allow 态的全部执行面）；动作意图的执行票是审批铸的
      // ApprovalToken，不经这张任务票（INV-3：对话 worker 同样物理无 L2 任务票）。
      sub: "agent:chat",
      scope: ["case:read"],
      allowedTools: [...CHAT_READONLY_TOOLS],
    },
    makeGraph: (deps) => (run, ticket) => {
      // m8 对话 Copilot（票 18）：只读面 = investigation 的 M2/SIEM adapter；
      // 意图闸 FGA = 真 openfga 容器（票 12）；LLM 照 AGENT_LLM 切 fake/real。
      const requestId = `launch_${run.id}`;
      return makeChatFlow({
        runId: run.id,
        requestId,
        caseId: run.caseId,
        ticket,
        m2: new HttpInvestigationM2(),
        siem: deps.siem,
        kb: deps.kb,
        llm: deps.llmMode === "fake"
          ? new FakeChatLlm()
          : new RealChatLlm(new GatewayLlmClient({ requestId, actor: "agent:chat" })),
        fga: deps.fga,
        audit: deps.audit,
      });
    },
  },
  case_flow: {
    intake: "case",
    pipelineNodes: CASE_FLOW_NODES,
    ticket: {
      // 票 36：case_flow 的链上两 worker（调查 m5 + 富化 m6）同 run 共票——allowed_tools =
      // 两个 L1 工具族的并集（INV-3 依旧：并集里没有任何 L2），scope 只含案件读写。
      sub: "agent:case_flow",
      scope: ["case:read", "case:write"],
      allowedTools: [...new Set([...INVESTIGATION_TOOLS, ...ENRICHMENT_TOOLS])],
    },
    // 直拉入口（票 36）：POST /internal/runs {kind:"case_flow", case_id} → 链两交接节点
    makeGraph: (deps) => (run, ticket) => makeCaseChain(deps, run.id, ticket),
  },
  close_flow: {
    intake: "alert",
    ticket: {
      // 票 39：一键确认关单的最小票——工具面只有本动作用到的两件（L0 读定 verdict +
      // L1 写落关单），scope 只有 alert:update（INV-3：无任何 L2，也不会碰到案件实体）。
      sub: "agent:triage",
      scope: ["alert:update"],
      allowedTools: ["get_alert", "close_alert"],
    },
    makeGraph: (deps) => (run, ticket, ctx) => {
      // 票 39：SOC1 一键确认关单——最小票的两节点子图；确认人（x-actor-id 派生）随
      // ctx 进审计（INV-8：确认动作记到人头上）。
      return makeCloseFlow({
        runId: run.id,
        requestId: `launch_${run.id}`,
        ticket,
        m2: new HttpTriageM2(),
        audit: deps.audit,
        actor: ctx?.actor,
      });
    },
  },
  hunt_flow: {
    // 票 73（m14）→ 票 90 正名：拉起实体 = hypothesis_id，落 runs.hypothesis_id 专用列
    //（票 73 施工时曾受控借 case_id 位承载，专用列在位后清偿——intake 校验与 run 行
    // 列位同步正名，行为断言零变化）。流水线骨架不进 pipelineNodes：
    // fixtures/sse-events.json flow_nodes 契约锁是旧 kind 的（注册表完整性测试双向锁），
    // hunt 链节点从 node_enter 事件动态发现（描述符注释的既有口径）。
    intake: "hypothesis",
    parksOnEvents: true,
    // 票 79（L0 裁定②）：父票面 = planner 只读面（机制默认菜单 ∪ 三族模板菜单，内容
    // 层单一来源 huntFlowTicketFace()）+ hypothesis_register（L1 写，仅供 outcome 收敛
    // 归档步——register 不入任何 planner 组合菜单，planner 输出含 register = 菜单外
    // 拒绝 T04）。预算走默认档；INV-3：面内无任何 L2。「票面 ⊆ manifest」由
    // tools-manifest.test 咬死。
    ticket: { sub: "agent:hunt_flow", scope: ["case:read"], allowedTools: huntFlowTicketFace() },
    makeGraph: (deps) => (run) =>
      makeHuntFlow({
        runId: run.id,
        orch: requireOrchestration(deps),
        audit: deps.audit,
      }),
  },
  hunt_task: {
    // 票 73/76（m14）：扇出子 run。注册表票面 = 菜单级兜底（无任务上下文的直拉/恢复
    // 路径旧口径不变）；dispatch 逐任务拉起时经 ticketSpecFor 解析 narrow-scope 子票
    //（allowed_tools = 该任务唯一工具），两票时序见 app.ts /internal/runs 的铸票点。
    intake: "hypothesis",
    ticket: { sub: "agent:hunt_task", scope: ["case:read"], allowedTools: huntFlowTicketFace() },
    makeGraph: (deps) => (run, ticket) => {
      // 机制图先行（73 公开接口）；票 79（L0 裁定①）：装配层注入了真执行体
      //（deps.huntExecutor）→ 把 execute 节点从桩换成真件（m5 hunt-executor），
      // 机制目录零改动；未注入 = 桩原样（机制测试/INV-11 rig 的既有口径）。
      const nodes = makeHuntTaskFlow({
        runId: run.id,
        orch: requireOrchestration(deps),
        audit: deps.audit,
      });
      if (!deps.huntExecutor) return nodes;
      return wireHuntTaskExecutor(nodes, {
        ...deps.huntExecutor,
        runId: run.id,
        ticket,
        cancelBoard: requireOrchestration(deps).cancel?.board,
      });
    },
  },
};

/** 票面规格解析（m3 票务装配面的唯一出口，app.ts 铸票点消费）：
 *  hunt_task 带任务上下文 → narrow-scope 子票（allowed_tools = {该任务唯一工具}，
 *  specs/orchestration-loop.md「票务（m9）」子票行）；无任务上下文（直拉/恢复）→
 *  注册表菜单级兜底（票 73 口径不变）；其余 kind 恒返回注册表票面（旧 kind 零变化）。
 *
 *  INV-11 缝闸：子票 ⊆ 父菜单的铸票侧结构保证——任务工具不在父票面（hunt_flow 的
 *  planner 只读菜单）内即拒铸抛错。planner 的菜单闸（T04）是第一道，这里是第二道：
 *  越界任务在铸票唯一通道上就拿不到票（fail-closed，绝不签出越界票面）。 */
export function ticketSpecFor(kind: string, task?: { tool?: unknown } | null): RunKindTicket {
  const spec = requireRunKind(kind).ticket;
  if (kind !== "hunt_task" || !task) return spec;
  // 显式任务上下文但 tool 缺失/为空 = 载荷畸形——fail-closed 拒解析，绝不静默放宽到菜单级
  if (typeof task.tool !== "string" || !task.tool) {
    throw new Error("hunt_task 任务上下文缺 tool，子票面无法解析（fail-closed）");
  }
  const parentFace = REGISTRY.hunt_flow.ticket.allowedTools;
  if (!parentFace.includes(task.tool)) {
    throw new Error(`hunt_task 子票拒铸：工具 ${task.tool} 不在父票菜单内（INV-11，铸票缝 fail-closed）`);
  }
  return { ...spec, allowedTools: [task.tool] };
}

/** 在册 kind 全集（注册表是唯一事实来源——原 app.ts RUN_KINDS 字面量由此消失）。 */
export const RUN_KIND_IDS: string[] = Object.keys(REGISTRY);

/** kind → 描述符；不在册 = undefined（拉起口 400 unknown_kind 的 fail-closed 依据）。 */
export function runKindOf(kind: string): RunKindDescriptor | undefined {
  return REGISTRY[kind];
}

/** 同上，但不在册即抛（已过拉起闸的内部路径：resume 重组图等——注册表完整性破坏要炸响，不猜）。 */
export function requireRunKind(kind: string): RunKindDescriptor {
  const desc = REGISTRY[kind];
  if (!desc) throw new Error(`run kind 未注册：${kind}（注册表见 src/run-kinds.ts）`);
  return desc;
}
