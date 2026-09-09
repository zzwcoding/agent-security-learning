# 30-m1-alert-wire-contract: alert wire 全链契约 + m1 hostname/TLP 映射补齐（A3+G1）

**What to build:** ① m1 映射补两行：agent.name→hostname observable（FR-M2.4 归并空转修复）+ TLP 溯源（wazuh.ts 硬编码 tlp:2 改为按规则/管道抽取，缺口=ticket15-2）；② fixtures/alerts 具名 fixture 做 ingest→M2→agent 全链 wire 断言（告警进案→observables→triage 读到的形状逐字段锁）。

**Blocked by:** （无）

**Touches modules:** `m1`, `m2`, `m4`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] hostname observable 从回放流水线真实进案，FR-M2.4 归并对回放数据生效（源：遗留标记 13-1·FR-M2.4）
- [x] TLP 溯源：非默认 tlp 的告警能进案（enrich/02 类布景不再需 DB 直种）（源：遗留标记 15-2·§5.3）
- [x] 全链 fixture 契约测试：ingest 映射/REST/agent 消费三段同锚（源：对账三-15）

## 实现记录（2026-09-08）

**① m1 映射补齐** `services/ingest/src/wazuh.ts`：

- hostname observable：`extractObservables` 增 `agent.name → hostname`（首位，基础设施字段不带 untrusted tag；缺 agent 字段不炸不抽）。至此 FR-M2.4 归并（同主机 24h TP 只建 1 案）与 case 标题 primary entity 对回放流水线数据生效——票 13 出入①闭合。
- TLP 溯源：新增 `tlpFromAlert`（导出，照 severityFromLevel 先例供单测）。**记票口径**（PRD §5.1 只给「默认 2/2」，无现成字段映射规则，按票面授权自定）：
  1. 显式字段 `rule.tlp`（0-4 界内整数）优先——Wazuh 规则自定义字段盖章；
  2. 否则扫 `rule.groups` 与 `rule.description` 里的 `tlp:<色|数字>` 标记（大小写不敏感；white|clear→0、green→1、amber→2、amber+strict→3、red→4，TheHive 5.2 后口径）；多个命中取最严（fail-closed）；
  3. 都没有 → 默认 2（PRD §5.1）；非法值（tlp:9、tlp:redis）不认，落默认。
- observable 继承告警级 tlp（`mapWazuhAlert` 里 observables map 注入 tlp；ingest 侧 `ObservableInput` 增可选 tlp/pap，结构对齐即契约）——M6 富化闸门读 observable.tlp，tlp:red 告警的产物随管道进案就是 tlp=4，enrich/02 类布景不再需 DB 直种——票 15 出入②闭合。pap 固定 2（无现成溯源源，维持 PRD 默认）。
- 新具名 fixture `fixtures/alerts/vt-87105-malware-tlp-red.json`（rule.groups 带 `tlp:red` 的 VT 恶意文件告警）作 TLP 溯源的回放锚。

**② 全链 wire 契约测试** `services/agent/workers/triage/wire-contract.test.ts`（2 测试）：

- 锚 = fixtures/alerts 具名 fixture（ssh-5712-real.json + 新 tlp-red fixture）；三段同锁：① 真 ingest 子进程的 webhook 正门（真 mapWazuhAlert，非 testkit 布景副本）→ ② 真 case-backend REST 存取形状逐字段（mapAlert wire：camelCase/tags/untrusted 附录段/occurrences/tlp）→ ③ 生产 HttpTriageM2 消费形状（AlertDto 逐字段）+ FR-M2.4 归并（findActiveCases→createCase→归并命中、case 标题 primary entity=hostname）+ TLP 溯源到 case observables。
- 服务起停照 testkit 票 28 先例：`startIngest(caseBackendUrl)` 加进 testkit.ts（子进程 tsx ingest 入口 + PORT/CASE_BACKEND_URL env + /healthz 就绪轮询）；跨服务零源码 import，全走公开 REST 面（边界规则 R1）。

**测试**：ingest 21→31（wazuh.test.ts 增 hostname/TLP 两 describe 共 10 测试，TDD 先红 9 后绿）；agent 302+2sk→304+2sk（wire 契约 2 测试）；replay.test.ts NAMED 表 obs 数组按新映射表更新（hostname 首位，预期值的真值化，非语义改动）。全仓 `pnpm test` 绿（agent 304+2sk / ingest 31 / case-backend 50 / web 77 / evals 31 用例 triage_accuracy=1.000），`python3 tools/check_specs.py` PASS（0 警告）、`pnpm check:boundary` PASS（self-test 17/17）、`pnpm lint`/`pnpm typecheck` 全绿。

### 出入与偏差记录（不改 spec 本体）

1. **TLP 抽取口径为自定规则**（上文三条），PRD §5.1/§5.3 与 m1 卡均无现成字段映射——票面授权「按合理规则实现并记票」。后续若 PRD 补映射表，以 PRD 为准回改 tlpFromAlert 单点。
2. **testkit 布景副本与真映射的漂移面仍在**：alertInputFromWazuh（测试布景 stub）仍是「tlp 恒 2」的简化副本（分诊布景不依赖 tlp），其 hostname 已在票 28 前先行补了——票 30 起两边形状由 wire-contract.test.ts 经真 webhook 对活锁住；stub 注释已改指票 30。彻底删 stub 属 evals 快道注入口径（决策 #10）范围，不在本票。
3. **test 名「7 具名 + 4 注入变体」→「具名 fixture 全目录」**：新增 tlp-red fixture 后目录 12 条，replay 全目录计数是动态的，仅标题措辞随真值更新。
