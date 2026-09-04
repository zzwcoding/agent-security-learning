# AGENTS.md

本仓库按 **sdd-flow** 流程开发（指导手册：`~/.agents/skills/sdd-flow/`）。任何会话开工前先读 `CONTEXT.md` 与 `specs/`，按手册的入口协议定位阶段。

## 硬性约定

- 接口先行：模块边界与接口由人拍板，落在 `specs/modules.md`；实现只在模块内部活动，改接口必须先回设计阶段。
- 测试写在 seam 处，先于实现；CI（lint + typecheck + test）不绿不合并。
- 编码按 learn-by-rebuild 纪律：小步增量、每阶段可观察变化、讲解落盘 `lessons/`（编号从 0045 起）、用户说"下一步"才推进、说"提交"才 commit。
- 命名一律使用 `CONTEXT.md` 术语；新术语先入表再用。

## 仓库形态

pnpm monorepo（TS 服务：`services/ingest`、`services/case-backend`、`services/agent`、`services/web`）+ Python 服务（`services/guards`、`services/gateway`）。chroma 用官方镜像。每个服务本身是一个深模块：对外只暴露 `index` 入口与 HTTP 契约。
