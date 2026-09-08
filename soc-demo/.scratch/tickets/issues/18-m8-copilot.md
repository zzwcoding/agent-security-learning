# 18: m8 对话 Copilot：POST /chat + 意图闸

**What to build:** 登录角色会话 → guards 输入预检 → 意图分类 → OpenFGA 三态裁决（allow 只读直查 / require_approval 转审批 / deny 拒绝并解释）→ SSE 流式回答。复用 m3 chat_flow。

**Blocked by:** 04, 10, 11, 12, 23, 27

**Touches modules:** `m3`, `m8`, `m9`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] POST /api/v1/chat SSE 流式；4 预置身份登录（铸门票①）（源：m8 卡公开接口）
- [ ] 意图闸三态 allow/deny/require_approval（OpenFGA 裁决）（源：PRD FR-M8.4）
- [ ] chat/01_ip_pivot 只读查询路由 worker 只读面（源：m8 卡测试计划）
- [ ] chat/02_injection_input 拒答 + 审计（源：m8 卡测试计划）
- [ ] soc1 发起 L2 意图 100% deny 且解释（源：m8 卡测试计划）
- [ ] 可见工具清单按角色快照 diff；伪造历史"已批准"无 token 无效（源：m8 卡测试计划·INV-9）
