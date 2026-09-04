import Fastify from "fastify";

// 阶段 0.2 骨架：本服务是告警接入口（Wazuh webhook），现在只有健康检查。
// 真实业务（去重、字段映射、不可信标记）从 M1 模块票开始长出来。
const PORT = Number(process.env.PORT ?? 3001);

const app = Fastify();

app.get("/healthz", () => ({ ok: true, service: "ingest" }));

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log(`ingest listening on :${PORT}`);
});
