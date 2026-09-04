import Fastify from "fastify";

// 阶段 0.3：把"建应用"和"起服务"拆开。buildApp 是纯工厂——测试用 app.inject 直接打请求，
// 不需要真开端口；index.ts 只负责监听。这就是 seam：测试打在 buildApp 这个接口上。
export function buildApp() {
  const app = Fastify();

  app.get("/healthz", () => ({ ok: true, service: "ingest" }));

  return app;
}
