# 80-ir-playbook-template: 应急取证模板——架构验收件（第二业务零增量验证）（P1）

**What to build:** 循环的第二个用户，**本票是"一套循环五块业务"主张的架构验收实验**。只允许新增：① 应急取证假设模板（template_id=ir_host_compromise + 假设句式族 + 菜单子集收窄到 host 维度工具 + 轮次上限）；② fake LLM 的 ir 确定性 plan 覆盖（持久化机制→执行历史→外联的轮次轨迹）；③ 必要时的 fixture 语料补条。**不允许**改 m14 任何文件、planner/judge/gap 任何实现、票务与预算任何代码——需要改 = 循环抽象错了，停下回报 L0 回阶段 2（这是本票存在的目的）。

**铁律:** 验收核心是一条否定式断言——**本票 git diff 与 m14/planner/judge/gap/票务/预算目录的交集为空**（CI 脚本断言，不过 = 架构返工而非本票返工）；应急取证的 L2 动作（隔离主机）依旧只走人工审批回路，模板产出遏制建议文本为止。

**Touches modules:** 无机制层（纯内容层；消费 m14/m5 公开接口）

**Belongs to spec:** specs/orchestration-loop.md「应急取证零 m14 增量」验收条（票 72 定稿的那条杀手验收）


**Spec 绑定:** specs/orchestration-loop.md 验收测试表 T20（spec 已定稿 2026-09-12）

**Blocked by:** 79

**Status:** done

**验收：**
- [x] 应急假设端到端跑通（fake LLM 轮次轨迹与期望一致）
- [ ] **零增量断言绿：diff 与机制层目录交集为空（CI 可查）**
- [x] 若断言不过：产出循环抽象缺口清单，回 L0 裁决 —— 否定分支未触发（零时刻需改机制层，无缺口清单）
- [x] 菜单收窄后 host 维度外工具不可选（对齐票 79 对账测试范式）

**实现记录：**（2026-09-13 落地）

- **架构验收结论（本票的存在意义）**：第二业务（应急取证）落地**零机制增量成立**——`git diff` 8 个文件与机制层领地（m14 orchestration/ 目录 + budget.ts + token-ports.ts×2 + verify-ticket.ts）交集为 0；fake LLM 连代码都不用改（`makeHuntFakeLoopLlm` 本就是 wave 数据驱动，ir 轨迹纯靠模板 fixture 表达），「循环抽象 + 内容包」的分层主张在内容与测试两侧同时得到验证。无循环抽象缺口清单（验收第 3 条为否定分支，未触发）。
- **①模板（数据文件）**：`fixtures/hunt-templates/ir_host_compromise.json`——template_id=ir_host_compromise + 主机失陷确认句式族（2 句式，{host}/{persistence}/{path}/{dst_ip} 槽位与 example_slots 同源）+ 菜单收窄 host 维度（playbook_lookup/graph_query + proc_lineage/file_change/outbound_conn，**剔除 web_access_query**，PRD §13.4b 应急取实行）+ 轮次上限 6/单轮 2 + `containment_suggestions` 文本建议（隔离主机须人工审批——INV-3/9 铁律的数据面）。零登记增量：ir 菜单 ⊆ 票 79 既有票面并集（manifest/注册表/run-kinds 零触碰，`ir-template.test.ts` 对账钉死）。
- **②fake LLM ir plan 覆盖**：确定性四轮轨迹由模板 `waves` 数据驱动——剧本开局 → 持久化机制（proc_lineage process=cron role=parent）→ 执行历史（file_change path=sh.php）→ 外联+图谱并行（outbound_conn dst_ip=203.0.113.66）；gap 逐轮换组合，相邻指纹必不同（防转闸）。hunt-pack.ts 仅加性三处：fixture 接口可选 `containment_suggestions?` 字段、`renderContainmentSuggestions()` 渲染器、fake judge 在 hit 半边附带遏制建议文本（planner 族识别闭包态——judge 无菜单输入；79 三族无该字段，行为零变化）。
- **③语料补条**：`fixtures/weknora/playbooks.json` 补 `pb-ir-host-compromise-001`（剧本开局不是空查；标题/目的不含「狩猎」字样——79 的 `query:"狩猎"` 计数断言零波动）；告警语料零补条（cron 持久化/FIM 落盘/203.0.113.66 信标既有语料恰好覆盖失陷三线）。
- **④T20 零增量断言脚本**：`tools/check_zero_increment.py`（中立层零依赖 Python，check_boundary.py 惯例：positional root / `--base <rev>` / `--self-test` / 退出码 0/1、fail-closed——git 不可用即 FAIL）。变更集 = 基线→工作树 tracked 全变更（--no-renames 含删除）+ 未跟踪新件；领地匹配目录前缀按路径段（不吃同前缀兄弟目录）。自测 14/14（红样本必抓/干净必绿/临时真 git 仓端到端：未提交修改、已提交 + `--base`、删除、坏基线炸响）。CI 可查：脚本头注明父仓 ci.yml 挂法（`--base "$(git merge-base …)"`）；父仓 ci.yml 在 soc-demo 外，接线归 L0。
- **e2e（evals，79 范式扩展）**：`hunting.ts` rig 录 note 原文（RecordingCasePort 加性记账）+ `hunt_pack_e2e` 扩 ir 族：4 轮轨迹 + judge hit 建案挂 hypothesis_id + **register 零写入**（register 只在 miss 归档步）+ 遏制建议只进 note 文本（body 含「仅文本建议，动作须经人工审批」、structured.recommended_actions 纯 string[]）+ 四族子 run 摘要全真执行体。
- **测试**：新增 `workers/investigation/ir-template.test.ts` 16 测试（模板契约/host 收窄/零登记增量/机制投影/四轮轨迹/judge hit+miss/遏制建议/**菜单收窄 × planner 菜单闸：27 个菜单外工具（含 web 维度 web_access_query、register、isolate_host）100% offmenu_tool DENIED + 菜单内正控**）；hunting.test.ts 扩 4 族；hunt-pack.test.ts「三族齐备」对账扩 4 族（79 同款扩格先例）。全量 `pnpm test` 六 workspace 全绿：evals 103、mcp-audit 14、agent 689 passed|3 skip（既有 skip）、case-backend 76、ingest 44|1 skip（既有）、web 111。typecheck 全绿；改动文件 eslint 0 错（仓内 3 个**既有** lint error 未触碰文件，76 票已挂账阶段 E 体检候选）。双闸：check_specs PASS(0 警告)、check_boundary PASS(0 越界) + self-test 22/22；零增量闸对本票 diff PASS（8 文件 × 5 领地：交集 0）。
- **偏差**：无实质偏差。零 specs/modules.md 改动（e2e 走已豁免的 hunting rig 扩展路线，未新增 evals 文件——规避 R2 例外列改动，该列是 L0 专属产出）。

- **L0 验收（主窗口，2026-09-13）**：亲跑双闸 PASS + 零增量闸本机复跑 PASS（子 agent 首跑 9 文件×5 领地交集 0；L0 提交前复跑 11 文件×5 领地交集 0）+ agent 全量 689|3skip 绿（ir e2e 4 轮轨迹/27 个菜单外工具含 isolate_host 全拒）。**CI 接线（验收注明的 L0 职责，已落）**：package.json `check:zero-increment` 脚本 + 父仓 ci.yml ts job 与边界闸同槽位一行（浅克隆回退 HEAD 的限制已注释在案；PR diff 档本地强制）。收尾五样齐。**阶段 C（工具与内容 78-80）至此收官，分层铁律试金石通过。**