# soc-bench · m13 压测工具面

装：`npm install`（独立小包，不在 pnpm workspace 内）。
跑：前置 `docker compose up -d`（默认九服务）且各服务 `/healthz` 全绿；`node b1-endpoints.mjs <ingest-webhook|m2-upsert|gateway-mint|m2-read>`，无参全跑。
测：`npm test`（harness 单测：stub 服务三态 / 生成器唯一性 / 表格渲染；`node --test` 默认发现 test/*.test.mjs——Node 22.22 在含非 ASCII 的 cwd 下传显式目录参会拒解析，故不写 `node --test test/`）。
