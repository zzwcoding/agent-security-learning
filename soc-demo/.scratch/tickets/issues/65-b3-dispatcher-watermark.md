# 65-b3-dispatcher-watermark: B3 分发循环水位爬坡（P2）

**What to build:** `scripts/bench/b3-dispatcher.mjs`——并发 run 爬坡（1/5/10/20/50 档）：经 agent 公开拉起正门 POST /internal/runs（m3 卡公开接口）批量拉起 alert_flow，每档记录 ①run_jobs 队列深度时间序列（观察口走现有读口，缺则用 runs 状态分布近似并如实标注）②run queued→completed 端到端延迟分布（P50/P95/P99）③实测分发吞吐 run/s 对照理论 ~10 run/s（100ms tick）。可选加测：深队列中一个 awaiting_approval run 的审批 TTL 过期裁决延迟（派活的循环顺带扫描会不会被饿死）。结果进报告 B3 节+拐点结论。

**铁律:** 同票 64（公开面/现有读口/零生产代码/fake LLM/机器规格入表）。

**Touches modules:** `m13`、`m3`

**Belongs to spec:** specs/modules.md（m13 卡）；设计源 docs/research/2026-09-12-压力测试方案.md §二#1/§三 B3

**Blocked by:** 64

**Status:** done（2026-09-12 子 agent 施工：五档全绿入报告 B3 节，实测 4.6-4.8 run/s vs 理论 10（周期=执行 106ms+tick 100ms 拆账吻合），TTL 加测深队列不饿死）

**验收：**
- [x] 一键复现；每档一表（数字+机器规格+复现命令）
- [x] 实测吞吐 vs 理论 ~10 run/s 对照结论写进报告（含偏差解释）
- [x] services/** 零改动；全量测试保持绿

**实现记录：**（2026-09-12，票 65 完成）
- `scripts/bench/b3-dispatcher.mjs`（+ `lib/b3.mjs` 纯函数面 + `test/b3.test.mjs`）：probe → 五档 1/5/10/20/50 爬坡；拉起全走 `POST /internal/runs`（202 秒回核真）；观察全走现有读口——run 状态/时刻真相 = M2 `GET /api/v1/audit`（agent HttpAuditSink 汇入，createdAt 为 agent 记录时刻），队列深度时间序列离线重构；**run_jobs 无公开读口，按票面许可用 runs 状态分布近似并在报告标注口径**；SQLite 绝不从宿主 rw 打开。
- 数字（报告 B3 节全表）：实测吞吐平台 4.6-4.8 run/s vs 理论 ~10——偏差拆账：tick 串行 await 执行完才排下轮，真实周期 = 执行耗时(中位 106ms) + 100ms tick ≈ 206ms → 天花板 4.85 run/s，与实测吻合；~10 run/s 是执行耗时→0 的极限。拐点：吞吐无拐点（1→50 档稳定、零 failed），延迟随队列深度线性 ~206ms/位（档 50 P99 10.3s）——「吞吐恒定、延迟受害」的排队型瓶颈。
- TTL 加测（可选做完）：APPROVAL_TTL_SECONDS 经 /tmp compose override 注入 5s 重启 agent（compose 未透传该 env，零仓库改动，测完还原 86400s 复核）；深队列（压队 30 条 ≈ 6.2s 队列工作 > TTL）下 kb_write 卡 TTL+174ms 被时间裁决、run failed(approval_expired)、裁决时队列深度仍 7——扫描在 dispatchOnce 第①步领任务之前，不会被饿死。首跑压队 15 条队列先排干（深度 0）判废重跑。
- 防重对账：90 条 alert_flow 双拉=0、让路=0、审计缺口=0（推→拉串行配对 + hasActiveRun 挡 autorun）。
- 布景已还原：默认九服务 down→清 data→up→setup-openfga→replay，四口+guards healthz 全绿。
