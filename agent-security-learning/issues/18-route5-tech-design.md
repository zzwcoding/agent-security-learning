# 路线 5 阶段 B：技术路线与框架设计

Type: grilling
Status: open
Blocked by: 17

## 目标

产出《SOC 数字员工 · 技术设计文档》——从产品手册到代码之间的那层。coding 之前的第二道工序。

## 内容

1. **组件图**：TS agent 端（supervisor + 子 agent）/ llm-guard+Presidio 微服务 / 复用后端（ContextForge、OpenFGA、三 server、microsandbox、Langfuse）/ Chroma / 新件（MCP 体检 CLI、evals/）
2. **数据流与接口**：告警进 → 案件 → 处置建议 → 审批 → 执行的完整链路；跨进程接口清单（HTTP/MCP/流式）
3. **多 agent 结构**：supervisor 派发模式、子 agent 分工与权限收窄（调查只读/响应只产建议/执行权在审批后）、 LangGraph.js supervisor 落地形态
4. **安全机制的 TS 版落位**：对照 v3 架构图六决策，逐个写明实现件（中间件/装饰器/微服务/普通 TS）
5. **目录结构与工程规范**：`soc-demo/` 目录树、包划分、测试策略、CI（evals 回归门槛）
6. **实施阶段切分**：阶段 1 骨架 → 阶段 N 演示脚本打磨的完整序列，每阶段有可观察变化（沿用 learn-by-rebuild 纪律）
7. **架构图 v4**：v3 + 多 agent 层 + Eval 构件（更新 `deliverables/review/消息流程图-TS架构设想.html` 或新图）

## 输入

- 阶段 A 的产品手册（票 17 产出）
- TS 架构图 v3 已定案决策、路线图谱全部已决票
- 水位线（同票 17，全程约束）
