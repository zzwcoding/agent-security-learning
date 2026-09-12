# 66-b2-chain-burst: B2 链路突发与持续流（ingest 拐点）（P2）

**What to build:** `scripts/bench/b2-chain.mjs`（burst|sustained 两模式）。burst：100/500 条告警一次性灌 webhook（lib/gen-alert 唯一 sourceRef）；sustained：2/4/6/8 alerts/s × 2min（4 档，时长可配。**L0 档位修正 2026-09-12**：方案 §六规定持续流设计以 B3 实测为分母，B3 实测 4.6-4.8 run/s，原 10/30/50/100 为 B3 之前的猜测档；修正后亦合 sustained≤8/s 纪律。预期 2/4 档稳态、6/8 档积压增长——以数据为准）。测量：①e2e 延迟分布 alert 落库→run 拉起（从现有读口重建时间线）②autorun cursor 滞后（event_cursors vs outbox 最新事件的延迟近似，读口缺则如实标注口径）③错误率起跳档位=ingest 拐点（区分 422 坏包率 vs 5xx/超时）。结果进报告 B2 节+拐点结论。

**铁律:** 同票 64。

**Touches modules:** `m13`、`m1`、`m3`

**Belongs to spec:** specs/modules.md（m13 卡）；设计源 docs/research/2026-09-12-压力测试方案.md §三 B2

**Blocked by:** 65

**Status:** done（2026-09-12 子 agent 施工+主窗口验收：B2 六档入报告，ingest 无错误拐点，链路积压分界 4/s↔6/s，瓶颈归属分发水位带写入时 ~3.4-3.9 run/s）

**验收：**
- [x] burst/sustained 两模式脚本一键复现；每档一表
- [x] ingest 拐点结论写进报告（错误率起跳点+延迟陡升点分开说）
- [x] services/** 零改动；全量测试保持绿

**实现记录：**（2026-09-12，票 66 收口）
- `scripts/bench/b2-chain.mjs`（burst|sustained 两模式）+ `lib/b2.mjs`（纯函数面：档位解析/autocannon opts 构造/outbox 事件×run 配对/错误分类/积压收敛/表行）+ `test/b2.test.mjs`（13 测：含真 autocannon 对路径严格 stub 的冒烟）。施压全走 autocannon 编程 API（红线对账：真 import 真调用）；probe 布景与观察读表走 lib/http fetch（编排缝）。
- 观察：消费延迟 = alert.created（outbox 钟，与落库同事务）→ run create（审计钟）；未消化积压 = 未拉起 + 已拉起未终态 run。**口径如实标注：event_cursors 无公开读口**（agent 自有 SQLite），cursor 滞后按消费延迟+积压曲线近似（票面授权口径），零新增端点。
- autocannon 第三坑（首跑真踩，钉在 lib/b2.mjs 头注+单测）：`path` 必须写 requests[] 条目内，顶层 path 被条目缺省 `/` 覆盖 → 100 发全 404、服务端零痕迹。
- 六档真数字进报告 B2 节（burst 100/500 + sustained 2/4/6/8×120s，全部 201 零错误零双拉零 failed）：ingest 错误拐点未达；ingest P99 唯一陡升在 8/s 档（69→178ms）；链路积压分界在 4/s 与 6/s 之间（峰 12→261）；带 ingest 写时有效排干 ~3.4-3.9 run/s，低于 B3 净室 4.6-4.8（已记「已知边界注记」）。
- 门禁：harness `npm test` 40/40；全量 pnpm test 全绿只增不减；check_specs / check_boundary 双绿；services/** 与 compose 零改动；布景善后 down→清 data→九服务 up + setup-openfga + replay 12 告警基线恢复。
- L0 验收（主窗口）：亲跑双闸 PASS（spec gate 0 警告 / boundary gate 12/12 全有人查）+ bench 单测 40/40；全量绿子 agent 附输出原文；code-review 由 L0 直审代替（脚本/报告/diff 逐项过+闸+测试；正常派发非自实现回退）。收尾五样：spec 无出入（m13 卡接口行早已声明 b2-chain.mjs）/ modules.md 无需同步（lib/b2.mjs 包内部件）/ CONTEXT 无新术语 / 施工日志=报告方法节+已知边界注记+本记录（64/65 先例口径）/ 架构投影无变更（m13 非运行时件不在图内）。档位修正与偏差均已声明，无遗留标记。
