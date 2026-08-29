# 总体排期与里程碑

Type: grilling
Status: resolved
Blocked by:

## Answer（2026-08-29，用户确认）

1. **总时长锚点**：无硬性时间节点，按理想教学内容排期，不卡死线。
2. **排期方式：滚动式（rolling wave）**——只详细排当前路线；每关收官时根据该关缺口清单详细安排下一关。主干顺序锁定：路线 2 → 路线 3 → 路线 4 红队部分 → "熟悉"档收尾（端云隐私 + 推理端，能讲即可）+ 面试材料整合 + 零信任架构蓝图。粗略量级参照（路线 1 实际 2 天）：路线 2 约 3–4 天，路线 3 约 4–5 天（最大工程关，含缺口 2/3/7 核销），路线 4 约 3–4 天，收尾 2–3 天——仅作参照，不作死线。
3. **路线 3 范围**：照单全收——缺口 2/3/7（记忆装载校验、执行串联闸、毒源合并处理）的核销归入路线 3 验收项；Presidio 脱敏管道压缩为 1 天 hands-on（无真实 PII 场景，但 JD 第 3 条要求保留实操）。
4. **实验落位**：角色从"精读"升级为**复刻 + 精读**，参照路线 1 已验证的做法（`攻防矩阵复刻/`、`执行工具复刻/`、`NeMo-Guardrails学习/` 平行窗口）。周级落位按本票输入素材草案随各路线执行周穿插，最终清单由各路线方案票背书。

## Question

6–10 周全职冲刺如何分配：路线 1 / 2 / 3 / 4 红队部分各占几周（图纸业余估算为 4-6 / 6-8 / 6-8 / 8-10 周，全职需重排压缩）、"熟悉"档（端云隐私 + 推理端项目）插在哪、每周里程碑与每关验收时间点、缓冲周安排。

练兵场实验的周级落位也在本票一并定（角色分配归各路线方案票，周级排期归本票）。

## 输入素材：练兵场实验 × 路线映射草案

（2026-08-27 由已删除的 09 票折叠进来；角色分配在各路线方案票中确认，本票只管周级落位）

- **路线 1**（02 已定）：chapter2/prompt-injection、chapter4/execution-tools 精读
- **路线 2** 候选精读：chapter9/self-modifying-agent（一次性容器隔离）、chapter3/log-sanitization（脱敏教学版）、chapter5/async-agent（shell 白名单参照）
- **路线 3** 候选精读：chapter5/permission-embedded-data-objects（数据层授权）、chapter5/small-model-codified-rules、chapter9/harness-safety-gate（审批门最完整实现）；证据链四件套作横切参照
- **路线 4**：反向案例挑 3 个当红队靶子（coding-agent / erp-agent / user-memory 攻击面最典型）；chapter7/user-memory-policy-eval 精读
- **了解即可**：chapter6 系列（computer-use/xlerobot/phone-agent）、chapter10/multi-role-transfer、autonomous-phone-registration、chapter9/trajectory-verifier
- **不排期**：chapter8 系列（训练侧已出范围；SandboxFusion/E2B 用法允许路线 2 顺手参考）
