# 28-m0-boundary-gate: 边界闸补建 + 越界清偿（A2+E2+E3）

**What to build:** specs/modules.md「边界规则」节机器化：自写零依赖边界闸脚本（消费边界规则表与豁免清单，格式照 tools/check_specs.py 先例）进父仓库 CI ts job；同提交内清偿现存越界：① workers/triage/testkit.ts 直引 case-backend 内部 → 改夹具数据+真 REST（E2，ADR 0003 裁决 4 明确不豁免）；② ingest replay.test.ts 反引 scripts/replay.ts → 改子进程执行（E3）。

**Blocked by:** （ADR 0003 裁决 3/4 已落）

**Touches modules:** `m2`, `m4`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] 边界闸脚本进 CI 且真消费「边界规则」表：豁免有理由、越界必红（源：skill 阶段 6·核心原则 7）
- [x] testkit 不再 import case-backend 内部，triage 全部既有测试语义保持（源：对账二-5·ADR 0003 裁决 4）
- [x] ingest 测试不反引 scripts/，replay 行为断言保持（源：对账二-6）
- [x] CI 全绿含新闸；「边界规则」表每条禁令都有人查（源：sdd-flow 阶段 6 验收对象）

## 实现记录（2026-09-09）

- **边界闸** `tools/check_boundary.py`（零依赖 python3，~300 行）：解析「## 边界规则」表 → 9 个检查器（R1 服务互引 / R2 evals 豁免清单 / R3 中立层 / R4 scripts 反引 / R5 mcp-audit / R6 web / R7 guards×gateway / R8 依赖方向 / R9 healthz）。**表与闸两向锁**：表删行 → 失配 FAIL，表加闸不认识的行 → 「无人查」FAIL。入口 `pnpm check:boundary`（self-test 17/17 + 真仓库检查），挂父仓库 ci.yml ts job（装包前跑，零依赖）。TDD：先写 self-test（违规样本必红/豁免样本必绿），红 12/17 → 实现后 17/17；对真仓库先红（钉在体检证据 testkit.ts:5/6、replay.test.ts:4）→ 清偿后绿。
- **豁免解析口径**（ADR 0003 裁决 3 的机器化，供体检第四条复核）：`{runner,scenarios,judge,assertions}.ts` 花括号展开，**组装件的 `.test.ts` 伴侣文件同角色一并豁免**（suite.test.ts 被单独点名即先例）；纯 `import type` 是编译期契约不产生运行时模块边，不算引用内部实现；case-backend `db.ts`/`store.ts` 触碰对任何 evals 文件绝对禁令。
- **E2**：testkit `startCaseBackend` 改 spawn 真 case-backend 入口（tsx 子进程 + 一次性 SQLite 文件库 + 随机端口 + /healthz 就绪轮询 + 端口竞态重试）；`CaseBackend` 接口缩到 `{url, close}`。enrichment 唯一直插库点（种 tlp=4 observable，票 15 布景）改走 REST 正门——`POST /api/v1/cases/:id/observables` 本就支持 tlp/pap/ioc 直传，行形状与审计语义不变。testkit 其余能力（sealTicket/makeTaskTicket/fakeScan/httpJson/alertInputFromWazuh/seedAlert）原样保留，11 个测试文件零改动。
- **E3**：replay.test.ts 删 `import { replay }`，改 `execFile` 子进程跑 `tsx scripts/replay.ts`，断言对象从内存返回值换成 CLI stdout（汇总行 N pushed/C created/D dedup + 逐条 alert_id）——「条数=目录数、全 201 新建、零去重、id 互不重复」语义逐条保留；铁律①③的 readFileSync 源码断言不动（非 import）。
- **验证**：check_specs PASS(0 警告)；lint/typecheck 绿；套件基线不降——evals 92 / agent 302+2 skipped / case-backend 50 / web 73 / mcp-audit 13 / ingest 21。
