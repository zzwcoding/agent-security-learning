# 26: gateway ContextForge 官方镜像对齐——重试获取并落档结论（回补票）

**What to build:** 票 12 因 ghcr.io 匿名拉取被 DENIED，降级为 contextforge.Dockerfile 用官方 PyPI 包钉版自建（mcp-contextforge-gateway==1.0.8）。本票重新走获取渠道：逐 tag 试拉官方镜像 `ghcr.io/ibm/mcp-contextforge-gateway` 并留存证据；**可达 → compose 切官方 image:（插件全走挂载不变）+ 三容器冒烟全过；不可达 → 用尽合法渠道（匿名/重试/镜像代理候选）后落 ADR 记录"维持自建 + 重试口径"**。两条路都算完成，但证据与结论必须落档。

**Blocked by:** （回补票）

**Touches modules:** `m8`, `m9`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] 官方镜像可达性证据落盘（试拉命令与完整错误输出，多 tag 至少 1.0.x/latest），结论二选一：切官方 / ADR 记录维持自建（源：票 12 出入记录·ADR 0002 决策 4·框架红线裁决）
- [ ] 若切官方：compose 三容器并排冒烟（scripts/gateway-smoke-12.sh）全过，fga_check 插件挂载与 A.2 矩阵裁决行为不变（源：票 12 回归）
- [ ] 若维持自建：ADR 记录自建版的升级跟踪口径（PyPI 版本对齐官方 release 的检查方法）（源：ADR 0002）
- [ ] docker-compose.yml 的 contextforge 服务定义与结论一致；CI compose job 仍绿（源：票 12 拓扑断言）
- [ ] 架构投影文档（architecture-gateway-internal.*）与最终形态一致（源：收尾第⑤样）
