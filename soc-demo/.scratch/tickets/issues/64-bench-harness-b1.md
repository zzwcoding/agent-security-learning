# 64-bench-harness-b1: 压测工具面骨架 + B1 单端点微基准（P2）

**What to build:** 按 `docs/research/2026-09-12-压力测试方案.md` 落 m13 工具面。`scripts/bench/` 独立小包（自有 package.json，`type:module`；devDependencies 装 autocannon——**框架红线：autocannon 必须真引入且被脚本真调用**）。产出：①`lib/http.mjs`（fetch 包装，baseURL/target 可注入=测试缝）、`lib/report.mjs`（结果表输出：数字+机器规格 os.cpus()+复现命令）、`lib/gen-alert.mjs`（sourceRef 唯一化告警生成器——防 M2 去重把压测流量吃成 occurrences+1）；②`b1-endpoints.mjs` 四张基准卡：ingest webhook（真 fixture body）/ M2 upsert（同 sourceRef 二连发，201 新建与 200 去重两分支各测）/ gateway mint（请求形态先核 `services/gateway` 真代码）/ M2 读口 GET alerts；③初跑数字进 `docs/research/2026-09-12-压力测试报告.md`（新建：方法节+机器规格+B1 表）；④harness 单测（stub 服务 200/422/超时三态 + 生成器唯一性）。

**铁律:** 只走公开 HTTP/SSE 面，禁 import services 内部（中立层 R3 既有闸）；观察读表走现有 REST 读口，缺读口停下回报 L0，不顺手加端点；compose 默认 profile + fake LLM 零出网；**services/** 零改动**。

**Touches modules:** `m13`、`m1`、`m2`、`m9`

**Belongs to spec:** specs/modules.md（m13 卡）；设计源 docs/research/2026-09-12-压力测试方案.md §三 B0/B1

**Blocked by:** 无

**Status:** ready

**验收：**
- [ ] autocannon 出现在 scripts/bench/package.json 且被脚本 import（框架红线对账项）
- [ ] 四张基准卡脚本可一键复现跑出表；报告文件含机器规格与复现命令
- [ ] harness 单测绿（stub 三态+生成器唯一性）
- [ ] check_boundary.py 绿；services/** 零改动；全量 pnpm test 保持全绿只增不减

**实现记录：**（待填）
