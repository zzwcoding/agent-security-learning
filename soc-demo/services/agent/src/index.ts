import Fastify from "fastify";

// 阶段 0.2 骨架：本服务是 agent 编排（supervisor + 4 worker、SSE 事件总线、验票中间件），
// 现在只有健康检查。LangGraph.js 图从 M3 模块票开始长出来。
const PORT = Number(process.env.PORT ?? 3003);

const app = Fastify();

app.get("/healthz", () => ({ ok: true, service: "agent" }));

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log(`agent listening on :${PORT}`);
});
