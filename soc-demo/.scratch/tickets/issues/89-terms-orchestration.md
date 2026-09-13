# 89-terms-orchestration: TERMS 新词条 + 导览总纲 S9-S13 五行（P2）

**What to build:** ① lessons/scenario/TERMS.md 按"业务比喻 ↔ 代码落点 ↔ 为什么"格式补 8 词条：假设（hypothesis）、轮次（round）、子 run（child run）、能力菜单（capability menu）、扇出/收敛（fan-out/converge）、planner/judge/gap（三件套可合一词条或分三）、自主发现率、业务模板（playbook template）。比喻只用 TERMS 存量体系那家（人与窗口/档案室/保安处体系内自洽，不新开比喻宇宙）。② 00-导览总纲.md 场景清单表加 S9-S13 五行（状态列随各场景票收口翻 ✅）。③ 全文术语一致性扫：S9-S13 场景文引用新词条时标 `TERMS「××」条` 首现规则。

**铁律:** 七原则第 4 条——同一术语的解释永远回指同一处；词条在场景文之前落（票 84-88 开工前置，故本票 blocked 最早但体量小）；比喻卡壳时宁可延迟开场景票也不先写凑合版。

**Touches modules:** 无（纯教学文档票）

**Belongs to spec:** CONTEXT.md 术语表（词条与语义核心对账，不同步处回写）

**Blocked by:** 79（机制代码落位后比喻才有代码落点可指；84-88 全部再 blocked 本票）

**Status:** done

**验收：**
- [x] 8 词条落 TERMS.md，格式三要素齐全，存量比喻体系自洽 —— 新节「编排循环」8 行（侦查怀疑书=假设/查证轮=round/单趟差=child run/派工菜单=capability menu/撒出去·收回来=fan-out·converge/循环三件套=planner·judge·gap/无人值守破案率=自主发现率/预案卡=业务模板），三栏齐全；比喻全部长在存量体系上（报案单/档案室/派活/手令/票面/闸/安检员/值班长/账面检索面），未开新比喻宇宙；另在「状态机速记」补 hypothesis 一行（与 CONTEXT 语义核心同源）
- [x] 00-导览总纲场景清单加 S9-S13 五行（步数/一句话/状态）—— 「### 场景 9-13」五列表格：S9 一个假设的一生（约6）/S10 动态编排的权限学（约5）/S11 第二个业务零增量（约4）/S12 紫队闭环：系统自证 2.0（约5）/S13 有记忆的狩猎（约5），一句话照 84-88 票面场景定位，状态列全部**待办**；表下注记声明「8 场景 41 步」总口径与覆盖矩阵列归场景票收口期统一翻新（全局数字归 0-0「全局数字」节，本票不动 0-0）
- [x] 与 CONTEXT.md 术语表逐条对账（不一致处回写 CONTEXT 或词条，二选一改）—— 逐条结论见实现记录②；两处小改回写 CONTEXT（假设提出者、轮间接力通道），其余六条判定一致、细节由 TERMS 承载
- [x] 84-88 各票验收含 TERMS 回指检查项（本票完成后其才有依据）—— 五张票各补一行（按各自词条点名定制），是本票对票文件的唯一改动

**实现记录：**（2026-09-13，L2 自主完成）

① **产物**：
- `lessons/scenario/TERMS.md`：新节「编排循环」（8 词条）+「状态机速记」补 hypothesis 行。词条"代码真实落点"全部行号实测（本日工作区 HEAD 逐文件打开核对，非凭记忆）：flow.ts:41/52-69/94/136-207/152-170、planner.ts:162/235-238/250/254、judge.ts:53/91/174/196/335、gap.ts:121、task-flow.ts:18/76、await-children.ts:38、cancel.ts:78、relay.ts:26、ledger.ts:41、launcher.ts:35、template.ts:9-21、run-kinds.ts:285/306/347-351、budget.ts:127、autorun.ts:218、hunt-pack.ts:51/64/88、hunt-executor.ts:108、weknora.ts:42、case-backend hypotheses.ts:107/122/204、statemachine.ts:27、evals/src/rigs/purple.ts:298、fixtures/hunt-templates/（4 张卡）、eval-results/purple-team.json。
- `lessons/scenario/00-导览总纲.md`：场景清单尾部加「场景 9-13」五行表（见验收②）。
- `CONTEXT.md`：两处小改回写（见②）。
- `.scratch/tickets/issues/84..88-*.md`：各补一行 TERMS 回指检查验收项。

