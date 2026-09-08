import { ConsoleAuditSink } from "./audit.js";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { APPROVAL_DEMO_FLOW } from "./graph.js";
import { makeTriageFlow } from "../workers/triage/flow.js";
import { HttpTriageM2 } from "../workers/triage/m2.js";
import { MemoryKb } from "../workers/triage/kb.js";
import { FakeTriageLlm } from "../workers/triage/llm.js";
import { RealTriageLlm } from "../workers/triage/llm-real.js";
import { GatewayLlmClient } from "./llm-client.js";
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

// 图选择（票 13 起 alert_flow 接 m4 分诊子图；票 17 起 knowledge_flow 接 m7 沉淀子图）：
//   AGENT_FLOW=approval_demo → 带 L2 动作的演示图（curl 走通审批回路，票 11）
//   其余按 run.kind 组图：alert_flow=triage / knowledge_flow=knowledge。
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
//
// LLM 装配（票 27·ADR 0002 框架红线）：生产默认 real adapter——minimax-m2 经 gateway
// /proxy/llm/* 凭证代理出站（占位符换真凭证 + 金丝雀断言在代理层，票 08 契约；真凭证只活
// 在网关进程）。AGENT_LLM=fake 切回 fixture 伪 LLM（测试确定性依赖 fake——vitest 各 rig
// 显式注入 FakeTriageLlm，不经此开关；本机离线开发也可用它）。上游病了 worker 降级为
// uncertain + 人工（fail-closed，见 workers/triage/llm-real.ts）。
const LLM_MODE = process.env.AGENT_LLM ?? "real";

const audit = new ConsoleAuditSink();
// approval_demo 的接线在票 13 换 makeNodes 时掉线（只剩注释）——票 23 迁移 graph.ts
// 时回补：演示图重新可达，curl 可走通「挂起 → 审批 → resume」全回路（票 11 验收）。
const nodes = process.env.AGENT_FLOW === "approval_demo" ? APPROVAL_DEMO_FLOW : undefined;
const makeNodes = nodes
  ? undefined
  : (run: { id: string; kind: string; caseId: string | null }, ticket: string) => {
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
    return makeTriageFlow({
      runId: run.id,
      requestId: `launch_${run.id}`,
      ticket,
      m2: new HttpTriageM2(),
      kb: kbForTriage,
      llm: LLM_MODE === "fake"
        ? new FakeTriageLlm()
        : new RealTriageLlm(new GatewayLlmClient({ requestId: `launch_${run.id}`, actor: "agent:triage" })),
      audit,
    });
  };

// 审计 sink 当前是 ConsoleAuditSink（进 compose 日志可观察）+ SSE 里的 audit 镜像事件
// （run_events 落盘）；M2 开出审计写入口后换 HttpAuditSink 汇入同一 audit_entries 表。
buildApp({ db: openDb(dbPath), audit, nodes, makeNodes })
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => console.log(`agent listening on :${PORT}, db=${dbPath}`));
