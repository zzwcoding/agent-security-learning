# soc-bench · m13 压测工具面

装：`npm install`（独立小包，不在 pnpm workspace 内）。
跑：前置 `docker compose up -d`（默认九服务）且各服务 `/healthz` 全绿；`node b1-endpoints.mjs <ingest-webhook|m2-upsert|gateway-mint|m2-read>`，无参全跑。
测：`npm test`（harness 单测：stub 服务三态 / 生成器唯一性 / 表格渲染；`node --test` 默认发现 test/*.test.mjs——Node 22.22 在含非 ASCII 的 cwd 下传显式目录参会拒解析，故不写 `node --test test/`）。

B3（分发循环水位爬坡，票 65）：`node b3-dispatcher.mjs [1|5|10|20|50|probe|ttl]`，无参 = probe + 五档全跑。布景默认 EVENT_DRIVEN=on + fake LLM（与 B1 的 off 不同，见脚本头注）；`ttl` 加测需先按脚本头注用 /tmp compose override 以短 `APPROVAL_TTL_SECONDS` 重启 agent，测完 `docker compose up -d --no-deps agent` 还原。
