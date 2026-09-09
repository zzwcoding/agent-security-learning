import { HttpAuditSink } from "./audit.js";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { HttpUsedTokenReader } from "./token-ports.js";
import { APPROVAL_DEMO_FLOW } from "./graph.js";
import { makeTriageFlow } from "../workers/triage/flow.js";
import { HttpTriageM2 } from "../workers/triage/m2.js";
import { MemoryKb } from "../workers/triage/kb.js";
import { FakeTriageLlm } from "../workers/triage/llm.js";
import { RealTriageLlm } from "../workers/triage/llm-real.js";
import { GatewayLlmClient } from "./llm-client.js";
import { HttpInvestigationM2 } from "../workers/investigation/m2.js";
import { FixtureSiem } from "../workers/investigation/siem.js";
import { FakeInvestigationLlm } from "../workers/investigation/llm.js";
import { RealInvestigationLlm } from "../workers/investigation/llm-real.js";
import { HttpEnrichmentM2 } from "../workers/enrichment/m2.js";
import { FixtureAnalyzerTable } from "../workers/enrichment/analyzers.js";
import { makeCaseFlow } from "../workers/case-flow.js";
import { scanInjection } from "./guards-client.js";
import { makeChatFlow } from "../workers/chat/flow.js";
import { FakeChatLlm } from "../workers/chat/llm.js";
import { RealChatLlm } from "../workers/chat/llm-real.js";
import { makeFgaChecker } from "./fga-client.js";
import { makeKnowledgeFlow } from "../workers/knowledge/flow.js";
import { HttpKnowledgeM2 } from "../workers/knowledge/m2.js";
import { FakeKnowledgeLlm } from "../workers/knowledge/llm.js";
import { RealKnowledgeLlm } from "../workers/knowledge/llm-real.js";
import { RealChromaClient, MemoryVectorStore } from "../workers/knowledge/vector-store.js";
import type { VectorStore } from "../workers/knowledge/vector-store.js";
import { ChromaKb } from "../workers/knowledge/kb.js";

const PORT = Number(process.env.PORT ?? 3003);
// 编排侧自己的库（runs/run_events/checkpoints/approvals）落 soc-demo/data；
// AGENT_DB_PATH 可覆盖。compose 给 agent 挂 ./data/agent:/data 的卷，落盘才有
// 断线补发与杀进程可恢复可言。
const dataDir = new URL("../../../data/", import.meta.url);
mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.AGENT_DB_PATH ?? fileURLToPath(new URL("agent.sqlite", dataDir));

