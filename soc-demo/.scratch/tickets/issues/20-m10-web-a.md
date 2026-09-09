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

## 实现记录（2026-09-09 L0 依窗口回报补记；体检发现本节缺失）

- 落点：services/web 补齐 Vite+React+antd5（钉 ^5.29.3+react19 补丁）；context 登录态（4 身份）+ 自写 hash 路由（不引状态管理库/路由库，m10 拍板）；sse.ts ReconnectingSse（终态收流/after 游标续传/零事件保险丝）；告警列表（occurrences 去重标记 + 回放走 webhook 正门）；流水线 SSE 节点高亮；审计流服务端参数过滤。
- commit `ac9b9fd`（web 38 测试；真栈冒烟：after=5 重放、dedup:true、六节点 SSE 全过）。验收 5/5 勾选；票 21 交叉修正 AlertsPage verdict_ai 形状渲染。
