# 20: m10 Web 上：骨架 + 登录 + 告警列表 + 流水线视图 + 审计流

**What to build:** Vite + React + Ant Design 5 脚手架（不引状态管理库）+ 4 身份登录 + 三个页面：告警列表（回放按钮）、流水线实时视图（SSE 节点图高亮）、审计流（实时滚动过滤）。SSE 断线重连。

**Blocked by:** 09, 10

**Touches modules:** `m2`, `m3`, `m10`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] Vite + React + antd 脚手架；不引状态管理库；4 预置身份登录（源：m10 卡技术选型·2026-09-08 拍板）
- [x] 告警列表页：dedup 标记/severity/状态 + 回放按钮（源：PRD FR-M10.1）
- [x] 流水线实时视图：SSE 推送 run 节点图高亮 + 每 worker 在干嘛一屏看全（源：PRD FR-M10.2）
- [x] 审计流页：实时滚动 + 按 requestId/case 过滤（源：PRD FR-M10.5）
- [x] SSE 断线自动重连 + Last-Event-ID 补发（源：决策记录 #9）
