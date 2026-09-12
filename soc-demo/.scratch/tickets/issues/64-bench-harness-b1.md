# 64-bench-harness-b1: 压测工具面骨架 + B1 单端点微基准（P2）

**What to build:** 按 `docs/research/2026-09-12-压力测试方案.md` 落 m13 工具面。`scripts/bench/` 独立小包（自有 package.json，`type:module`；devDependencies 装 autocannon——**框架红线：autocannon 必须真引入且被脚本真调用**）。产出：①`lib/http.mjs`（fetch 包装，baseURL/target 可注入=测试缝）、`lib/report.mjs`（结果表输出：数字+机器规格 os.cpus()+复现命令）、`lib/gen-alert.mjs`（sourceRef 唯一化告警生成器——防 M2 去重把压测流量吃成 occurrences+1）；②`b1-endpoints.mjs` 四张基准卡：ingest webhook（真 fixture body）/ M2 upsert（同 sourceRef 二连发，201 新建与 200 去重两分支各测）/ gateway mint（请求形态先核 `services/gateway` 真代码）/ M2 读口 GET alerts；③初跑数字进 `docs/research/2026-09-12-压力测试报告.md`（新建：方法节+机器规格+B1 表）；④harness 单测（stub 服务 200/422/超时三态 + 生成器唯一性）。

**铁律:** 只走公开 HTTP/SSE 面，禁 import services 内部（中立层 R3 既有闸）；观察读表走现有 REST 读口，缺读口停下回报 L0，不顺手加端点；compose 默认 profile + fake LLM 零出网；**services/** 零改动**。

**Touches modules:** `m13`、`m1`、`m2`、`m9`

**Belongs to spec:** specs/modules.md（m13 卡）；设计源 docs/research/2026-09-12-压力测试方案.md §三 B0/B1

**Blocked by:** 无

**Status:** done（2026-09-12 子 agent 施工+主窗口验收：四卡数字入报告，首个真瓶颈= M2 读口 76 req/s）

**验收：**
- [x] autocannon 出现在 scripts/bench/package.json 且被脚本 import（框架红线对账项）
- [x] 四张基准卡脚本可一键复现跑出表；报告文件含机器规格与复现命令
- [x] harness 单测绿（stub 三态+生成器唯一性）
- [x] check_boundary.py 绿；services/** 零改动；全量 pnpm test 保持全绿只增不减

**实现记录：**（2026-09-12，票 64 收口）
- `scripts/bench/` 独立小包（不在 pnpm workspace，npm 自装）：`lib/http.mjs`（fetch 包装，baseUrl 注入缝）、`lib/report.mjs`（markdown 行+机器规格+状态码对账）、`lib/gen-alert.mjs`（Wazuh 形态生成器，sourceRef 全局唯一递增防 INV-6；结构读 `fixtures/alerts/` 真样例）。`b1-endpoints.mjs` 四卡（ingest-webhook / m2-upsert 两分支 / gateway-mint / m2-read），autocannon 8.0.0 编程 API，档位红线 conn≤20、duration≤30s、限速 250-500/s。
- autocannon 两个实测坑钉在脚本头注：①body 内 `idReplacement` 的 Content-Length 按 27 字节/id 硬编码，本版 hyperid 产 24 字节→服务端挂死，逐请求唯一体必须走 `requests[].setupRequest`；②requests 数组每连接独立从 0 迭代。③默认百分位集无 95——向 hdr-histogram-percentiles-obj 导出的 percentiles 数组补插 95 得真 HDR 分位（该包升为显式 devDependency）。
- 首批真数字进 `docs/research/2026-09-12-压力测试报告.md`（Apple M4×10 核/16GB；四卡零错误；分支校验 201/200 对账过）。要点：写面 500/s 稳（SQLite 单写者远未到顶）、mint P99 19ms、读口 `GET alerts?host=` 只跑 76/s 且 P99 1.67s（EXISTS 全表扫+N+1 observables，15301 行表）——读口是 B1 首个实测露头的瓶颈。
- 口径偏离（报告方法节同记）：B1 轮布景 `EVENT_DRIVEN=off` 起 agent（端点微基准隔离 autorun 下游；该 env 无公开读口可查，靠布景纪律）。
- harness 单测 15/15 绿（`npm test` = `node --test`；Node 22.22 在非 ASCII cwd 下传显式目录参 `node --test test/` 会拒解析，故用默认发现，文件口径不变）。
- 门禁：check_boundary self-test 18/18 + 实跑 PASS（9/9）；spec gate PASS（0 警告）；pnpm test 全绿（agent 559+3skip / evals 99+33 / 其余包全绿）。
- 布景善后：压完 down→清 data→默认九服务 up + setup-openfga + replay（12 告警），教学线基线恢复。
