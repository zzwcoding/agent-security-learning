# 16: m6 沙箱真跑 + 第四攻击面

**What to build:** microsandbox 接入：至少一个 analyzer 在一次性 microVM 里真跑；投毒 analyzer 攻击 fixture（外联 C2 / 读宿主 env）被拦 + DENIED 审计。路线 2 攻击验收迁移至此。

**Blocked by:** 15

**Touches modules:** `m6`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] 至少一个 analyzer 在一次性 microVM 真跑（源：m6 卡依赖·PRD v1.1 变更 3）
- [ ] attack/sandbox/01_poisoned_analyzer：外联 C2 被 egress 拦截（源：m6 卡测试计划）
- [ ] 读宿主 env：VM 内凭证不可见（源：m6 卡测试计划·路线 2 迁移）
- [ ] VM 一次性：跑完即毁无状态残留（源：modules.md §2 microsandbox 条目）
