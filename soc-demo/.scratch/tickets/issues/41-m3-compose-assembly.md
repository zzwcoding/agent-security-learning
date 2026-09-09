# 41-m3-compose-assembly: compose 装配小票：agent 数据卷 + SOC_HMAC_KEY 口径（B5+G2-10）

**What to build:** ① agent 服务挂 ./data/agent:/data 卷（票 10 实现记录承诺的卷，m3 卡杀进程重启演示在 compose 下成立）；② SOC_HMAC_KEY 部署口径：.env.example + compose 注释 + README（教学假值可跑、真值注入位明确）。

**Blocked by:** 28

**Touches modules:** `m3`, `m9`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] compose up 后审批 interrupt 杀进程重启可恢复（源：遗留标记对账一-4·m3 卡测试计划）
- [ ] 铸票密钥装配口径成文（源：遗留标记 21-1）
