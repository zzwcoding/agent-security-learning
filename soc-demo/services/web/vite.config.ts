/// <reference types="vitest/config" />
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// eval-results 静态面（票 21 记票决策，m10/m11 卡无口径时的最薄拿法）：
// m11 的产物 latest.json（票 22 起还有 cost_all.csv）由 dev server 原样静态服务，
// URL /eval-results/latest.json 与磁盘路径一致——Eval 页 fetch 它，六幕 curl 等价
// 脚本也直接 GET 同一路径核对。不建后端端点：Web 只读公开产物，零特权（m10 卡）。
function evalResultsStatic(): Plugin {
  const dir = fileURLToPath(new URL("../../eval-results/", import.meta.url));
  const mime: Record<string, string> = { ".json": "application/json", ".csv": "text/csv" };
  return {
    name: "eval-results-static",
    configureServer(server) {
      server.middlewares.use("/eval-results", (req, res) => {
        const rel = decodeURIComponent(String(req.url ?? "/latest.json").replace(/^\//, "")) || "latest.json";
        readFile(dir + rel)
          .then((buf) => {
            res.setHeader("content-type", mime[rel.slice(rel.lastIndexOf("."))] ?? "application/octet-stream");
            res.end(buf);
          })
          .catch(() => {
            res.statusCode = 404;
            res.end('{"error":"not_found"}');
          });
      });
    },
  };
}

// dev 代理（web :5173 → 各后端）：浏览器只发同源相对路径，由 dev server 转发。
// 为什么需要代理：后端（Fastify）默认不带 CORS 头，浏览器直连跨源会被拦；
// 与 compose 里 web 容器的 env（AGENT_URL/M2_URL/INGEST_URL）同一组开关。
// 分叉规则 = 每个前缀只属于一个服务：auth/chat/approvals/events/pii/internal → agent；
// alerts/cases/audit → case-backend；webhooks → ingest；eval-results → 静态面（上面的插件）。
const agent = process.env.AGENT_URL ?? "http://127.0.0.1:3003";
const m2 = process.env.M2_URL ?? "http://127.0.0.1:3002";
const ingest = process.env.INGEST_URL ?? "http://127.0.0.1:3001";

export default defineConfig({
  plugins: [react(), evalResultsStatic()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api/v1/auth": { target: agent, changeOrigin: true },
      "/api/v1/chat": { target: agent, changeOrigin: true },
      "/api/v1/approvals": { target: agent, changeOrigin: true },
      "/api/v1/events": { target: agent, changeOrigin: true }, // SSE 流式透传
      "/api/v1/pii": { target: agent, changeOrigin: true }, // PII 受控反查（票 55：缺行则反查按钮 404 落在 vite 自身）
      "/internal": { target: agent, changeOrigin: true },
      "/api/v1/alerts": { target: m2, changeOrigin: true },
      "/api/v1/cases": { target: m2, changeOrigin: true },
      "/api/v1/audit": { target: m2, changeOrigin: true },
      "/api/v1/kb": { target: m2, changeOrigin: true }, // 幕 5 KB 人审的 REST 面（curl 等价脚本用）
      "/api/v1/hypotheses": { target: m2, changeOrigin: true }, // 票 82：狩猎页假设 CRUD/轮次归集读面（票 73 落卡端点）
      "/api/v1/templates": { target: agent, changeOrigin: true }, // 票 92：狩猎页模板下拉数据源（m14 登记面只读投影）
      "/api/v1/webhooks": { target: ingest, changeOrigin: true },
    },
  },
  // vitest（seam 单测：SSE 重连/api client/登录态/流水线归约/审批/时间线/对话/Eval）跑在 jsdom 里
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
  },
});
