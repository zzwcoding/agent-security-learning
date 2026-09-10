# #54 · accuracy.test.ts 横切断言在全量并发下偶发超时

- Status: done
- Priority: P3（8.5 收官三连复跑再复现两次，建议按 P2 对待）
- Discovered: 2026-09-10（场景 7 步 7.1 全量首跑实测，7.4 复核；8.5 再复现）
- Modules: agent / triage

## 缺口解剖

位置：`services/agent/workers/triage/accuracy.test.ts:113-121` —— 横切断言串行 `triageOne` 全部 11 条标注告警，每条走**真 guards HTTP 扫描**。

现象：全量并发跑时偶发超时翻红（vitest 默认 5s；单跑实测 3.9-4.08s/11 案，逼近上限，无余量）。同日复跑与收官体检多轮全绿 —— 负载时序问题非回归，但 8.5 收官三连复跑中复现两次，频率不低。

## 修法（推荐：显式放大 testTimeout）

该用例显式放大 `testTimeout`（建议 15_000，给 3 倍余量）——最小改动，**保留"真 guards 管道横切"的守门价值**。不采用换 fakeScan（丢真管道语义）或收敛 maxWorkers（影响全仓并发度）方案。

## 验收清单

- [x] 该用例 testTimeout 显式放大，注释说明为何（真 guards HTTP 串行 11 案，默认 5s 无余量）
- [x] 全量测试连跑三遍全绿（模拟当日负载；若环境无 guards 依赖则按该用例既有 skip 语义处理）
- [x] 零删除：既有断言一条不删不改
- [x] 总纲学习日志该条目追加"已修复（#54）"注记
- [x] 改动最小化：只动 accuracy.test.ts 的超时参数

## 实现记录

2026-09-10，按票内推荐修法（显式放大 testTimeout）执行。

- **改动**：`services/agent/workers/triage/accuracy.test.ts` 一个文件，净 +6 行注释 / 1 行超时参数——横切断言大用例（"注入变体：guards DENIED 全部落审计；全部 11 条 0 次 L2 工具调用"，原 :113）收尾 `});` → `}, 15_000);`，即 vitest test 级第三参数写法（仓库先例 `src/run-dispatcher.test.ts:373/392` 同款；vitest 3.2.7 支持，等价 options 对象 `{ timeout: 15_000 }` 未用）。首行块注释交代为何：一个 test 里串行 triageOne 全部 11 条标注案，每案起真 case-backend 子进程 + guards 通道扫描 + 生产 HttpTriageM2，单跑实测 3.9-4.8s，vitest 默认 5s 无余量、全量并发偶发超时翻红。
- **语义保留**：不换 fakeScan、不动 maxWorkers，真管道横切守门价值原样；既有断言一条不删不改（git diff 仅注释 + 超时参数）。
- **验证（九服务在线，guards :8001 healthy）**：
  - 单跑该文件：14/14 passed，横切断言 3975ms（15s 上限内，余量 ~3.8 倍）。
  - 全量三连跑（`cd soc-demo/services/agent && pnpm exec vitest run`）：
    1. 48 files passed，494 passed + 3 skipped，Duration 12.86s
    2. 48 files passed，494 passed + 3 skipped，Duration 12.49s
    3. 48 files passed，494 passed + 3 skipped，Duration 12.57s
  - 基线吻合票 53 后口径 494+3skipped：0 新增用例（纯参数改动），只增不减达成。
- **范围纪律**：仅动授权两文件一文档（accuracy.test.ts / 本票 / 00-导览总纲.md 学习日志与 #54 条目回填）；无 git 写操作；weknora复刻/ 并行线未触碰。
