# 08: m9 凭证代理 + gateway 自写件容器化

**What to build:** /proxy/llm/* 转发：验票通过后出站前在白名单字段替换凭证占位符为真值（SECRETS_* env）。与铸票件合成一个 compose 服务（gateway 自写件）。金丝雀断言测试。

**Blocked by:** 03, 06

**Touches modules:** `m9`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] 占位符 ${{ SECRETS.x.KEY }} 在出站白名单字段替换真值（源：PRD FR-S1.2·m9 卡公开接口）
- [ ] 金丝雀凭证全链路（prompt 装配/工具调用/审计/timeline）grep 不到真值（源：m9 卡测试计划·INV-4）
- [ ] 占位符无对应凭证 → 执行失败 fail-closed + 审计（源：PRD S1 异常与边界）
- [ ] 与铸币件合成 compose 服务 gateway（自写件不动镜像内部）（源：modules.md §2 三容器并排拍板）
