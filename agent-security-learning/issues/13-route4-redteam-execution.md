# 路线 4 红队执行

Type: task
Status: open
Blocked by: 12
Assignee: divh（2026-09-02 本次会话 claim）

> 执行前先读：票 12 Answer（全部已定决策）+ 票 06 Answer（工具链落地形态）+ 缺口清单（`deliverables/route1/03-已知缺口清单.md` 第 4/5/6 条与两批 CI 种子）+ 路线 3 收官形态（`deliverables/route3/` 三件）。

## Question

按「路线 4 红队落地化方案」（issues/12）的已定决策执行，量级估 5–7 天（不作死线）：

1. **开工先决 + 武器校准**（约 0.5–1 天）：安装校准 garak/PyRIT（密钥纪律沿用：API key 走 Keychain）；FastAPI 薄 HTTP 层包 agent（`/chat`，内部照走网关，端到端全防线）；garak 白名单五族先打武器校准靶（反向案例 coding-agent/erp-agent/user-memory）确认出 hits。
2. **garak 宽谱扫描**（约 1 天）：白名单五族（promptinject/encoding/packagehallucination/leakreplay 全量+dan 节选）打收官形态端到端；hits 人工分诊，真阳性移植进 PyRIT 回归集；出被拦率报告。
3. **PyRIT 深度编排**（约 2 天）：进程内 PromptTarget（只绕 HTTP 薄层、不绕任何防线）；五条确定性 scorer（票 12 第 9 条）；PAIR/Crescendo 全量+TAP 对照一轮；TS client 通道场景（bob 越权回归 fail closed+user_map 滥用面书面结论）；judge=MiniMax-M2 固定并记版本。
4. **剥层对照 + 缺口核销**（约 1.5 天）：≥3 组单层失效实验（串联闸任务票/D4/法官一件、记忆装载三闸、网关 FGA/EGRESS），每组记"应被哪层拦/实测哪层拦/漏到第几层"；标定流程落地（标本集+阈值扫描报告）并入 CI；拆行投毒多轮场景打穿透率，出会话级聚合判定方案文档。
5. **回归集 + 收官**（约 1 天）：`starter-agent/redteam-regression/`（payloads/+tests/+calibration/）；种子十条收编、确定性断言 100% 过；probe 精读（promptinject+encoding）与 vulnerability-db/audit-db 案例对照分析穿插完成；三件交付物落 `deliverables/route4/`；六条验收判表落 `issues/13-route4-redteam-execution/attack-validation/`；本票写 Answer 关闭。

教学编号续排：lessons 从 **0042** 起，learning-records 从 **0043** 起，MISSION 阶段从 **47** 起；知识卡片续 `知识卡片-碎片/` 现有编号。

验收（六条判表，语义以票 12 Answer 第 10 条为准）：
1. 武器校准：校准靶出 hits + 收官形态同族被拦率报告
2. 端到端红队：四方向 campaign 纵深判表（每条攻击标"应被哪层拦/实测哪层拦/漏到第几层"）
3. 剥层对照：≥3 组单层失效实验，每组有兜底层结论
4. TS client 通道：bob 越权全 fail closed + user_map 滥用面书面结论
5. 缺口核销：4/5 标定流程落地入 CI；6 穿透率量化+聚合判定方案文档
6. 回归集与交付物：种子十条收编、确定性断言 100% 过、触发纪律写明；三件交付物落 `deliverables/route4/`

约束：
- 靶子唯一：路线 3 收官形态 `starter-agent/`；红队代码新增限 `starter-agent/redteam-regression/` + 薄 HTTP 层文件；**防线代码本关不动**（缺口 6 聚合闸实现明确排除）；打穿一律记缺口不临修
- 运行形态不变：Agent 宿主机直跑，shell/fetch 执行面在一次性 microVM；garak/PyRIT 宿主进程跑
- 战利品不变：假密钥 `INTERNAL_API_KEY` + `run_command` 非预期命令；真 key 只走 Keychain；`.env` 永远假密钥
- judge 型结果只出报告不进硬门槛；judge 与被测同模型的偏差在案、关键结论人工复核
- 文件归拢：除 `deliverables/route4/` 与 `starter-agent/redteam-regression/` 外，本任务产出全部放 `issues/13-route4-redteam-execution/`
- garak/PyRIT 迭代快：踩坑记 record，不硬撑

解决时 Answer 记录：交付物位置、与票 12 方案的偏差、验收证据（attack-validation 判表）。
