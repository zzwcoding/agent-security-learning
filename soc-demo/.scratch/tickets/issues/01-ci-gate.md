# 01: CI 守门：spec gate + lint/typecheck/test 进 Actions

**What to build:** 任何推送/PR 出红绿信号：Actions 跑 tools/check_specs.py 与 pnpm lint/typecheck/test。仓库级基建，不触及模块卡。补阶段 0 欠账——CI 要在第一行业务代码之前存在。

**Blocked by:** None (can start immediately)

**Touches modules:** 无（仓库级基建）

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] 推送/PR 自动跑 python3 tools/check_specs.py，非零退出即红（源：sdd-flow 阶段 0 纪律）
- [x] 人为把 specs/modules.md 依赖改出环，CI 变红（证明闸门活着）（源：spec gate 无环校验）
- [x] pnpm lint / typecheck / test 三连进 CI（源：仓库 package.json scripts）

---

## 实现记录（2026-09-08）

**出入说明**：票面写「补阶段 0 欠账」，但核实 git 历史，CI 在拆票（f872896）之前已建成——
e44423a（阶段 0.3：父仓 `.github/workflows/ci.yml` 三 job，paths 过滤 soc-demo/**）+
8726fc8（补 spec-gate job）。欠账实际已还，本票无代码改动，工作为逐条验证闸门活着。
按「有出入记进票、不就地猜」纪律记录于此，票面 What to build 保持原文。

**逐条核对**：

1. **推送/PR 自动跑 check_specs.py，非零即红**：ci.yml `spec-gate` job，working-directory
   soc-demo，逐字 `python3 tools/check_specs.py`。本地等价跑 → `spec gate: PASS（6 警告）`、
   exit=0（6 警告均为「规划中模块目录尚不存在」，bc092b9 已认定合法）。
2. **闸门活性（注入环）**：把 m2 卡「依赖: 无（叶子模块）」临时改为 `` `m1` `` →
   `FAIL  modules.md: 依赖成环：m1 → m2 → m1`、`spec gate: 1 失败 / 6 警告`、exit=1；
   `git checkout -- specs/modules.md` 还原。CI job 跑的是同一命令同一退出码，故 GitHub 上必红。
3. **三连进 CI**：ci.yml `ts` job 顺序 `pnpm lint → pnpm typecheck → pnpm test`（与根
   package.json scripts 一致）。本地全绿：lint exit=0；typecheck 4 包全 Done；test
   agent/case-backend/ingest 各 1 passed + web `--passWithNoTests` 放行。

**附带核实（不在验收内）**：python job（ruff + guards/gateway 各 1 passed）与 compose job
亦绿，CI 整体无隐性红灯。GitHub Actions 实际运行未触发（本票未推送），红绿信号以本地等价
命令 + job 步骤逐字一致性为证。教学：lessons/01-01-CI守门.md
