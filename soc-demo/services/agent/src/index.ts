import { HttpAuditSink } from "./audit.js";
import { makeLangfuseMirror, TeeAuditSink } from "./langfuse.js";
import { setEventTap } from "./events.js";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { HttpUsedTokenReader } from "./token-ports.js";
import {
  JiaoTuMintClient,
  JiaoTuTokenBurner,
  JiaoTuUsedTokenReader,
} from "./jiaotu/token-ports-jiaotu.js";
import { JiaoTuApprovalGateway } from "./jiaotu/approval-gateway.js";
import {
  dbCursorStore,
  eventDrivenEnabled,
  HttpOutboxReader,
  makeHttpKbEntryCheck,
  runsLookup,
  startAutorun,
} from "./autorun.js";
import {
  approvalTtlSecondsFromEnv,
  runDispatchConcurrency,
} from "./run-dispatcher.js";
import { APPROVAL_DEMO_FLOW } from "./graph.js";
import {
  requireRunKind,
  runKindOf,
  type RunGraphFactory,
  type RunKindGraphDeps,
} from "./run-kinds.js";
import { MemoryKb } from "../workers/triage/kb.js";
import { FixtureSiem } from "../workers/investigation/siem.js";
import { FixtureAnalyzerTable } from "../workers/enrichment/analyzers.js";
import { RealChromaClient, MemoryVectorStore } from "../workers/knowledge/vector-store.js";
import type { VectorStore } from "../workers/knowledge/vector-store.js";
import { ChromaKb } from "../workers/knowledge/kb.js";
import { makeFgaChecker } from "./fga-client.js";
// 票 79（狩猎业务内容包）：三族模板登记面（HuntTemplateSource——三族优先、机制默认档
// 兜底）、weknora 三工具 Memory stub（playbook/graph L0 只读 + hypothesis_register L1
// 写）与 hunt_task 真执行体装配面——全部内容层/装配层落点，机制目录零触碰。
import { HuntTemplateSource } from "../workers/investigation/hunt-pack.js";
import {
  MemoryPlaybookLibrary,
  MemoryWeknoraGraph,
  WEKNORA_FIXTURES,
  WEKNORA_GRAPH_FIXTURE,
  makeHuntRegisterSeam,
} from "../workers/investigation/weknora.js";
import type { HuntExecutorDeps } from "../workers/investigation/hunt-executor.js";
// 票 73（m14 编排循环）：机制件的真件装配——事件扇出（tap 单槽变扇出点）、父子 run 簿记、
// m2 假设实体 REST adapter、run 机器标准入口壳、模板机制默认档、fake LLM 三件套、轮次接力。
import { makeLoopEventBus } from "./orchestration/bus.js";
import { SqliteHuntLedger } from "./orchestration/ledger.js";
import { HttpHypothesisPort } from "./orchestration/hypothesis-port.js";
import { startRoundRelay } from "./orchestration/relay.js";
import { makeHuntLauncher } from "./orchestration/launcher.js";
import { DefaultTemplateSource } from "./orchestration/template.js";
import { makeLoopLlm } from "./orchestration/llm-stubs.js";
import { makeLoopCancel, type LoopCancelReason } from "./orchestration/cancel.js";
import type { OrchestrationDeps } from "./orchestration/flow.js";

const PORT = Number(process.env.PORT ?? 3003);
// 编排侧自己的库（runs/run_events/checkpoints/approvals）落 soc-demo/data；
// AGENT_DB_PATH 可覆盖。compose 给 agent 挂 ./data/agent:/app/data 的卷（票 41：
// 本文件 dataDir 往上三级，容器内解析到 /app/data，同 case-backend 口径），落盘
// 才有断线补发与杀进程可恢复可言。
const dataDir = new URL("../../../data/", import.meta.url);
mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.AGENT_DB_PATH ?? fileURLToPath(new URL("agent.sqlite", dataDir));

