# MCP 网关选型

Type: research
Status: resolved
Blocked by:

## Question

路线 3 的 MCP 网关选 IBM mcp-context-forge 还是 lunar-dev/mcp-x？对比维度：Mac 本地部署成本（docker compose 可起否）、功能覆盖（OAuth 认证 / per-agent RBAC / 不可变审计 / 插件链）、维护活跃度、源码精读价值（图纸要求读完能回答"设计一个 MCP 网关的关键组件是什么"）。给出明确推荐。

## Answer

**推荐：IBM mcp-context-forge（ContextForge）。**

先纠正一个事实：票里写的 `lunar-dev/mcp-x` 仓库不存在（404），Lunar 的开源实现实际是 [TheLunarCompany/lunar](https://github.com/TheLunarCompany/lunar) monorepo 下的 [`mcpx/` 子目录](https://github.com/TheLunarCompany/lunar/tree/main/mcpx)。以下按 ContextForge vs Lunar MCPX 对比。

### ① Mac 本地部署成本

- **ContextForge**：官方 `docker compose up -d` 一把起全栈（PostgreSQL + Redis + gateway + nginx），用 GHCR 预构建镜像避免本地构建；也支持单容器 `docker run`（SQLite）。**注意 arm64 警告**：官方明确说 Apple Silicon 上容器需走 Rosetta 模拟，或者改用 PyPI 原生安装（`pip install mcp-contextforge-gateway`）——Mac 上两条路都通，但 compose 不是原生 arm64。见 [README Quick Start - Containers](https://github.com/IBM/mcp-context-forge)。
- **MCPX**：也有官方 Docker 镜像和 15 分钟快速上手，体量更轻。两者部署都可行，ContextForge 重但一步到位带齐依赖。

### ② 功能覆盖

| 维度 | ContextForge | Lunar MCPX |
|---|---|---|
| OAuth/JWT 认证 | ✅ Basic/JWT/SSO（Keycloak compose profile、OIDC、RFC 8693 token exchange），内置 JWT 签发/吊销 | ⚠️ token 认证 + OAuth passthrough；IDP 集成属 enterprise 档 |
| per-agent RBAC / 工具白名单 | ✅ 团队制 RBAC + virtual server 捆绑工具子集 | ✅ tool-level ACL / Tool Groups（consumer tags） |
| 不可变审计 | ✅ 审计追踪（release notes 有专门 audit trail 修复线） | ⚠️ 宣传有 immutable audit logs，OSS 仓库中难以核实实现 |
| 插件链 | ✅ 40+ 插件框架（PII 过滤、deny/regex filter、rate limiter、Vault 等 CPEX 插件），pre/post invoke hook | ❌ 无插件链架构 |
| 限流 | ✅ 内置 rate-limiting + 独立 Redis 限流实例 | ⚠️ 依赖 Lunar Proxy 侧能力 |
| SSRF 防护 | ✅ 显式 SSRF 防护配置（`SSRF_ALLOW_PRIVATE_NETWORKS`、allowlist、DNS rebinding 防护，多个 CVE 修复记录） | ❌ 未见文档 |

关键差异：MCPX 把不少治理能力（private registry、per-identity 集群、usage dashboard、IDP 集成）放在 enterprise 档，见 [MCPX 官方文档](https://docs.lunar.dev/mcpx)；OSS 仓库里读不到这些核心代码。ContextForge 全功能 Apache-2.0 开源。

### ③ 维护活跃度

- **ContextForge**：高度活跃，[releases](https://github.com/IBM/mcp-context-forge/releases) 约每 1–2 周一个版本，最新 v1.0.8（2026-08-17，距调研日 10 天），IBM 背书、7000+ 测试、安全修复密集（CSRF、SSRF、JWT 加固）。
- **MCPX**：仓库本身也活跃（main 分支到 2026-08-26 仍有 commit），但社区规模小一个量级（组织页显示 ~44 stars），且 commit 摊在 proxy/mcpx 两个组件上。

### ④ 源码精读价值

这是决定性因素。ContextForge 是单一 Python/FastAPI 代码库，目录结构直接就是一张"网关组件图纸"：`transports/`（SSE/WebSocket/stdio/streamable HTTP 协议适配）、`routers/` + `services/`（注册表与业务逻辑）、`middleware/`（认证、CSRF 等横切关注点）、`plugins/`（策略执行点框架）、`db.py`（55+ 表的状态持久化）。读完可以直接回答"设计一个 MCP 网关的关键组件：协议适配层、上游注册表与发现、虚拟服务器/工具命名空间、认证与 RBAC、策略插件链、限流与 SSRF 出口防护、审计与可观测性"。MCPX 是 TypeScript monorepo，核心治理能力闭源在 enterprise 侧，精读只能学到聚合/分发这一层。

### 落地建议

- 主用 ContextForge：Mac 上优先 PyPI 原生安装绕开 Rosetta；要全栈体验再用 compose（接受 amd64 模拟）。
- MCPX 可作轻量对照阅读：看它的动态 dispatch 和 JSON 配置聚合即可，不必精读。

### 来源

- [IBM/mcp-context-forge 仓库（README、部署、功能）](https://github.com/IBM/mcp-context-forge)
- [mcp-context-forge releases（活跃度与安全修复）](https://github.com/IBM/mcp-context-forge/releases)
- [TheLunarCompany/lunar 仓库与 mcpx 子目录](https://github.com/TheLunarCompany/lunar/tree/main/mcpx)
- [TheLunarCompany 组织仓库列表（规模与更新时间）](https://github.com/orgs/TheLunarCompany/repositories)
- [Lunar MCPX 官方文档（OSS vs enterprise 功能分界）](https://docs.lunar.dev/mcpx)
- [Zuplo: MCP Gateway Comparison（第三方功能对照）](https://zuplo.com/blog/mcp-gateway-comparison)
