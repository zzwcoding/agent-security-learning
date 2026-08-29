# 路线 1 守门员执行

Type: task
Status: resolved
Blocked by:

## Answer(2026-08-29)

**交付物位置**(`deliverables/route1/` 三件):
1. `01-攻击复盘.md`——复习主文档:三类攻击 payload 迭代史与中招证据、三层护栏/容器/观测逐层对比、三个精读窗口收获、面试一句话总括
2. `02-防御回归.md`——攻击×防御矩阵(6 条 payload 全形态),每条挂 learning-record 证据指针;含路线 4 CI 判定的复用标准
3. `03-已知缺口清单.md`——7 条缺口逐条标注归属路线与备料方案 + 路线 4 CI 回归集第一批种子(5 条)

**验收证据**:
- ① 中招证据:learning-records 0010(直接)、0011(间接两向量)、0012(记忆投毒),全部含工具调用实录
- ② 防御回归:records 0013/0014/0015 的分层拦截实录 + 0019(Langfuse trace 留证);"全被拦"的精确含义=战利品拿不到(格式毒与记忆毒穿透前置层,输出层兜底),已在 02 文档诚实标注
- ③ 缺口清单:含 egress(容器内实测外网可达)与记忆投毒(毒源未防毒效被截)两条票定缺口,另累积 5 条新发现缺口

**与方案 02 的偏差**:
1. 精读不止"读":chapter2/chapter4 升级为平行窗口**完整复刻**(产出 `攻防矩阵复刻/`、`执行工具复刻/`),NeMo 为精读+最小实践(`NeMo-Guardrails学习/`);codex 三档精读并入 lesson 0015
2. Secrets 扫描器落地为 llm-guard 的 Sensitive(0.3.16 版本里 Secrets 在输入侧,输出侧对应件是 Sensitive);实体白名单收窄(默认集误报爆表)
3. PII 扫描器按方案定为可选,未装
4. 防御回归未全量重跑(用户决策):矩阵引用各阶段实测证据,语料与判定标准已备,路线 4 建 CI 时原样重跑刷新
5. 战利品 key 升级为高熵 `ik-live-...`(低熵值扫描器不可见,演习靶子须与防御雷达配套)
6. 工具返回护栏为自写分块扫描(match_type=SENTENCE 依赖 nltk punkt_tab,下载被本机安全策略拦截,改零依赖方案)

教学记录:lessons 0009–0017、learning-records 0010–0020,均在 `issues/07-route1-execution/`。

## Question

按「路线 1 守门员落地化方案」（issues/02）的已定决策执行，全程约 2 周：

1. **攻击演练**（2–3 天）：直接注入 / 间接注入 / 记忆投毒三类，先无防御演示全部中招；战利品 = 假密钥外泄 + `run_command` 执行非预期命令。精读练兵场 chapter2/prompt-injection。
2. **护栏**（3–4 天）：llm-guard PromptInjection 扫用户输入 + 工具返回两路，Secrets 扫输出；PII 可选。精读 chapter4/execution-tools 分层架构 + NeMo Guardrails 五种 rail 文档。
3. **容器加固**（2–3 天）：非 root + `--read-only` + tmpfs `/tmp` + `--memory/--cpus` + drop capabilities；网络保留，egress 记已知缺口。精读 codex `sandbox_mode` 三档实现。
4. **Langfuse + 复盘**（2–3 天）：docker compose 起本地 Langfuse 接入 trace；写复盘文档。

教学记录沿用 lessons 编号（0009 起）。

验收（`deliverables/route1/` 三件）：
1. 攻击复盘文档：三类 payload + 无防御中招证据 + 逐层防御对比
2. 防御回归：同批 payload 防御全开时全被拦（路线 4 CI 回归集的第一批种子）
3. 已知缺口清单：网络 egress 未限、记忆投毒只演示未防，各标注留给哪条路线

解决时 Answer 记录交付物位置、与方案的偏差、验收证据。
