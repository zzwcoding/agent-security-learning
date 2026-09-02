---
title: Agent 安全知识体系 · ASI 分类视角
markmap:
  initialExpandLevel: 2
  maxWidth: 360
---

# ASI01–10 分类视角（行业词汇押题图）

> 主轴：OWASP Top 10 for Agentic Applications（2025-12-09 发布）。每个一级分支 = 一条 ASI 风险，下钻：定义 → 攻击场景 → 我们的防线（挂 lesson/交付物链接）→ 残余。
> 姊妹图：[防线视角](安全知识体系.md) ｜ [消息旅程](安全知识体系-消息旅程.md) ｜ [攻击者视角](安全知识体系-攻击者视角.md) ｜ 速查：[ASI 对照表](ASI01-10对照表.md)
> 图例：✅ 实战覆盖 ｜ 🔶 部分 ｜ ⬜ 未覆盖

## ASI01 · 目标劫持 ✅

- **定义**：恶意内容篡改 agent 的目标与决策路径（LLM01 注入的 agent 化）
- **攻击场景**：直接下套 / 间接藏毒 / 计划注入
- **我们的防线**：
  - 三类注入全演练过，无防御全中招 —— [0009](../../issues/07-route1-execution/lessons/0009-直接注入.md) · [0010](../../issues/07-route1-execution/lessons/0010-间接注入.md)
  - L1 输入 / L2 工具返回分块 / L3 输出三层护栏 —— [0012](../../issues/07-route1-execution/lessons/0012-输入护栏.md) · [0013](../../issues/07-route1-execution/lessons/0013-工具返回护栏.md) · [0014](../../issues/07-route1-execution/lessons/0014-输出护栏.md)
  - 语义自检补分类器盲区 —— [0035](../../issues/11-route3-execution/lessons/0035-装载校验与语义自检.md)
- **残余**：🔶 叙事毒单点兜底；⬜ 拆行投毒、阈值标定（路线 4）
- 💬 注入不是骗模型，是污染 Agent 的三个输入通道——键盘、工具返回、持久记忆

## ASI02 · 工具滥用 ✅

- **定义**：合法工具被用在不安全用法——参数污染、工具链操纵
- **攻击场景**："帮我删 xxx"（语义正常、意图恶意）；参数侧夹带
- **我们的防线**：
  - 串联闸：D4 规则（目标须在本轮消息）+ LLM 法官（后果评估）—— [0034](../../issues/11-route3-execution/lessons/0034-串联闸-D4规则与LLM法官.md)
  - 💬 有权限 ≠ 该放行——身份闸与行为闸不竞争、该串联
- **残余**：⬜ D4 误拒→幻觉代偿（可用性代价已实证）

## ASI03 · 身份与权限滥用 ✅

- **定义**：agent 继承或提权高权限凭证
- **我们的防线**：
  - 凭证代理：真 key 撤出攻击面，Agent 只持占位符 —— [0022](../../issues/09-route2-execution/lessons/0022-凭证代理LLM路.md) · [0023](../../issues/09-route2-execution/lessons/0023-凭证代理fetch路.md)
  - OpenFGA ReBAC：默认拒绝、模型可钉版本 —— [0032](../../issues/11-route3-execution/lessons/0032-OpenFGA建模-四元组落成三元组.md) · [0033](../../issues/11-route3-execution/lessons/0033-FGA授权闸-插件与越权攻击.md)
  - 任务级短时令牌：时间+空间两轴砍爆炸半径 —— [0037](../../issues/11-route3-execution/lessons/0037-任务级短时令牌.md)
- 💬 "劫持了 Agent" ≠ "拿到了密钥"；认证身份 ≠ 授权身份

## ASI04 · 供应链 ✅

- **定义**：被投毒的工具/插件/外部组件
- **我们的防线**：
  - 接入前静态体检（毒样本 1000/1000）—— [0038](../../issues/11-route3-execution/lessons/0038-供应链体检.md)
  - 网关注册即盘点 + 默认拒 localhost —— [0030](../../issues/11-route3-execution/lessons/0030-三个server挂进网关-SSE传输与注册闭环.md)
