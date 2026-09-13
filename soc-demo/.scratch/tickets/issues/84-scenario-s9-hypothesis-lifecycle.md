# 84-scenario-s9-hypothesis-lifecycle: 教学场景 S9：一个假设的一生（P2）

**What to build:** lessons/scenario/ 新增 S9（约 6 步 + big-picture.html）。主线：假设五态（proposed→hunting→concluded/refuted/cancelled）→ planner 选组合 → 扇出 2 子 run 并行取证 → judge 收敛 → gap 驱动第二轮换组合（C₂≠C₁ 画在轮次视图上）→ 命中建案/未命中证伪归档。核心教学点：多 agent 编排与动态路由的**正面展示**——"下一步查什么取决于这一步查到什么"从口号变直播画面。捣乱实验：① hunting 态取消——子任务安全停还是带病跑；② 预算烧光——状态落 cancelled 不冒充 refuted。场景题闯关 + TERMS 词条回指（词条本体归票 89）。

**铁律:** learn-by-rebuild 场景导览纪律（TERMS 比喻/亲手验证/捣乱实验/不改生产代码，发现 bug 转票）；每步文章带 文件:行号 指针（行号实测非凭记忆）；新术语解释永远回指 TERMS 同一处。

**Touches modules:** `m14`、`m2`、`m10`

**Belongs to spec:** PRD §13（事实底座）；lessons/scenario/00-导览总纲.md 场景清单加行

**Blocked by:** 79

**Status:** done

**验收：**
- [x] S9 分步文章 6 步左右落盘，覆盖五态全轨迹 + 轮次视图解读 —— 9-1..9-6 共六篇落盘；五态全轨迹实测：proposed（POST 201）→hunting（轮 1 intake 前置，audit transition）→concluded（hyp_0b1dccef 建案 case_000010）/refuted（PATCH at hunting 实测 200，轮 2 intake hypothesis_inactive:refuted）/cancelled（user_cancelled 与 budget 两因实测）；轮次视图解读=9-5（GET /api/v1/hypotheses/:id rounds JSON 实样逐字段解读，C₁≠C₂ 画在 tasks/params.focus 上）
- [x] 捣乱实验两个（取消/超预算）有亲手验证步骤与预期断言 —— ①取消（9-6 实验三段）：proposed 取消 409、hunting 取消 200+账面秒落、在途轮自然跑完、轮 2 relay 拉起被 intake 拒（hypothesis_inactive:cancelled）、审计五条链（create/transition×2/cancel/hunt_cancel）；②超预算（9-6）：临时 compose override 注入 HUNT_FLOW_MAX_TOKENS_PER_RUN=50（budget.ts 既定 env 口子，用后即删还原）→ run failed(budget_exceeded:token_budget, used=72>50, node=outcome) + kill 审计 FAILURE → 取消机制 → 账面 cancelled(reason=budget)、rounds=0，**不冒充 refuted**
- [x] big-picture.html 出图（planner→扇出→judge→gap 回路 + 五态）—— lessons/scenario/9-big-picture.html：单文件 mermaid v11 + svg-pan-zoom，style/script 段与 2-big-picture.html 逐字节一致（mermaid 块经 mermaid@11 headless parse 验证通过，jsdom 环境实测）；INTAKE→SANITIZE→PLAN_LLM→MENU_GATE→DISPATCH→AWAIT_CHILDREN→JUDGE_*→OUTCOME→GAP→RECORD_ROUND→RELAY→回 LAUNCH_ROUND 成环；五态=HYP_FSM 节点；图文对齐约定 8 条全守（节点明细表 40 节点四栏全量/一条边一个动作/跨容器红虚线+跨容器→服务:端口 标签/子图标题三段/速览段三小块+本场景数字 6 步 40 节点 15 闸/文章 📍 单向锚点/无悬停 tooltip/无存量回补需求——本场景首图）
- [x] 导览总纲场景清单加 S9 行；场景题闯关通过 —— 00-导览总纲.md「场景 9-13」表 S9 行 待办→✅、步数 约 6→6（实写六篇），表头同步"S9 ✅ / S10-S13 待办"防矛盾；闯关题每篇 1-3 题带 details 答案（9-6 收官三题覆盖五态轨迹/取消停止链/预算刻度），题干答案全部对照实测记录可复算
- [x] 与 S1（告警的一生）的结构呼应显式写出（被动链 vs 主动环）—— 9-1 开篇（被动链 vs 主动环定位）+ 9-6 站 2 五行对照表（起点/形态/"下一步查什么"/终点/治理重点）+ 9-6 收束（案卷是两条路共同汇点）
- [x] TERMS 回指检查（票 89 词条已落）：假设/轮次/子 run/扇出收敛/planner·judge·gap 等新术语首现均标 `TERMS「××」条`，解释回指 TERMS「编排循环」节，不另起比喻 —— 六篇 grep 复核：侦查怀疑书/查证轮/单趟差/派工菜单/撒出去·收回来/循环三件套/无人值守破案率/预案卡/状态机速记 全部在系列首现处挂 `TERMS「××」条`（9-1 补标单趟差/撒出去·收回来/派工菜单三处系列首现），比喻只用 TERMS 存量体系