// 图选择（票 13 起 alert_flow 接 m4 分诊子图；票 17 起 knowledge_flow 接 m7 沉淀子图；
// 票 18 起 chat_flow 接 m8 对话 Copilot；票 36 起 case_flow 接 m5+m6 调查富化链，
// alert_flow 的 TP 建案分支后同一 run 内链上同一条链——B4 清偿，PRD §4.2 步骤 7-8）：
//   AGENT_FLOW=approval_demo → 带 L2 动作的演示图（curl 走通审批回路，票 11）
//   其余按 run.kind 组图：alert_flow=triage+case 链 / knowledge_flow=knowledge /
//   chat_flow=chat / case_flow=investigate→enrich。
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
// chat 的只读面（票 18）：M2 REST + fixture SIEM 语料（m5 worker 同款 adapter 直用）。
// 票 36 起 case_flow 的调查子图共用同一语料与 M2 adapter（fixture 表当 mock SIEM）。
const fixtureSiem = new FixtureSiem(fileURLToPath(new URL("../../../fixtures/alerts/", import.meta.url)));
const siemForChat = fixtureSiem;
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
const audit = new HttpAuditSink();
// approval_demo 的接线在票 13 换 makeNodes 时掉线（只剩注释）——票 23 迁移 graph.ts
// 时回补：演示图重新可达，curl 可走通「挂起 → 审批 → resume」全回路（票 11 验收）。
const nodes = process.env.AGENT_FLOW === "approval_demo" ? APPROVAL_DEMO_FLOW : undefined;
const makeNodes = nodes
  ? undefined
  : (run: { id: string; kind: string; caseId: string | null }, ticket: string) => {
    // 票 36 调查+富化链的装配（B4 清偿）：真件 = M2 REST + fixture SIEM 语料 + fixture
    // TI 情报表 + guards scanInjection（GUARDS_URL，compose 服务名可达）；调查 LLM 照
    // AGENT_LLM 切 fake/real。case_id 不在组图时给定——直拉来自 run 行（executeRun
    // 拼进交接态），alert_flow 链上来自 outcome 的 create_case 运行态写入。
    const caseChain = (runId: string) => {
      const requestId = `launch_${runId}`;
      return makeCaseFlow({
        invest: {
          runId,
          requestId,
          ticket,
          m2: new HttpInvestigationM2(),
          siem: fixtureSiem,
          kb: kbForTriage,
          llm: LLM_MODE === "fake"
            ? new FakeInvestigationLlm()
            : new RealInvestigationLlm(new GatewayLlmClient({ requestId, actor: "agent:investigation" })),
          scan: scanInjection,
          audit,
        },
        enrich: {
          runId,
          requestId,
          ticket,
          m2: new HttpEnrichmentM2(),
          analyzers,
          scan: scanInjection,
          audit,
        },
      });
    };
    if (run.kind === "knowledge_flow") {
      return makeKnowledgeFlow({
        runId: run.id,
        requestId: `launch_${run.id}`,
        ticket,
        caseId: run.caseId ?? "",
        m2: new HttpKnowledgeM2(),
        store: kbStore,
        llm: LLM_MODE === "fake"
          ? new FakeKnowledgeLlm()
          : new RealKnowledgeLlm(new GatewayLlmClient({ requestId: `launch_${run.id}`, actor: "agent:knowledge" })),
        audit,
      });
    }
    if (run.kind === "chat_flow") {
      // m8 对话 Copilot（票 18）：只读面 = investigation 的 M2/SIEM adapter；
      // 意图闸 FGA = 真 openfga 容器（票 12）；LLM 照 AGENT_LLM 切 fake/real；
      // guards 预检走 guards-client 默认 HTTP（GUARDS_URL，compose 服务名可达）。
      const requestId = `launch_${run.id}`;
      return makeChatFlow({
        runId: run.id,
        requestId,
        caseId: run.caseId,
        ticket,
        m2: new HttpInvestigationM2(),
        siem: siemForChat,
        kb: kbForTriage,
        llm: LLM_MODE === "fake"
          ? new FakeChatLlm()
          : new RealChatLlm(new GatewayLlmClient({ requestId, actor: "agent:chat" })),
        fga: fgaForChat,
        audit,
      });
    }
    if (run.kind === "case_flow") {
      // 直拉入口（票 36）：POST /internal/runs {kind:"case_flow", case_id} → 链两交接节点
      return caseChain(run.id);
    }
    // alert_flow：分诊六节点 + 链上调查+富化（票 36·B4 清偿，PRD §4.2 步骤 7-8）。
    // 只有 TP 的 create_case 分支会把 case_id 写进交接态——FP/merge 等分支链空转跳过。
    return [
      ...makeTriageFlow({
        runId: run.id,
        requestId: `launch_${run.id}`,
        ticket,
        m2: new HttpTriageM2(),
        kb: kbForTriage,
        llm: LLM_MODE === "fake"
          ? new FakeTriageLlm()
          : new RealTriageLlm(new GatewayLlmClient({ requestId: `launch_${run.id}`, actor: "agent:triage" })),
        audit,
      }),
      ...caseChain(run.id),
    ];
  };

// 跨进程焚毁读口（票 34·G2-1 清偿）：生产装配把 M2 used_tokens 读口接进验票闸——
// 跨进程 ApprovalToken 重放第二次必 403 token_used（INV-2），不再只靠 executed_at +
// 300s TTL 兜底；读口不可达 fail-closed 拒绝执行（INV-1）。写侧（用后焚毁登记）仍是
// buildApp 缺省的 HttpTokenBurner（fire-and-forget POST 同一张 used_tokens 表）。
buildApp({
  db: openDb(dbPath),
  audit,
  nodes,
  makeNodes,
  usedReader: new HttpUsedTokenReader(),
})
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => console.log(`agent listening on :${PORT}, db=${dbPath}`));
