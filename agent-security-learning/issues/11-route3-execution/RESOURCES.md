# RESOURCES:路线 3 信源清单

> 讲解论断挂信源,不凭记忆。知识 = 官方文档/源码;智慧 = 社区/实践者。

## 知识(官方)

- 本地事实底座:`issues/10-route3-plan/research-contextforge-openfga.md`(部署命令/RBAC 上限/CPEX 插件模式/audit_trails 字段/OpenFGA 建模示例/mcp-scan 改名,全部带来源链接)
- ContextForge:[README](https://github.com/IBM/mcp-context-forge) · [docs/using/servers](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/using/servers/index.md) · [rbac](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/manage/rbac.md) · [plugins/README](https://github.com/IBM/mcp-context-forge/blob/main/plugins/README.md)(deny_filter/regex_filter 可抄)· [db.py(AuditTrail)](https://github.com/IBM/mcp-context-forge/blob/main/mcpgateway/db.py) · [PyPI](https://pypi.org/project/mcp-contextforge-gateway/)
- OpenFGA:[README](https://github.com/openfga/openfga) · [python-sdk](https://github.com/openfga/python-sdk) · [DSL/language](https://github.com/openfga/language) · [play.fga.dev](https://play.fga.dev) · Zanzibar 论文(只精读关系元组核心章节)
- MCP:官方 [typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)(TS client 用)/ [python-sdk](https://github.com/modelcontextprotocol/python-sdk) / spec security 章节与安全 SEP(图纸步骤 2 精读项)/ [inspector](https://github.com/modelcontextprotocol/inspector)
- 供应链体检:[snyk-agent-scan cli-reference](https://github.com/invariantlabs-ai/mcp-scan/blob/main/docs/cli-reference.md)(原 invariantlabs/mcp-scan,被 Snyk 收购改名)
- 项目内:图纸第六节(路线 3 原文)、《Agent开发分层与语言选型》(§4 检查清单:开工先重拉数据)、《沙箱机制与传统安全业务选型调研》

## 智慧(社区/实践)

- reachscan:MCP server 抽样 50 个,37.5% 可执行 shell、32.5% 读环境密钥(供应链体检的动机数据,图纸引用)
- 票 05 研究结论(ContextForge vs Lunar MCPX 对比,选型依据)
- 路线 1/2 沉淀:`对照分析.md`(执行工具复刻)、`lessons/0025-OTel审计字段.md`(审计五要素,TS 等价物清单在此)

## 本地运行资产(阶段推进中更新)

- 网关:ContextForge v1.0.8,`starter-agent/gateway/.venv`(uv 钉 Python 3.12),启动 `scripts/run-gateway.sh`,127.0.0.1:4444;`.env` 关键项:UI/Admin API 开、SECURE_COOKIES=false(本地 http)、SSRF_ALLOW_LOCALHOST=true(回环上游放行)
- MCP server SSE 形态:`scripts/run-mcp-servers.sh`,filesystem 8001 / shell 8002 / fetch 8003(路径 /sse);stdio 直连形态保留(阶段 36 拔)
- 程序化访问网关:Bearer JWT(`teams: null` + is_admin 才是管理员旁路),铸造方式见 lesson 0030/record 0033
- (后续阶段追加:OpenFGA 容器、TS client、FGA 插件、哈希链、令牌服务)
