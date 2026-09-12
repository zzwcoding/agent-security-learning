# soc-bench · m13 压测工具面

装：`npm install`（独立小包，不在 pnpm workspace 内）。
跑：前置 `docker compose up -d`（默认九服务）且各服务 `/healthz` 全绿；`node b1-endpoints.mjs <ingest-webhook|m2-upsert|gateway-mint|m2-read>`，无参全跑。
测：`npm test`（harness 单测：stub 服务三态 / 生成器唯一性 / 表格渲染；`node --test` 默认发现 test/*.test.mjs——Node 22.22 在含非 ASCII 的 cwd 下传显式目录参会拒解析，故不写 `node --test test/`）。

B2（链路突发与持续流，票 66）：`node b2-chain.mjs <burst|sustained> [档位…]`。
布景默认口径 EVENT_DRIVEN=on + fake LLM（同 B3，autorun 是被测链路的一环）；probe 2 条先验链路再上量。
- `burst [100|500]`：一次性灌 webhook（缺省两档全跑）；测 ingest 延迟分布 + alert→run 消费延迟 + 积压排干。
- `sustained [2|4|6|8]`：R alerts/s 持续灌流，`B2_SUSTAINED_SECONDS` 可调（缺省 120s）；每档出 ingest/消费延迟、错误分类（422 vs 5xx/超时）、积压收敛——错误率起跳档=ingest 拐点。
观察全走 REST 读口（GET /api/v1/events + /api/v1/audit）；event_cursors 无公开读口，cursor 滞后按消费延迟+积压曲线近似（口径见脚本头注与报告 B2 节）。

B3（分发循环水位爬坡，票 65）：`node b3-dispatcher.mjs [1|5|10|20|50|probe|ttl]`，无参 = probe + 五档全跑。布景默认 EVENT_DRIVEN=on + fake LLM（与 B1 的 off 不同，见脚本头注）；`ttl` 加测需先按脚本头注用 /tmp compose override 以短 `APPROVAL_TTL_SECONDS` 重启 agent，测完 `docker compose up -d --no-deps agent` 还原。

B4（SSE 扇出，票 67）：`node b4-sse.mjs [50|100|200|probe]`，无参 = probe + 三档全跑。布景默认口径 EVENT_DRIVEN=on + fake LLM；1 个高事件率 run（case_flow + 灌 `B4_OBSERVABLES` 个 ip observable，缺省 50）× N 个自实现 fetch-stream SSE 订阅者挂流——实况相位（首帧/e2e 延迟/扇出对账）+ 重连补发（Last-Event-ID 回溯条数）+ 停靠挂流 `B4_HOLD_SECONDS`（缺省 30s，knowledge_flow 停在人审闸上，量每订阅者 100ms 定时器的纯 agent CPU，带 0 订阅者基线）+ 同 N 的 1s 轮询对照（M2 audit 读口）。SSE 客户端走 undici `bodyTimeout:0` dispatcher——缺省 300s bodyTimeout 会把空闲挂流单方面掐断（UND_ERR_BODY_TIMEOUT，真踩）。`B4_POLL_SECONDS`（缺省 20s）/`B4_SAMPLE_MS`（缺省 5s）可调。