- 💬 工具描述就是注入 LLM 的提示词

## ASI05 · 意外代码执行 ✅

- **定义**：agent 生成/运行不安全代码与命令
- **我们的防线**：
  - shell/fetch 执行面进一次性 microVM（独立内核+即焚）—— [0019](../../issues/09-route2-execution/lessons/0019-shell工具进microVM.md) · [边界对比](../route2/01-边界对比报告.md)
  - 出网动词网关层 deny_command（admin 同拦）—— [缺口核销](../route3/03-缺口核销记录.md)
  - 进程级白名单 vs microVM 的选型判据 —— [0027](../../issues/09-route2-execution/lessons/0027-进程级白名单对照microVM.md)
- 💬 攻击面 = 暴露给不可信代码的代码量

## ASI06 · 记忆与上下文投毒 ✅

- **定义**：污染持久记忆/RAG，跨会话操纵
- **攻击场景**：骗一次管永久；历史消息信任等级最高
- **我们的防线**：
  - 装载三闸（hash→分类器→语义自检）+ all-or-nothing —— [0035](../../issues/11-route3-execution/lessons/0035-装载校验与语义自检.md)
  - 落库前 Presidio 脱敏 —— [0024](../../issues/09-route2-execution/lessons/0024-Presidio记忆落库脱敏.md)
- **残余**：⬜ 全知攻击者重算 hash 只剩语义层（生产升级签名）
- 💬 "用户说过" ≠ "用户真说过"

## ASI07 · 多 agent 通信 ⬜

- **定义**：多 agent 间的身份伪造、消息篡改、假共识
- **我们的状态**：单 agent 项目，诚实缺口
- 💬 知道边界在哪和覆盖过一样重要——主动讲："TS client 是第二消费者不是对等 agent，这条在我的威胁模型外"

## ASI08 · 级联故障 🔶

- **定义**：小错误经规划/执行/记忆级联放大
- **我们的实证**：D4 误拒 → 模型绕行 → 写入幻觉日期——级联的真实案例 —— [route3 攻防复盘](../route3/02-网关收敛与攻击复盘.md)
- **状态**：有案例无专门防线；记忆落库校验与审计可部分缓解

## ASI09 · 人机信任滥用 🔶

- **定义**：利用人对 agent 的过度信任
- **我们的状态**：确认门（harness 复刻）暂停在 6/13；自动裁决 vs 确认门的分界（误判代价对称性）已成文 —— [route3 授权模型 §6](../route3/01-授权模型设计文档.md)
- 💬 知道为什么不建，和建过一样重要

## ASI10 · 流氓 agent ✅

- **定义**：被攻陷的 agent 表面正常实则作恶
- **我们的防线**：
  - 劫持无效化验收：假设完全沦陷，四次攻击实测收益为零 —— [0026](../../issues/09-route2-execution/lessons/0026-劫持无效化验收.md) · [验证记录](../route2/02-劫持无效化验证记录.md)
  - 哈希链不可抵赖 + 被拦也留痕 —— [0036](../../issues/11-route3-execution/lessons/0036-哈希链证据日志.md) · [0017](../../issues/07-route1-execution/lessons/0017-langfuse本地接入.md)
- 💬 验收标准 = 攻击值多少钱，不是防住没有

## 横切 · 十条之外的元认知

- **安全姿态 = 政策存在性 × 模型执行力 × 外部强制力** —— [0016](../../issues/07-route1-execution/lessons/0016-精读chapter2攻防矩阵.md)
- **单层皆有实证盲区，串联 + fail closed 是唯一成立方式** —— [0039](../../issues/11-route3-execution/lessons/0039-五条验收.md)
- ASI↔LLM Top 10 映射备料见 [对照表](ASI01-10对照表.md) 末节
