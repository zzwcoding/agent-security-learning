# 路线 1 守门员落地化方案

Type: grilling
Status: resolved
Blocked by: 01

## Answer（2026-08-27，用户全部确认）

1. **攻击演练覆盖面**：三类全做、先无防御演示全部中招——直接注入（用户输入下套）、间接注入（fetch 网页 / workspace 文件埋指令）、记忆投毒（`memory.json` 塞恶意记忆）。战利品两个：套出假密钥 `INTERNAL_API_KEY`；让 `run_command` 执行非用户意图命令。
2. **护栏落点**：llm-guard 只引入两个扫描器，但位置放对——PromptInjection 扫**用户输入 + 工具返回**两路（工具返回是间接注入入口），Secrets 扫输出侧防密钥外泄；PII 无真实场景，降为可选。
3. **Docker 沙盒**：选方案 A——网络保留（LLM API 与 fetch 工具硬依赖），其余收紧：非 root + `--read-only` + tmpfs `/tmp` + `--memory/--cpus` + drop capabilities。网络 egress 记为"本关已知缺口，路线 2 用 microsandbox 白名单解决"，作为失效假设素材积累。
4. **节奏（约 2 周，全职）**：攻击演练 2–3 天 → 护栏 3–4 天 → 容器加固 2–3 天 → Langfuse + 复盘 2–3 天。教学记录沿用 lessons 编号风格（0009 起）。精读：chapter2/prompt-injection、chapter4/execution-tools、NeMo Guardrails 五种 rail 文档、codex `sandbox_mode` 三档。
5. **交付物与验收**（`deliverables/route1/` 三件）：① 攻击复盘文档（payload + 无防御中招证据 + 逐层防御对比）② 防御回归（同批 payload 防御全开全被拦，作为路线 4 CI 回归集种子）③ 已知缺口清单（网络 egress、记忆投毒只演示未防，标注归属路线）。

## Question

图纸路线 1 的四步（① 亲手注入攻击自己的 Agent → ② 引入 llm-guard 三个扫描器 + 精读 NeMo Guardrails 分层拦截思想 → ③ 自写 Docker 沙盒参数 + 精读 codex 三档沙盒 → ④ 引入 Langfuse）如何具体落在起步 Agent 上：

- 每步改动起步 Agent 的哪个组件
- 精读素材选练兵场的哪个实验（候选：chapter2/prompt-injection 攻防矩阵、chapter4/execution-tools 分层安全架构）
- 本关交付物的具体形态（攻防复盘文档的骨架）
- "攻击自己"验收的具体 payload 与通过标准
