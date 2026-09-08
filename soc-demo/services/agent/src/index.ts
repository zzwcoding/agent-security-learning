import { ConsoleAuditSink } from "./audit.js";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { makeTriageFlow } from "../workers/triage/flow.js";
import { HttpTriageM2 } from "../workers/triage/m2.js";
import { MemoryKb } from "../workers/triage/kb.js";
import { FakeTriageLlm } from "../workers/triage/llm.js";

const PORT = Number(process.env.PORT ?? 3003);
// 编排侧自己的库（runs/run_events/checkpoints/approvals）落 soc-demo/data；
// AGENT_DB_PATH 可覆盖。compose 给 agent 挂 ./data/agent:/data 的卷，落盘才有
// 断线补发与杀进程可恢复可言。
const dataDir = new URL("../../../data/", import.meta.url);
mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.AGENT_DB_PATH ?? fileURLToPath(new URL("agent.sqlite", dataDir));

// 图选择（票 13 起 alert_flow 默认接 m4 分诊子图）：
//   AGENT_FLOW=approval_demo → 带 L2 动作的演示图（curl 走通审批回路，票 11）
//   其余 → triage 子图。makeNodes 在每个 run 拉起时被调：app.ts 先向 gateway 铸
//   任务票（allowed_tools=分诊六件套，无 L2），票交进来组图。
// KB 现为内存 stub（m4 卡依赖；真 chroma 检索 = 票 17）；LLM 为 fixture 伪 LLM
// （m4 卡 adapter：minimax-m2 经凭证代理接真件时只换 llm adapter）。
const audit = new ConsoleAuditSink();
const makeNodes = process.env.AGENT_FLOW === "approval_demo"
  ? undefined
  : (run: { id: string }, ticket: string) =>
    makeTriageFlow({
      runId: run.id,
      requestId: `launch_${run.id}`,
      ticket,
      m2: new HttpTriageM2(),
      kb: new MemoryKb(),
      llm: new FakeTriageLlm(),
      audit,
    });

// 审计 sink 当前是 ConsoleAuditSink（进 compose 日志可观察）+ SSE 里的 audit 镜像事件
// （run_events 落盘）；M2 开出审计写入口后换 HttpAuditSink 汇入同一 audit_entries 表。
buildApp({ db: openDb(dbPath), audit, makeNodes })
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => console.log(`agent listening on :${PORT}, db=${dbPath}`));