// 图选择（票 13 起 alert_flow 接 m4 分诊子图；票 17 起 knowledge_flow 接 m7 沉淀子图；
// 票 18 起 chat_flow 接 m8 对话 Copilot；票 36 起 case_flow 接 m5+m6 调查富化链，
// alert_flow 的 TP 建案分支后同一 run 内链上同一条链——B4 清偿，PRD §4.2 步骤 7-8）：
//   AGENT_FLOW=approval_demo → 带 L2 动作的演示图（curl 走通审批回路，票 11）
//   其余按 run.kind 查注册表（票 44：src/run-kinds.ts）取图工厂组图——kind 的分支
//   不再写在这里，本文件只剩「真件从哪来」的装配。
//   makeNodes 在每个 run 拉起时被调：app.ts 先按 kind 向 gateway 铸任务票（INV-3：
//   票面无 L2），票交进来组图。
//
// KB 检索面装配（票 17·ADR 0002 框架红线：真 chromadb 落 compose）：
//   KB_CHROMA_URL 设了（compose 设 http://chroma:8000）→ 分诊 KB = ChromaKb(真容器)、
//   沉淀 store = 真 chroma；未设（本机离线开发）→ MemoryKb 离线种子 + 内存 store
//   （重启即空，仅供开发）。m4 的 MemoryKb 语义原样保留（票 13 契约测试不变）。
const KB_CHROMA_URL = process.env.KB_CHROMA_URL;
const kbStore: VectorStore = KB_CHROMA_URL
  ? new RealChromaClient({ baseUrl: KB_CHROMA_URL })
  : new MemoryVectorStore();
const kbForTriage = KB_CHROMA_URL ? new ChromaKb(kbStore) : new MemoryKb();
// 调查/对话的只读面（票 18）：M2 REST + fixture SIEM 语料（m5 worker 同款 adapter 直用）。
// 票 36 起 case_flow 的调查子图共用同一语料与 M2 adapter（fixture 表当 mock SIEM）。
const fixtureSiem = new FixtureSiem(fileURLToPath(new URL("../../../fixtures/alerts/", import.meta.url)));
// case_flow 富化面的 analyzer backend（票 15：fixtures/ti 情报表 mock；microsandbox
// 真跑切换见 workers/enrichment/sandbox.ts——compose 攻击演示切真跑，不在本票范围）
const analyzers = new FixtureAnalyzerTable(fileURLToPath(new URL("../../../fixtures/ti/", import.meta.url)));
// chat 的 FGA 裁决面（票 12 真 openfga 容器；FGA_API_URL/FGA_IDS_FILE env 见 compose）
const fgaForChat = makeFgaChecker();
//
// LLM 装配（票 27·ADR 0002 框架红线）：生产默认 real adapter——minimax-m2 经 gateway
// /proxy/llm/* 凭证代理出站（占位符换真凭证 + 金丝雀断言在代理层，票 08 契约；真凭证只活
// 在网关进程）。AGENT_LLM=fake 切回 fixture 伪 LLM（测试确定性依赖 fake——vitest 各 rig
// 显式注入 FakeTriageLlm，不经此开关；本机离线开发也可用它）。上游病了 worker 降级为
// uncertain + 人工（fail-closed，见 workers/triage/llm-real.ts）。
const LLM_MODE = process.env.AGENT_LLM ?? "real";