② **对账结论（逐条）**：
1. 假设——CONTEXT 写"分析师主动提出"，与 S12 机制事实（攻击 fixture 自动转假设，actor=system，hypotheses.ts:118 proposed_by 可为 actor）不符 → **小改回写 CONTEXT**（提出者=分析师为主 + 紫队 fixture 自动转出），TERMS 承载五态与误读辨析（怀疑书≠案件）。
2. 轮次——CONTEXT 定义一致（选组合→扇出→收敛迭代）；预算双闸/防转指纹/六节点链等机制细节 TERMS 承载，CONTEXT 不动。
3. 子 run——CONTEXT 定义一致（narrow-scope 票+事件唤醒回收）；两票铸票缝行号与安全语义 TERMS 承载。
4. 能力菜单——CONTEXT"= tools.manifest + 剧本库，未登记 fail-closed"与机制一致；TERMS 细化为"宇宙 ⊆ manifest 对账咬死 + 每轮可见菜单=模板子集 + 双闸（planner 契约拒 T04 / 铸票缝拒 INV-11）"，不改 CONTEXT。
5. 扇出/收敛——CONTEXT"收敛判据是证据充分性，不是该跑的跑完了"与 judge.ts 机制逐字一致（schema 判据+0.7 置信地板）；TERMS 承载落地行号。
6. planner·judge·gap——CONTEXT「编排循环」行已覆盖语义骨架；TERMS 三件套词条展开消毒/schema 化/防合谋/审计分痕，CONTEXT 不动。
7. 自主发现率——CONTEXT"预算内无人工干预发现攻击"与 purple.ts:432 口径注一致；ground truth 三重验+防注水细节 TERMS 承载。
8. 业务模板——CONTEXT"句式族+菜单子集+轮次上限、零机制代码"无错误；waves/max_tasks/与 weknora 剧本库分家等细节 TERMS 承载，CONTEXT 不动。
9. **额外发现并回写**：CONTEXT「hunt_flow / hunt_task」行原文"轮间 outbox 接力"与机制不符——接力件订阅的是 agent 进程内事件总线（run_events → events.ts eventTap → LoopEventBus，fire-and-forget、幂等锚 ledger.findByRound），m2 outbox（叫号屏）只在 autorun 消费链上；relay.ts 头注释明确划界 → **小改回写 CONTEXT**（"轮间由 round_relay 事件经接力件拉起下一轮：agent 进程内事件总线消费 run_events，非 m2 outbox"），防与 TERMS「叫号屏」条混淆成两套比喻。

③ **偏差与声明**：
- 0-0.md 本票零改动（边界红线）；「8 场景 41 步」→ 13 场景口径、覆盖矩阵补列、0-0「全局数字」更新，均声明归 S9-S13 场景票收口期（00-导览总纲新表下注记已写明）。
- 票 84-88 补检查项时 85/86 曾误删「实现记录」行、当场发现当场还原，终态五票文件结构完整。
- 双闸：`python3 tools/check_specs.py` → PASS（0 警告）；`python3 tools/check_boundary.py` → PASS（0 越界，12/12 条禁令全有人查），exit 均 0——纯文档改动零影响确认。全程未做任何 git 操作。

- **L0 验收（主窗口，2026-09-13）**：双闸 PASS + TERMS 47 表行/总纲五行（状态=待办不越权）/84-88 五票各 1 行核对。偏差①（85/86 曾误删实现记录行当场还原）核过终态完整；偏差②（0-0 全局数字不动）=票面声明口径正确。**教学链前置件齐，84-88 可开工（互动档，等用户"下一步"）。**