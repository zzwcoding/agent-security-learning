import { ConsoleAuditSink } from "./audit.js";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { APPROVAL_DEMO_FLOW } from "./graph.js";
import { openDb } from "./db.js";

const PORT = Number(process.env.PORT ?? 3003);
// 编排侧自己的库（runs/run_events/checkpoints/approvals）落 soc-demo/data；
// AGENT_DB_PATH 可覆盖。compose 给 agent 挂 ./data/agent:/data 的卷，落盘才有
// 断线补发与杀进程可恢复可言。
const dataDir = new URL("../../../data/", import.meta.url);
mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.AGENT_DB_PATH ?? fileURLToPath(new URL("agent.sqlite", dataDir));

// AGENT_FLOW=approval_demo 换带 L2 动作的演示图（curl 走通审批回路）；默认薄径直 END。
// 铸票/焚毁的出站 adapter 在 buildApp 里默认指向 gateway:8002 与 case-backend:3002。
const flow = process.env.AGENT_FLOW === "approval_demo" ? APPROVAL_DEMO_FLOW : undefined;

// 审计 sink 当前是 ConsoleAuditSink（进 compose 日志可观察）+ SSE 里的 audit 镜像事件
// （run_events 落盘）；M2 开出审计写入口后换 HttpAuditSink 汇入同一 audit_entries 表。
buildApp({ db: openDb(dbPath), audit: new ConsoleAuditSink(), nodes: flow })
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => console.log(`agent listening on :${PORT}, db=${dbPath}`));
