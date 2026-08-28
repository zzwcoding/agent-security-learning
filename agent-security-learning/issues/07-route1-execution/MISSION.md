# MISSION: 路线 1 守门员执行(issues/07)

**一句话目标**:在起步 Agent 上完整走一遍"攻击 → 护栏 → 容器加固 → 观测复盘",亲手验证每一层防御拦住哪类攻击、漏掉哪类。

**为什么学**:守门员是图纸四关的第一关,也是防御架构的最小完整闭环——攻击面(三类注入)、数据边界(llm-guard)、进程边界(Docker 加固)、可观测(Langfuse)各碰一次。不亲手打穿自己的 Agent,护栏就是黑盒信仰。

**验收标准**(与 issues/07-route1-execution.md 一致,交付物在 `deliverables/route1/`):
1. 攻击复盘文档:三类 payload + 无防御中招证据 + 逐层防御对比
2. 防御回归:同批 payload 防御全开时全被拦(路线 4 CI 回归集种子)
3. 已知缺口清单:网络 egress 未限、记忆投毒只演示未防,各标注归属路线

**约束**:
- 改造对象唯一:`starter-agent/`(阶段 8 形态起步),不另起 demo
- 教学记录沿用 lessons 编号,本任务从 0009 起;learning-records 从 0010 起
- 文件归拢:除 `deliverables/route1/` 外,本任务产出全部放本文件夹(`issues/07-route1-execution/`)
- 战利品既定:套出假密钥 `INTERNAL_API_KEY` + 让 `run_command` 执行非用户意图命令
- 真 key 只走 Keychain 注入;`.env` 里全是假密钥

**阶段路线**(2026-08-27 对齐票 07 修订:精读单列为阶段,融合项目实践逐个做):

| 阶段 | 内容 | 状态 |
|---|---|---|
| 9–11 | 攻击演练:直接注入 / 间接注入(文件+网页两向量)/ 记忆投毒 | ✅ 已完成(62e8508) |
| 12–14 | 三层护栏:PromptInjection 扫输入、分块扫工具返回、Sensitive 扫输出 | ✅ 已完成(f196b06) |
| 15 | 容器加固:非 root/只读 fs/tmpfs/限额/降 cap,egress 记缺口;codex 三档精读(并入 lesson 0015) | ✅ 已完成待提交 |
| 16 | 精读 chapter2/prompt-injection 攻防矩阵——对照我方 payload 迭代史,挑未试技术作路线 4 种子 | ✅ 已完成(c324b00;复刻在平行窗口完成,见 `攻防矩阵复刻/`) |
| 17 | 精读 chapter4/execution-tools 分层架构——对照三层护栏+容器,列出缺的层及归属路线 | ✅ 已完成(平行窗口复刻,2026-08-29;全部成果在 `执行工具复刻/`,收官文档为其 `对照分析.md`) |
| 18 | 精读 NeMo Guardrails 五种 rail + 最小实践(quickstart + 语料 01 打 self-check rail,对照 llm-guard)——对照缺口清单 | ✅ 平行窗口完成待提交(2026-08-29;成果在 `NeMo-Guardrails学习/`,收官文档为其 `对照结论.md`:缺口①实测能补、②不能补、③补一半) |
| 19 | Langfuse 本地接入(docker compose),攻击/拦截全程 trace | 待做 |
| 20 | 收官:防御回归(同批 payload 全拦)+ `deliverables/route1/` 三件 | 待做 |