// 审计 sink 生产装配（票 35·FR-S5 两路汇入）：HttpAuditSink 把五要素条目异步汇入 M2
// audit_entries（与 M2 自身业务审计同一张表、同一查询面 GET /api/v1/audit）。出站失败
// 不阻塞业务，只打结构化日志 warn=audit_ingest_failed（审计通道病了 ≠ 业务失败；
// fail-closed 口径若被 L0 推翻，换一行装配回 ConsoleAuditSink/补偿式 adapter）。
// SSE 里的 audit 镜像事件（run_events 落盘）照旧，是同一 INV-8 的另一个可观察面。
const m2Audit = new HttpAuditSink();
// 票 37（ADR 0001 承诺兑现）：Langfuse 可选旁路——三把 env 钥匙（LANGFUSE_PUBLIC_KEY/
// SECRET_KEY/HOST）齐了才镜像：事件经 setEventTap 挂旁路、审计经 TeeAuditSink 一弦两
// sink（M2 真相源在前）。key 缺 = lfMirror 为 null，tap 不挂、audit 是原来的单 sink，
// 与本票之前逐字节一致（默认链路零改动是硬验收；容器在不在不归这里管）。
// 票 73：tap 单槽变扇出点——编排循环的事件件（await_children 唤醒 / 轮次接力）与
// Langfuse 镜像同吃一份落盘事件流；没配 Langfuse 时扇出只剩 loop 总线（hunt run 不存在
// 时零订阅者，默认链路行为不变）。
const lfMirror = makeLangfuseMirror();
const loopBus = makeLoopEventBus();
setEventTap((e) => {
  if (lfMirror) {
    try {
      lfMirror.onEvent(e);
    } catch {
      // 旁路崩了不许拖垮落库主链路（events.ts 同款纪律，随扇出点上移到这里）
    }
  }
  loopBus.publish(e);
});
const audit = lfMirror ? new TeeAuditSink([m2Audit, lfMirror]) : m2Audit;
// approval_demo 的接线在票 13 换 makeNodes 时掉线（只剩注释）——票 23 迁移 graph.ts
// 时回补：演示图重新可达，curl 可走通「挂起 → 审批 → resume」全回路（票 11 验收）。
const nodes = process.env.AGENT_FLOW === "approval_demo" ? APPROVAL_DEMO_FLOW : undefined;
// 生产装配件（票 44 起注入 run kind 注册表——图工厂本体在 src/run-kinds.ts 按 kind
// 注册，本文件只负责「真件从哪来」：env 决定的 KB/LLM/FGA/SIEM/analyzer 单例）。
const RUN_KIND_DEPS: RunKindGraphDeps = {
  audit,
  kb: kbForTriage,
  kbStore,
  siem: fixtureSiem,
  analyzers,
  fga: fgaForChat,
  llmMode: LLM_MODE,
};
// 每-run 组图 = 查注册表取本 kind 的图工厂（票 44）。在册 kind 的 makeGraph 由
// 注册表完整性测试保证在位；真缺（不该发生）就炸响，绝不静默换图。
const makeNodes: RunGraphFactory | undefined = nodes
  ? undefined
  : (run, ticket, ctx) => {
    const make = requireRunKind(run.kind).makeGraph;
    if (!make) throw new Error(`run kind ${run.kind} 注册表缺图工厂（见 src/run-kinds.ts）`);
    return make(RUN_KIND_DEPS)(run, ticket, ctx);
  };

