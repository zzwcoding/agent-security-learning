# 69-b5-defense-report-lessons: B5 防线压下实验 + 总报告 + 教学文（收官）（P2）

**What to build:** ①防线压下实验三件（压着票 66/67 的负载做）：guards 进程 kill/挂起→闸 fail-closed 断言（工具调用被拒绝而非放行，恢复后行为）；gateway 停→铸票失败路径不留"已批准无票"悬置态断言；SQLite 并发写锤到 busy 超时边界→延迟曲线与错误面观察。每个实验一个脚本（`scripts/bench/b5-*.mjs`）+fail-closed 断言。②总报告：四天花板理论 vs 实测总表+各层拐点汇总（docs/research/2026-09-12-压力测试报告.md 收尾章）。③`lessons/` 教学文一篇："压力也是一种异常：防线在压下"——按 learn-by-rebuild 六节模板，含亲手验证与捣乱实验，术语回指 TERMS。④实验后栈恢复干净（down+data 清空，布景可一键重建）。

**铁律:** 同票 64；实验产生的 PII 用假数据；密钥不进仓库。

**Touches modules:** `m13`、`m9`、`m2`、`m3`

**Belongs to spec:** specs/modules.md（m13 卡）；设计源 docs/research/2026-09-12-压力测试方案.md §三 B5/§四

**Blocked by:** 68

**Status:** ready

**验收：**
- [ ] 三实验脚本+fail-closed 断言全绿（过载下 INV-1 语义成立）
- [ ] 总报告四天花板对照表齐全，拐点结论一句一条
- [ ] lessons 教学文落盘（六节模板，比喻用 TERMS 存量体系）
- [ ] 实验后布景一键重建验证；全量测试保持绿

**实现记录：**（待填）
