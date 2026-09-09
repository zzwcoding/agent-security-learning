# 45-l0-adr0003-rigs-exemption: ADR 0003 允许清单扩展 + 边界例外列变更追认（票 44·F6 伴生）

**What to build:** 票 44·F6 把 `evals/src/scenarios.ts`（1334 行）按 facet 拆进 `evals/src/rigs/`（shared/approval/replay/chat/investigation/triage/attack 七文件，行为零变化：evals 99 测试与 `pnpm test:eval` 34 照旧全绿）。七个 rig 文件与 scenarios.ts 同为「组装入口」——import services 内部，落在 ADR 0003 裁决 3 允许清单（runner/scenarios/judge/assertions/suite.test.ts）之外。按票 44 票面授权，编码窗口已同步改了边界规则表例外列（花括号组）；tools/check_boundary.py 的既有花括号展开直接解析目录级组，**闸代码零改动**。本票请 L0 追认两件事：

1. **ADR 0003 裁决 3「允许」清单补**（精确清单，语义不变——仍是组装入口性质的符号，禁触 case-backend `db.ts`/`store.ts` 写路径照旧）：
   - `evals/src/rigs/shared.ts`（布景共享件：ScenarioSkip/ScenarioOutcome/ScenarioDeps/skeleton/attackCheck/makeFakeMint/stubFga）
   - `evals/src/rigs/approval.ts`（票 11 素材审批 rig）
   - `evals/src/rigs/replay.ts`（票 09 INV-6 rig）
   - `evals/src/rigs/chat.ts`（票 18 对话 rig：runChatPrompt/伪造批准/登录四身份）
   - `evals/src/rigs/investigation.ts`（票 14/42 调查 rig）
   - `evals/src/rigs/triage.ts`（票 35 凭证金丝雀 rig）
   - `evals/src/rigs/attack.ts`（票 17 RAG + 票 16 沙箱 rig）
2. **追认 specs/modules.md 边界规则表 R2 行例外列变更**（2026-09-09 由票 44 编码窗口落，表内已标注「待 L0 追认」）：例外列在原两组之间插入 `evals/src/rigs/{shared,approval,replay,chat,investigation,triage,attack}.ts` 花括号组。

**Touches modules:** `m11`

**Belongs to spec:** specs/modules.md（边界规则）

**Status:** ready-for-L0

- [ ] ADR 0003 裁决 3 允许清单补七文件（L0 改 ADR，本票不改）
- [ ] 边界规则表 R2 例外列变更追认（不追认则回滚：rig 文件并回 scenarios.ts 单文件）

## 备注

- 豁免解析零新机制：例外列花括号展开是 tools/check_boundary.py 既有能力（`parse_evals_exemption`，目录前缀 + `{a,b}.ts` 同样命中），self-test 17/17 与真跑 0 越界均为变更后实测。
- ADR 0003 的复核条款（每轮体检第四条对账）对 rigs 文件同样适用：用途漂移即收回豁免。


## L0 追认记录（2026-09-09）

两条均追认：① ADR 0003 裁决 3 允许清单延伸至 evals/src/rigs/ 七文件（纯机械搬移，角色与禁令不变）；② 边界规则表 R2 例外列变更成立（已引 ADR 0003）。回滚预案（rig 并回单文件）无需启动。
