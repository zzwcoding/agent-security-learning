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

B5（防线压下，票 69，收官）：压力中做捣乱实验，断言过载下 fail-closed 不松动（断言判定器在 `lib/b5.mjs`，离线单测锁定；断言失败 = 非零退出）。三实验各自独立轮次（down → rm -rf data → up 起跑；实验内只做容器级 stop/kill/start，services/** 与 compose 零改动）：
- `node b5-guards-kill.mjs`（实验①）：sustained 低档（`B5_RATE` 缺省 2/s）压着，开压 `B5_KILL_AFTER_S`（缺省 4s）后 `docker kill` guards 容器（安检员罢工；无 restart 策略不会自动复活），灌入再续 `B5_PRESS_AFTER_KILL_S`（缺省 4s）后**保持压下态排干**（fail-closed 每段扫描烧 2s 超时，`B5_DOWN_DEADLINE_S` 缺省 420s）才 `docker start`。断言：kill 后创建、窗内执行完的 run 全部带 guards_block/DENIED 帧（reason ∈ guards_unreachable/guards_timeout）——零绕过扫描的成功出站；恢复腿行为如常。**就绪闸 = healthz 绿 + 首次真扫描成功双闸**（healthz 绿 ≠ 扫描就绪，guards 冷启动装载模型可让首扫超时被拒）。
- `node b5-gateway-down.mjs`（实验②）：knowledge_flow 停靠 kb_write 人审闸 → `docker compose stop gateway`（保安处关门）→ approve 断言不留「已批准无票」悬置态（502 mint_failed、卡仍 pending 可重试、run 仍 awaiting_approval）+ 压下期 autorun 拉起的 run 走明确 failed(mint_failed) 分支；`docker compose start gateway` 后同卡重批（恢复首笔可能撞死 keep-alive 再吃一个可重试 502——重试即成）→ 批准链如常。
- `node b5-sqlite-hammer.mjs`（实验③）：**只走 REST 公开写口**（POST :3002/api/v1/alerts）并发锤 case-backend，`B5_HAMMER_TIERS`（缺省 "1 4 16 64"）× `B5_HAMMER_SECONDS`（缺省 10s）爬档出延迟曲线 + 错误面观察表；本轮布景 **EVENT_DRIVEN=off** 起 agent（同 B1 口径，隔离 autorun 下游）。绝不以 rw 模式从宿主打开容器在写的 SQLite 文件。