// 跨进程焚毁读口（票 34·G2-1 清偿）：生产装配把 M2 used_tokens 读口接进验票闸——
// 跨进程 ApprovalToken 重放第二次必 403 token_used（INV-2），不再只靠 executed_at +
// 300s TTL 兜底；读口不可达 fail-closed 拒绝执行（INV-1）。写侧（用后焚毁登记）仍是
// buildApp 缺省的 HttpTokenBurner（fire-and-forget POST 同一张 used_tokens 表）。
// 票 40：同一份 db 也给消费循环的游标/防重查（event_cursors + runs 表，autorun.ts）。
const db = openDb(dbPath);
// 票 73（m14 编排循环）真件装配：簿记落 agent 自持 SQLite（hunt_run_links）；m2 假设
// 实体走公开 REST（CASE_BACKEND_URL）；拉起子 run/下一轮 run 打 m3 标准入口正门
//（app.inject POST /internal/runs——铸票/组图/执行全在正门内，R11 铸票唯一通道不动）。
// planner/judge/gap 走 makeLoopLlm 出网开关总口（票 74 建口、票 75 三件齐：AGENT_LLM=
// fake → 确定性桩，其余 → ChatSeam 凭证代理真件）。
// 票 79（狩猎业务内容包）装配：模板登记面 = HuntTemplateSource（三族模板优先，机制
// 默认档兜底）；register 缝 = weknora Memory stub（MemoryHypothesisRegister 缺省件退役
// ——五要素审计在 seam 实现内落账，L0 裁定②）；huntExecutor = hunt_task 真执行体
//（78 四维查询 + 79 三工具，缺省桩的换件点在 run-kinds 注册表）。
const huntLedger = new SqliteHuntLedger(db);
const huntPlaybooks = new MemoryPlaybookLibrary(WEKNORA_FIXTURES);
const huntGraph = new MemoryWeknoraGraph(WEKNORA_GRAPH_FIXTURE);
const ORCH_DEPS: OrchestrationDeps = {
  port: new HttpHypothesisPort(),
  ledger: huntLedger,
  bus: loopBus,
  door: {
    post: async (payload) => {
      const res = await app.inject({ method: "POST", url: "/internal/runs", payload });
      if (res.statusCode >= 300) {
        throw new Error(`internal/runs HTTP ${res.statusCode} ${res.body}`);
      }
      return (res.json() as { run_id: string }).run_id;
    },
  },
  templates: new HuntTemplateSource(new DefaultTemplateSource()),
  llm: makeLoopLlm(LLM_MODE), // 票 75 生产切换（74 移交）：AGENT_LLM 口径与四 worker 同一总口
  register: makeHuntRegisterSeam({ graph: huntGraph, audit }), // 票 79：converge 缝换真 stub（proposed-only + INV-8 审计）
};
RUN_KIND_DEPS.orchestration = ORCH_DEPS;
// 票 79（L0 裁定①）：hunt_task 真执行体——m5 plan/decide 执行半边 + 78 executeHuntTool
// 门 + 79 weknora 三工具；装配面经 RUN_KIND_DEPS 注入注册表缝（缺省 = 机制桩）。
const huntExecutor: HuntExecutorDeps = {
  siem: fixtureSiem,
  playbook: huntPlaybooks,
  graph: huntGraph,
  audit,
};
RUN_KIND_DEPS.huntExecutor = huntExecutor;
// 票 77（预算双闸/取消停止）：取消机制装配——预算强杀 error 事件的 m14 消费半边
//（假设侧 cancelled 落账 + 信号板，轮次链/子 run 的节点包装层检查据此掐停）；人取消
//（POST /hypotheses/:id/cancel）经同一 requestCancel 口进同一停止链。
const loopCancel = makeLoopCancel({
  bus: loopBus,
  ledger: huntLedger,
  port: ORCH_DEPS.port,
  audit,
  log: (e) => console.log(JSON.stringify(e)),
});
ORCH_DEPS.cancel = loopCancel;
// 票 73：hunt 拉起件（door 正门 + hunt_run_links 簿记锚落账）——autorun 的
// hypothesis.created → hunt_flow 轮 1 拉起与 relay 的轮间接力共用同一 launcher。
const huntLauncher = makeHuntLauncher(ORCH_DEPS.door, huntLedger);
// 轮次接力（dispatcher 层）：round k outcome 的 round_relay 事件 → 拉起 round k+1 的
// hunt_flow run（幂等锚在 huntLedger.findByRound；图内永远一轮一条串行链，ADR 0005）。
const roundRelay = startRoundRelay({
  bus: loopBus,
  ledger: huntLedger,
  door: ORCH_DEPS.door,
  log: (e) => console.log(JSON.stringify(e)),
});
// 狗粮票 57/58（CONTEXT.md「狗粮接入」）：JIAOTU_GATEWAY_URL 设了 = 四件 seam 整体换
// 椒图 adapter——任务票 mint/焚毁读/焚毁写三件（src/jiaotu/token-ports-jiaotu.ts，57）
// + 审批外接 approvalGateway（src/jiaotu/approval-gateway.ts，58：挂起申报/批准中继/
// 驳回中继/G9 对账四路共用，批准人身份由椒图口令证明，soc-demo 永不自铸审批票）。
// LLM 出站鉴权头不在此切——GatewayLlmClient 构造时自读 JIAOTU_API_KEY（G1）。
// 未设 = 现有装配逐字节不变（内部 gateway 形态）。
const JIAOTU_GATEWAY_URL = process.env.JIAOTU_GATEWAY_URL;
const app = buildApp({
  db,
  audit,
  nodes,
  makeNodes,
  usedReader: JIAOTU_GATEWAY_URL
    ? new JiaoTuUsedTokenReader({ baseUrl: JIAOTU_GATEWAY_URL })
    : new HttpUsedTokenReader(),
  ...(JIAOTU_GATEWAY_URL
    ? {
        mint: new JiaoTuMintClient({ baseUrl: JIAOTU_GATEWAY_URL }),
        burn: new JiaoTuTokenBurner({ baseUrl: JIAOTU_GATEWAY_URL }),
        approvalGateway: new JiaoTuApprovalGateway({ baseUrl: JIAOTU_GATEWAY_URL }),
      }
    : {}),
});
app.addHook("onClose", async () => {
  roundRelay.stop(); // 轮次接力订阅随手撤（进程退出前不再接力）
  loopCancel.stop(); // 取消机制订阅随手撤（票 77）
});
app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => {
    console.log(`agent listening on :${PORT}, db=${dbPath}`);
    // 票 47（ADR 0004-1）：run 分发循环（buildApp 内建装配）——POST /internal/runs 落
    // queued 秒回，start/resume 队列由消费循环在本进程内消化；审批卡保质期扫描同循环。
    // env：RUN_DISPATCH 并发上限（默认 1）、APPROVAL_TTL_SECONDS 审批保质期（默认 86400）。
    console.log(
      `run dispatcher: on (concurrency=${runDispatchConcurrency()}, approval_ttl=${approvalTtlSecondsFromEnv()}s)`,
    );
    // 票 40（G2-9 清偿）：事件驱动自动拉起——M2 outbox 的消费循环挂进常驻进程。
    // alert.created → alert_flow（PRD 消息旅程 step4：supervisor 认领并拉起分诊）、
    // case.closed → knowledge_flow（step11，票 17 线头收口）。拉起走 app.inject 打
    // 自家 /internal/runs 正门——与手动触发同一条轨道（铸票→组图→执行→审计），不开旁路。
    // EVENT_DRIVEN=off 可关（开关语义见 autorun.ts 文件头；evals/手动模式不受影响）。
    if (!eventDrivenEnabled()) {
      console.log("event-driven autorun: off (EVENT_DRIVEN=off)");
      return;
    }
    const launch: Parameters<typeof startAutorun>[0]["launch"] = async (req) => {
      // 票 73（L0 派发中裁决①）：hypothesis.created → hunt_flow 轮 1——经 launcher
      //（door 正门 + 簿记锚落账，防重闸二的落账半边）；票 90 正名：autorun 传参走
      // LaunchReq.hypothesisId（runs.hypothesis_id 专用列在位，case_id 位承载清偿）。
      // autorun 只拉轮 1，轮间接力归 startRoundRelay。
      if (req.kind === "hunt_flow") {
        await huntLauncher.launchRound({ hypothesisId: req.hypothesisId as string, roundNo: 1 });
        return;
      }
      // 拉起 payload 的实体字段按注册表 intake 定（票 44）：alert = alert_id，case = case_id
      // ——原来「kind === alert_flow 特判」的手抄口径收敛进注册表一格。
      const payload = runKindOf(req.kind)?.intake === "alert"
        ? { kind: req.kind, alert_id: req.alertId }
        : { kind: req.kind, case_id: req.caseId };
      const res = await app.inject({ method: "POST", url: "/internal/runs", payload });
      if (res.statusCode >= 300) {
        throw new Error(`internal/runs HTTP ${res.statusCode} ${res.body}`);
      }
    };
    startAutorun({
      events: new HttpOutboxReader(),
      cursor: dbCursorStore(db),
      launch,
      hasActiveRun: runsLookup(db),
      // 票 73（L0 裁决①）：hunt 防重闸二 = m14 簿记锚（findByRound 在册即不重拉轮 1）
      hasRoundRun: (hypothesisId, roundNo) => huntLedger.findByRound(hypothesisId, roundNo) !== null,
      // 票 77（L0 裁决②）：hypothesis.cancelled → m14 取消机制唯一入口（人取消生产接续；
      // reason 由 m2 取消端点在源头闸四因枚举，这里原样转发不猜不改写）
      cancelHypothesis: (hypothesisId, reason) =>
        loopCancel.requestCancel(hypothesisId, reason as LoopCancelReason, "user"),
      hasKbEntryForCase: makeHttpKbEntryCheck(),
      log: (e) => console.log(JSON.stringify(e)),
    });
    console.log("event-driven autorun: on (M2 outbox → alert_flow/knowledge_flow)");
  });
