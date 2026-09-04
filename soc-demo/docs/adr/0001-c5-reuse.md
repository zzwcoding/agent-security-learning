# ADR 0001：C5（Python 安全控制面）复用策略——拆件复用，不搬仓库

- 状态：已接受（2026-09-04，阶段 0.4 spike 结论）
- 背景：PRD §4.1 C5 假设复用路线 3 在 `.scratch/agent-security-learning/starter-agent/` 搭建的 Python 后端（ContextForge 网关 / OpenFGA / 凭证代理 / 任务票）。该工程是学习工作区内嵌形态，本 spike 盘点其中可干净剥离的件。

## 盘点结果

| 件 | 位置 | 规模 | 结论 |
|---|---|---|---|
| 凭证代理（LLM 路） | `proxy.py` | 74 行，仅依赖 fastapi/httpx | **直接搬**：UPSTREAM 与密钥 env 名参数化后即 M9-S1 的 LLM 路实现 |
| 任务票签发/校验 | `task_token.py` | 63 行，纯标准库 HMAC | **搬票型不搬代码**：HS256 + scope + exp + task_head 格式继承；TS 侧用 node:crypto 重写 verify（~30 行，agent 服务是 TS）；gateway 侧签票可直接用 py 原版 |
| FGA 闸插件 | `gateway/plugins/fga_check.py` + `config.yaml` | 91+42 行 | **直接搬**：改 user_map 即对位 PRD 附录 A.2 角色矩阵 |
| OpenFGA 建模脚本 | `scripts/setup-openfga.sh` | 109 行，幂等重建 | **搬思路重建模型**：授权模型按 PRD A.2（4 角色 × 4 工具族）重新建模，脚本的幂等/内存存储模式照抄 |
| egress 过滤插件 | `gateway/plugins/deny_command.py` | 43 行 | **不搬**：soc-demo 无 shell 工具（高危动作走 mock 执行器），留作参考 |
| ContextForge 本体 | docker 镜像 + 插件目录 | 现成镜像 | **compose 加服务**：`gateway` 从占位 FastAPI 换成 contextforge 镜像 + 挂载 plugins/ |
| OpenFGA 本体 | docker 镜像 | 现成镜像 | **compose 加服务**（当前骨架缺，阶段 2 补） |
| starter-agent 其余（agent.py / mcp_servers / memory_guard 等） | — | — | **不搬**：那是路线 1-3 的靶子件；soc-demo 的 agent 是 TS/LangGraph 全新写 |

## 决策

1. C5 采用**拆件复用**：上表"直接搬/搬思路"四件迁入 soc-demo，其余不迁。
2. `gateway` 服务的最终形态 = contextforge 镜像 + openfga 镜像 + 自写插件/脚本薄层（当前 FastAPI 占位在阶段 2 替换）。
3. 工作量估计：小。各件均 <110 行，以参数化改造为主；主要工作是 OpenFGA 授权模型按 A.2 重建（约半天）。

## 两个暴露出来的范围问题（2026-09-04 用户已拍板）

- **Langfuse 砍出默认路径**：审计主链路走 M2 AuditEntry；Langfuse 降为可选 compose profile `observability`，不进默认一键启动。**已确认。**
- **microsandbox 保留，改挂 M6**：用户决定不砍——M6 富化升级为"analyzer 沙箱运行时"（Cortex 真实架构：analyzer 是可执行代码，在一次性 microVM 里跑），攻击面改为刻意布置的教学场景（投毒 analyzer 逃逸/外联被拦）。**已确认，方案 A。**

## 后果

- 好：复用的是经过路线 1-3 攻击实测的件，不是纸面代码；soc-demo 不背 starter-agent 的教学包袱。
- 风险：TS 侧验票与 Python 侧签票共享 HMAC 密钥与票型，两端实现漂移风险 → 用同一组票面 fixture（固定 ticket 字符串 + 期望验证结果）做跨语言契约测试。
