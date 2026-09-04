# 路线 5 方案：SOC 数字员工 demo

Type: grilling
Status: open
Blocked by:

## Question

路线 5（最终面试 demo）的实施方案。已定前提：

- **需求叙事**：SOC 告警分诊与响应助手（"安全运营数字员工"）。参照系——Tracecat（叙事与四件套对应）、agentic-soc-platform（多 agent 分工）、M507/ai-soc-agent（最小闭环）、TheHive+Cortex（案件数据模型、responder 模式）、Wazuh（告警格式）、HolmesGPT（只读+RBAC 叙事技巧）
- **技术栈**：TS agent 端（LangChain.js + LangGraph.js supervisor）+ llm-guard/Presidio 微服务（FastAPI）+ 复用现有 Python 后端（ContextForge、OpenFGA、三 MCP server、microsandbox、Langfuse）；不引 Keycloak（教学版本地铸币，蓝图注释 STS）
- **范围**：TS 实现 v3 已定案 6/6 + 多 agent 协同 + 带防护 RAG + Eval 回归 CI；自我迭代与端云路由已砍
- **底牌分支**（并入验收）：子 agent 权限收窄、RAG 投毒演示、MCP 体检小工具（1-2 天独立 CLI）

待定议题（方案票要解决的）：

1. **告警与案件数据模型**：照 Wazuh 告警格式造假数据？案件结构照 TheHive？规模多大（几条告警够演示）
2. **supervisor 结构**：子 agent 拆几个、分工是什么（分诊/调查/响应？）、子 agent 权限收窄的具体形态（子 agent 只拿任务级最小 scope）
3. **RAG 内容**：知识库装什么（runbook/历史案件/威胁情报样例）、投毒演示的 payload 设计
4. **Eval 构件**：`evals/` 目录结构、标本集从路线 1 语料 + 缺口 4/5 种子怎么迁、CI 门槛怎么设
5. **MCP 体检工具**：从 0038 流程到独立 CLI 的边界（输入什么、输出什么）
6. **演示脚本**：面试现场演示的固定动作序列（正常分诊一条告警 / 注入被拦 / 越权 403 / 高级动作审批 / RAG 投毒被拦）
7. **交付物清单与目录结构**：demo 代码放哪（新目录？`ts-demo/`？）、架构图 v4（加多 agent 层 + Eval 构件）、设计决策文档
8. **实施顺序**：哪块先动（建议：TS 骨架 → 单 agent 全链路 → 拆多 agent → RAG → Eval → 体检工具）

输入依赖：TS 架构图 v3（deliverables/review/消息流程图-TS架构设想.html）、路线图谱所有已决票。
