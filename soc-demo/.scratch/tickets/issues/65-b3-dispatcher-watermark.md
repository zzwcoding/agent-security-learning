# 65-b3-dispatcher-watermark: B3 分发循环水位爬坡（P2）

**What to build:** `scripts/bench/b3-dispatcher.mjs`——并发 run 爬坡（1/5/10/20/50 档）：经 agent 公开拉起正门 POST /internal/runs（m3 卡公开接口）批量拉起 alert_flow，每档记录 ①run_jobs 队列深度时间序列（观察口走现有读口，缺则用 runs 状态分布近似并如实标注）②run queued→completed 端到端延迟分布（P50/P95/P99）③实测分发吞吐 run/s 对照理论 ~10 run/s（100ms tick）。可选加测：深队列中一个 awaiting_approval run 的审批 TTL 过期裁决延迟（派活的循环顺带扫描会不会被饿死）。结果进报告 B3 节+拐点结论。

**铁律:** 同票 64（公开面/现有读口/零生产代码/fake LLM/机器规格入表）。

**Touches modules:** `m13`、`m3`

**Belongs to spec:** specs/modules.md（m13 卡）；设计源 docs/research/2026-09-12-压力测试方案.md §二#1/§三 B3

**Blocked by:** 64

**Status:** ready

**验收：**
- [ ] 一键复现；每档一表（数字+机器规格+复现命令）
- [ ] 实测吞吐 vs 理论 ~10 run/s 对照结论写进报告（含偏差解释）
- [ ] services/** 零改动；全量测试保持绿

**实现记录：**（待填）
