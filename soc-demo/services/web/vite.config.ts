/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// dev 代理（web :5173 → 各后端）：浏览器只发同源相对路径，由 dev server 转发。
// 为什么需要代理：后端（Fastify）默认不带 CORS 头，浏览器直连跨源会被拦；
// 与 compose 里 web 容器的 env（AGENT_URL/M2_URL/INGEST_URL）同一组开关。
// 分叉规则 = 每个前缀只属于一个服务：auth/chat/approvals/events/internal → agent；
// alerts/cases/audit → case-backend；webhooks → ingest。
const agent = process.env.AGENT_URL ?? "http://127.0.0.1:3003";
const m2 = process.env.M2_URL ?? "http://127.0.0.1:3002";
const ingest = process.env.INGEST_URL ?? "http://127.0.0.1:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api/v1/auth": { target: agent, changeOrigin: true },
      "/api/v1/chat": { target: agent, changeOrigin: true },
      "/api/v1/approvals": { target: agent, changeOrigin: true },
      "/api/v1/events": { target: agent, changeOrigin: true }, // SSE 流式透传
      "/internal": { target: agent, changeOrigin: true },
      "/api/v1/alerts": { target: m2, changeOrigin: true },
      "/api/v1/cases": { target: m2, changeOrigin: true },
      "/api/v1/audit": { target: m2, changeOrigin: true },
      "/api/v1/webhooks": { target: ingest, changeOrigin: true },
    },
  },
  // vitest（seam 单测：SSE 重连/api client/登录态/流水线归约）跑在 jsdom 里
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
  },
});
