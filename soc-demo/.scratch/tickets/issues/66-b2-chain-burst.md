# 66-b2-chain-burst: B2 链路突发与持续流（ingest 拐点）（P2）

**What to build:** `scripts/bench/b2-chain.mjs`（burst|sustained 两模式）。burst：100/500 条告警一次性灌 webhook（lib/gen-alert 唯一 sourceRef）；sustained：10/30/50/100 alerts/s 持续流（时长 2-5min 可配）。测量：①e2e 延迟分布 alert 落库→run 拉起（从现有读口重建时间线）②autorun cursor 滞后（event_cursors vs outbox 最新事件的延迟近似，读口缺则如实标注口径）③错误率起跳档位=ingest 拐点（区分 422 坏包率 vs 5xx/超时）。结果进报告 B2 节+拐点结论。

**铁律:** 同票 64。

**Touches modules:** `m13`、`m1`、`m3`

**Belongs to spec:** specs/modules.md（m13 卡）；设计源 docs/research/2026-09-12-压力测试方案.md §三 B2

**Blocked by:** 65

**Status:** ready

**验收：**
- [ ] burst/sustained 两模式脚本一键复现；每档一表
- [ ] ingest 拐点结论写进报告（错误率起跳点+延迟陡升点分开说）
- [ ] services/** 零改动；全量测试保持绿

**实现记录：**（待填）
