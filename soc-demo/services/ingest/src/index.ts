import { buildApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 3001);

// 生产接线：出站写库走真实 M2 REST（compose 里的 case-backend:3002，CASE_BACKEND_URL 可改）。
// 测试不碰这里——buildApp 注入内存 stub，见 app.test.ts / replay.test.ts。
buildApp()
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => console.log(`ingest listening on :${PORT}`));
