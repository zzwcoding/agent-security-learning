# 路线 5 阶段 A：参考项目深析与需求制造

Type: grilling
Status: open
Blocked by:

## 目标

产出《SOC 数字员工 · 产品手册》——路线 5 的需求层文档。coding 之前的第一道工序。

## 水位线（全程约束，继承自原票 17）

这不是教学练习，是能拿去面试的小型产品。反玩具标准：① 真实数据（Wazuh 格式告警/TheHive 案件模型）② 真实攻击（路线 1-3 实测语料 + AgentDojo/garak）③ 实证数字 ④ 机制完整（令牌真签真验真焚）⑤ 一键可起 + README 即讲解稿 ⑥ 决策有据（参照系或实证）。**规模可小，每个组件必须是真的；宁砍组件，不降真实度。**

## 工序

1. **参考项目深析**（research 子 agent 串行）：Tracecat、agentic-soc-platform、M507/ai-soc-agent、TheHive+Cortex、Wazuh 告警格式、HolmesGPT——每个读 README/文档/代码结构，提取：它解决什么需求、功能清单、数据模型、agent 分工、审批/安全设计、我们可借什么
2. **制造需求**（grilling）：结合 JD 能力要求（三份 JD，见 research-jd与需求叙事.md），把" SOC 数字员工"展开成需求集——用户角色、使用场景、功能列表（每个功能标注：服务哪个 JD 能力点/哪张底牌）
3. **产品手册成文**：愿景与叙事、角色与场景、功能规格（含演示脚本草案）、非功能规格（安全/审计/可观测）、参照系对照表、明确不做的（边界声明）

## 产出

`.scratch/agent-security-learning/issues/17-route5-plan/product-handbook.md`（或独立 deliverable，方案里定）

## 输入

- `issues/17-route5-plan/research-jd与需求叙事.md`（JD 分析+业务画像+底牌策略）
- 路线图谱全部已决票；TS 架构图 v3（deliverables/review/消息流程图-TS架构设想.html）
