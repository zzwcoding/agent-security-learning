# 67-b4-sse-fanout: B4 SSE 扇出（P2）

**What to build:** `scripts/bench/b4-sse.mjs`——1 个高事件率 run × N 订阅者（50/100/200 档，SSE 客户端自实现 fetch-stream，带 Last-Event-ID 重连语义）；观测：①订阅者滞后（首帧延迟/补发长度）②agent 容器 CPU（docker stats 采样入表）。对照组：同 N 的 1s 轮询客户端（取餐铃 vs 轮询的真实数字）。结果进报告 B4 节+结论。

**铁律:** 同票 64。

**Touches modules:** `m13`、`m3`

**Belongs to spec:** specs/modules.md（m13 卡）；设计源 docs/research/2026-09-12-压力测试方案.md §二#4/§三 B4

**Blocked by:** 66

**Status:** done（2026-09-12 子 agent 施工：三档表+轮询对照入报告 B4 节，每订阅者定时器代价 ≈0.1% 容器 CPU、延迟零劣化）

**验收：**
- [x] 脚本一键复现；50/100/200 三档表齐全（含轮询对照列）
- [x] 结论写进报告（每订阅者 100ms 定时器的实测代价）
- [x] services/** 零改动；全量测试保持绿

**实现记录：**（2026-09-12，票 67 收口）
- `scripts/bench/b4-sse.mjs`（probe + 50/100/200）+ `lib/b4.mjs`（SSE 帧解析/游标推进/补发对账/e2e 聚合/docker stats 解析/表渲染 + SSE 订阅客户端与 1s 轮询客户端两个注入缝）+ `test/b4.test.mjs` 14 项（stub SSE 服务器冒烟含 Last-Event-ID 重连，不依赖真栈）。
- **高事件率 run 造法（实测选定）**：M2 裸建案 + 灌 50 个 tlp/pap=0 ip observable（`POST /api/v1/cases[/:id/observables]`）→ `case_flow`——事件量 ≈13+2K 线性可调，实测 113 事件/run ~0.4s；单 run 更高事件率无公开面可造（alert_flow 上限 ~60 帧），如实按票面「脚本可稳定复现」口径执行。三相位：实况扇出（N 份帧序列对账一致）→ 重连补发（Last-Event-ID 铺真实 id 集，600 重连对账差 0，expect=0 空补发为合法读数——首跑 checker 误报已修）→ 停靠挂流（knowledge_flow 停 kb_write 人审闸，B3 closedCaseWithRun 同款布景；30s 空闲挂流 vs 0 订阅者基线，同一条 docker stats 采样线切账）。对照组：同 N 的 1s 轮询打 M2 `audit?objectId=`（顺序纪律：基线→launch→立刻开轮，首跑把基线夹在中间虚高了可见延迟——已修）。
- **undici 坑（钉在 lib/b4.mjs 头注）**：Node 22.22 fetch 缺省 bodyTimeout=300s 掐空闲 SSE 挂流（真踩 301s UND_ERR_BODY_TIMEOUT）——客户端必须 bodyTimeout:0 dispatcher（undici 升为 bench devDependency）。
- **数字（第二轮，17:31Z；第一轮 17:24Z 同机复跑同向）**：e2e P50 48/55/57ms、P99 101/102/102ms 三档钉在 100ms tick 量子化不随 N 劣化；hold 空载 agent CPU 9.1/15.9/18.5%（基线 ~1.4%）→ **每订阅者 ≈0.06-0.15% 容器 CPU**；补发中位 56/max 112 条对账差 0。轮询对照：终态可见延迟 P50 ~750ms（**SSE 快 13-16×**）、case-backend +2-4% @50-200 req/s（object_id 无索引，便宜依赖小表）。
- services/** 与 compose 零改动（只读路由表核实 SSE 语义）；门禁：bench npm test 54/54 绿（b4 新增 14）、check_specs PASS（0 警告）、check_boundary PASS（12/12）、pnpm test 全量绿、soc-demo 布景已还原（round 2 后栈在跑，教学线基线未动）。
- L0 验收（主窗口）：亲跑双闸 PASS（spec gate 0 警告 / boundary gate 12/12）+ bench 单测 54/54；变更清单核对 7 文件全落在 bench/报告/票；报告 B4 节结构核对（方法/三档/轮询对照/拐点结论四小节齐）。收尾五样：spec 无出入（m13 卡接口行 b4-sse.mjs 已声明）/ modules.md 无需同步 / CONTEXT 无新术语 / 施工日志=报告 B4 节+已知边界注记+本记录 / 架构投影无变更。偏差两处均已声明且合规（高事件率 run 造法=票面「脚本可稳定复现」授权口径；undici devDependency=工具坑非框架替代——autocannon 红线由 b1/b2/b3 满足，b4 长连流票面明定自实现客户端）。无遗留标记。
