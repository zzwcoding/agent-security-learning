# #54 · accuracy.test.ts 横切断言在全量并发下偶发超时

- Status: open
- Priority: P3（8.5 收官三连复跑再复现两次，建议按 P2 对待）
- Discovered: 2026-09-10（场景 7 步 7.1 全量首跑实测，7.4 复核；8.5 再复现）
- Modules: agent / triage

## 缺口解剖

位置：`services/agent/workers/triage/accuracy.test.ts:113-121` —— 横切断言串行 `triageOne` 全部 11 条标注告警，每条走**真 guards HTTP 扫描**。

现象：全量并发跑时偶发超时翻红（vitest 默认 5s；单跑实测 3.9-4.08s/11 案，逼近上限，无余量）。同日复跑与收官体检多轮全绿 —— 负载时序问题非回归，但 8.5 收官三连复跑中复现两次，频率不低。

## 修法（推荐：显式放大 testTimeout）

该用例显式放大 `testTimeout`（建议 15_000，给 3 倍余量）——最小改动，**保留"真 guards 管道横切"的守门价值**。不采用换 fakeScan（丢真管道语义）或收敛 maxWorkers（影响全仓并发度）方案。

## 验收清单

- [ ] 该用例 testTimeout 显式放大，注释说明为何（真 guards HTTP 串行 11 案，默认 5s 无余量）
- [ ] 全量测试连跑三遍全绿（模拟当日负载；若环境无 guards 依赖则按该用例既有 skip 语义处理）
- [ ] 零删除：既有断言一条不删不改
- [ ] 总纲学习日志该条目追加"已修复（#54）"注记
- [ ] 改动最小化：只动 accuracy.test.ts 的超时参数

## 实现记录

（待填）
