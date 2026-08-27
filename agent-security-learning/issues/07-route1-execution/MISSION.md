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