**实现记录：**（2026-09-13，L2 自主完成）

① **产物**：`lessons/scenario/9-1.md`（发起假设与五态门口：同事务口径/五态查表/autorun 防重三闸/第三种 intake/轮号簿记）、`9-2.md`（intake 装配 + planner 三道闸：消毒/schema/菜单 fail-closed + 审计分痕 A + max_rounds 硬顶 + 机制默认档对照实验）、`9-3.md`（dispatch 扇出/两票制 narrow-scope/INV-11 铸票缝实测/子 run 独立人生/真执行体换件）、`9-4.md`（await_children 事件唤醒禁轮询/eventTap 扇出点/judge 三纪律：schema·防改写·置信地板）、`9-5.md`（gap 翻译/轮次归集幂等/relay 双保险/防转指纹/轮次视图逐字段解读 + C₂≠C₁ 实测 JSON）、`9-6.md`（converge 收敛分岔/S1 呼应对照表/捣乱①取消停止链/捣乱②预算烧光/收官三题）；`9-big-picture.html`（40 节点/15 安全闸/12 子图）。

② **亲手验证（本机栈 AGENT_LLM=fake，全部命令实跑）**：`bash scripts/hunt-smoke-82.sh` 全绿（票 82 先例复跑，SMOKE PASS）；主线轨迹 hyp_0b1dccef 两轮 concluded 建案 case_000010（轮次归集 JSON 实样进 9-5）；捣乱 A 取消三变体（proposed 409/hunting 200+轮 2 intake 拒/轮 2 中途取消竞态）、捣乱 D refuted 竞态（PATCH 200，轮 2 intake hypothesis_inactive:refuted）、捣乱 B 预算（override 注入→failed(token_budget 72>50)→cancelled(budget)→还原）、INV-11 缝闸实测（手拉 hunt_task 带 isolate_host → 502 mint_failed）、机制默认档对照（template_id="" → 菜单三件 → C₁=kb_lookup+siem_query）。

③ **发现缺陷转票（不在文章里顺手修）**：`.scratch/tickets/issues/93-hunt-converge-orphan-case.md` 两条实测发现——① converge 先建案后迁移（judge.ts:350→371），取消竞态下迁移 409 时案已建：孤儿案挂已取消假设（case_000011↔hyp_9fba78fd 实测复现）且无 hunt_case_created 审计；② 教学默认栈 fake 装配与狩猎内容不匹配（index.ts:193 makeLoopLlm 的 FakeLoopPlanner 发 {q} 参数不合狩猎工具签名契约 → 子 run 全 failed，FakeLoopJudge allOk 只查非空照判 hit 建案；内容层 makeHuntFakeLoopLlm 未接线）。文章中如实呈现现象（9-3 ②/9-4 观察点/9-6 实验①变体）并回指票 93。

④ **纪律自证**：零生产代码改动（唯一涉生产文件的操作是临时 docker-compose.override.yml 教具——untracked、用后即删、agent 容器已还原 healthy 且 env 复核为空）；全程无 git 操作；行号全部实测核对（flow/planner/judge/gap/task-flow/await-children/cancel/relay/ledger/template/llm-stubs/budget/launcher/autorun/run-kinds/app/index/graph/events/hunt-executor/hunt-pack/hunt.ts/weknora/statemachine/hypotheses/case-port/register 逐文件打开）；大图 mermaid 块经 mermaid@11 parse 验证（含 2-big-picture 对照）。

⑤ **收尾双闸与测试自证**：`python3 tools/check_specs.py` PASS（0 警告）、`python3 tools/check_boundary.py` PASS（0 越界）；测试基线 agent 704 passed|3 skip（68 文件，含 T01/T10/T18/T19/T06 全链真机用例）/ case-backend 76 / ingest 44|1 skip / gateway 43 / guards 28 / evals 112+33 场景全过；web 143/143 用例全过但**间歇性**收尾期 unhandled error（react-dom scheduler teardown 竞态，源 pages.test.tsx/HuntingPage——2026-09-13 15:52 在先遗留，先于本票首写 16:36，与文档改动无关）→ 已转票 94，不在本票顺手修。

- **L0 验收（主窗口，2026-09-13）**：双闸 PASS；大图 style/script 逐字节一致（md5 对比 2-big-picture）；6 篇文章 TERMS 回指 40 处、文件:行号 引用 138 处跨 33 文件（L0 实测计数）；总纲 S9 翻行步数修正；发现票 93/94 转票合规（零就地修）。收尾五样齐。