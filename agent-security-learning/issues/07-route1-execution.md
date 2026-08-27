# 路线 1 守门员执行

Type: task
Status: open
Blocked by:

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
