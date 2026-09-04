import Fastify from "fastify";

// 阶段 0.2 骨架：本服务是 TheHive 风格案件后端（Alert/Case/Task/... 的 CRUD + 状态机），
// 现在只有健康检查。数据模型与状态机从 M2 模块票开始长出来。
const PORT = Number(process.env.PORT ?? 3002);

const app = Fastify();

app.get("/healthz", () => ({ ok: true, service: "case-backend" }));

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log(`case-backend listening on :${PORT}`);
});
