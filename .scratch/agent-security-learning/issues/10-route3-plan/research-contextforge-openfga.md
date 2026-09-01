# 研究核查摘要:ContextForge × OpenFGA 落地细节(路线 3)

> 2026-09-01,研究子代理核查(票 10 方案的前期事实);执行票 11 开工前先读本文,部署命令/插件模式/建模示例都在里面。来源链接保留在各节。

## A. IBM/mcp-context-forge(ContextForge MCP 网关)

**A1. 上游 MCP server 传输方式**
- **结论:上游注册走 URL(SSE / streamable HTTP),stdio 上游不能由网关直接拉起进程,官方路径是用 `mcpgateway.translate` 把 stdio 桥接成 SSE 再注册。**
- 细节:上游经 `POST /gateways` 注册,body 形如 `{"name":"sample_server","url":"http://localhost:8080/sse"}`;桥接命令 `python3 -m mcpgateway.translate --stdio "uvx mcp-server-git" --expose-sse --port 9000`。代码层面:`mcpgateway/common/models.py` 的 `TransportType` 枚举含 SSE/HTTP/STDIO/STREAMABLEHTTP/GRPC,但 `gateway_service.py` 中 grep "stdio" 零命中,即网关不代管 stdio 进程。网关对客户端侧同时支持 SSE/streamable HTTP/stdio/WS。
- 对本项目的含义:三个自写 server 是 FastMCP 的,直接加 streamable HTTP transport 即可,不必走 translate 桥接。
- 来源:[README](https://github.com/IBM/mcp-context-forge)、[docs/docs/using/servers/index.md](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/using/servers/index.md)、[models.py](https://github.com/IBM/mcp-context-forge/blob/main/mcpgateway/common/models.py)

**A2. macOS Apple Silicon 安装**
- **结论:Mac 推荐 PyPI 原生安装(纯 Python wheel,Apple Silicon 无障碍);生产 Docker 镜像仅 amd64(Rosetta 或 pip 二选一)。**
- 细节:PyPI 包名 `mcp-contextforge-gateway`(1.0.8),`Requires-Python >=3.12,<3.14`;启动 `mcpgateway --host 0.0.0.0 --port 4444` 或 `uvx --from mcp-contextforge-gateway mcpgateway ...`;任何环境必须先设 `JWT_SECRET_KEY` 与 `AUTH_ENCRYPTION_SECRET`(`python3 -m mcpgateway.scripts.init_secrets`);SQLite 单容器 `docker run ghcr://ibm/mcp-context-forge:latest -e DATABASE_URL=sqlite:///./mcp.db -p 4444:4444 ...`;macOS 别把 mcp.db 放 iCloud 同步目录。
- 来源:[PyPI mcp-contextforge-gateway](https://pypi.org/project/mcp-contextforge-gateway/)、[README 安装节](https://github.com/IBM/mcp-context-forge#installation)

**A3. per-agent RBAC / virtual server / 工具白名单**
- **结论:RBAC 只有"全局或团队(team)"两种作用域,没有 per-agent 作用域;"工具子集"靠 virtual server(把若干 tools 捆成 `associated_tools`)加团队可见性间接实现;配置面 = Admin UI + REST API。**
- 细节:五个内置角色 `platform_admin / platform_viewer / team_admin / developer / viewer`(角色含 scope+scope_id);双层模型 = token 的 teams 声明管"能看什么"(public/team/private 可见性过滤),RBAC 管"能做什么"(类别级权限 `tools.read/create/update/delete/execute` 等);177 条 admin 路由用 `@require_permission` 强制;自定义角色经 `MCPGATEWAY_BOOTSTRAP_ROLES_IN_DB_FILE` 指向 JSON 数组。
- 来源:[rbac.md](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/manage/rbac.md)、[teams.md](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/manage/teams.md)

**A4. 插件链(CPEX)**
- **结论:自定义 pre-invoke 插件成本很低——单文件 Python 类(继承 `cpex.framework.Plugin`,实现一个 async hook)+ config.yaml 一段配置;官方有可直接照抄的 deny/regex 示例。**
- 细节:框架已外置为 cpex 包(contextforge-org/contextforge-plugins-framework);hook 三类:HTTP 认证钩子、MCP 协议钩子(`tool_pre_invoke/tool_post_invoke`、`prompt_pre_fetch`、`resource_*`、`agent_pre_invoke` 等);启用 `PLUGINS_ENABLED=true` + `PLUGINS_CONFIG_FILE=plugins/config.yaml`;可抄:`plugins/deny_filter/deny.py` 的 DenyListPlugin(递归扫词表,命中返回 `PluginViolation(code="deny")`、`continue_processing=False` 中止链;示例挂的是 `prompt_pre_fetch`,tool 场景同构换 `tool_pre_invoke` + `ToolPreInvokeResult`)、`plugins/regex_filter/`、`plugins/external/`(外置 HTTP 安全服务型,10–100ms 延迟档)。
- 来源:[plugins/README.md](https://github.com/IBM/mcp-context-forge/blob/main/plugins/README.md)、[deny_filter/deny.py](https://github.com/IBM/mcp-context-forge/blob/main/plugins/deny_filter/deny.py)

**A5. 审计追踪**
- **结论:正式审计功能,DB 表 `audit_trails` 字段相当全,有对外查询 REST API(`/api/logs/*`)和 SIEM 外发。**
- 字段:`timestamp、correlation_id、request_id、action(CREATE/READ/UPDATE/DELETE/EXECUTE/ACCESS/EXPORT/IMPORT)、resource_type/resource_id/resource_name、user_id/user_email/team_id、client_ip/user_agent/request_path/request_method、old_values/new_values/changes、data_classification(public/internal/confidential/restricted)、requires_review、success、error_message、context、auth_method、acting_as、delegation_chain`。另有 `permission_audit_log` 表和 SecurityEvent。查询:`POST /api/logs/search`、`GET /api/logs/audit-trails`、`GET /api/logs/trace/{correlation_id}` 等;SIEM 导出 `/admin/siem`;仪表盘 `/admin/observability`。
- 来源:[db.py](https://github.com/IBM/mcp-context-forge/blob/main/mcpgateway/db.py)、[audit_trail_service.py](https://github.com/IBM/mcp-context-forge/blob/main/mcpgateway/services/audit_trail_service.py)、[log_search.py](https://github.com/IBM/mcp-context-forge/blob/main/mcpgateway/routers/log_search.py)

**A6. 工具级 ACL**
- **结论:没有原生 per-tool ACL("There is no per-tool grant");可经 virtual server 只关联该工具 + 资源设团队可见来间接实现"单工具暴露"。**
- 来源:[rbac.md](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/manage/rbac.md)

## B. OpenFGA

**B1. Docker arm64 与最小部署**
- **结论:官方镜像原生多架构(amd64+arm64),Mac `docker run` 单容器 + 内存存储即可,不需要 Postgres(内存存储停容器即失,教学评估够用;tuples 重建脚本化即可)。**
- 细节:`docker run -p 8080:8080 -p 3000:3000 openfga/openfga run`(8080=HTTP API,3000=Playground);持久化后端 PostgreSQL 14+/MySQL 8/SQLite(beta)。
- 来源:[README](https://github.com/openfga/openfga)、[Docker Hub tags](https://hub.docker.com/r/openfga/openfga/tags)

**B2. Python SDK**
- **结论:PyPI 包 `openfga_sdk`,核心是 async 的 `OpenFgaClient`(同步版 `openfga_sdk.sync`)。**
```python
from openfga_sdk import ClientConfiguration, OpenFgaClient
from openfga_sdk.credentials import CredentialConfiguration, Credentials
# ClientConfiguration(api_url=..., store_id=..., authorization_model_id=..., credentials=...)
# 写元组 ClientWriteRequest(writes=[ClientTuple(user=..., relation=..., object=...)])
# 检查 await fga_client.check(ClientCheckRequest(user=..., relation=..., object=...)) → resp.allowed
```
- 来源:[openfga/python-sdk](https://github.com/openfga/python-sdk)

**B3. "人×Agent×工具×资源"建模**
- **结论:OpenFGA/Zanzibar 元组本质是三元组 (user, relation, object),无原生四元组;第四维靠"对象类型层级 + userset 展开"表达。下例为按 FGA DSL schema 1.1 自拟示例(研究子代理起草,非官方文档原文)。**
```
model
  schema 1.1

type user

type agent
  relations
    define admin: [user]        # 谁管理该 agent

type tool
  relations
    define deployed_on: [agent]
    define can_execute: [user] or admin from deployed_on

type resource                    # 资源维度继续级联
  relations
    define accessible_via: [tool]
    define can_access: can_execute from accessible_via
```
- 对应元组:`agent:X#admin@user:alice`、`tool:shell#deployed_on@agent:X`、`resource:db1#accessible_via@tool:shell`;check(alice, can_execute, tool:shell) → True。"alice 可在 agent X 上执行工具 shell" 用 2~3 个三元组表达。
- 来源:[OpenFGA README](https://github.com/openfga/openfga)、[FGA CLI](https://github.com/openfga/cli)

**B4. Playground / 建模工具**
- **结论:官方 Playground 两处——服务端内置 `http://localhost:3000/playground` 与在线 [play.fga.dev](https://play.fga.dev);DSL 官方名 OpenFGA DSL(fga 格式,扩展名 `.fga`);工具链 `openfga/language`(ANTLR)与 `openfga/cli` 的 `fga model transform`;VS Code 扩展 `openfga/vscode-ext`。**
- 来源:[openfga/language](https://github.com/openfga/language)、[openfga/vscode-ext](https://github.com/openfga/vscode-ext)

## C. 顺手核实

**C1. invariantlabs/mcp-scan**
- **结论:项目已被 Snyk 收购并改名 `snyk-agent-scan`;PyPI 上 `mcp-scan`(0.4.3)只是转发 stub——路线 3 体检必须用 `uvx snyk-agent-scan@latest`(需 `export SNYK_TOKEN=...`),旧教程的 `uvx mcp-scan@latest` 现在装到的是 stub。**
- 细节:默认用法自动发现 Claude Code/Desktop、Cursor、VS Code、Windsurf、Gemini CLI 等配置,也可指定文件 `uvx snyk-agent-scan@latest <path>`;可扫 SKILL.md/skills;检测 prompt injection / tool poisoning(E001)、tool shadowing(E002)、toxic flows;stdio server 默认不执行但"remote servers and skills are still inspected";未查到显式 streamable HTTP 远端扫描 flag(旧版曾支持直连远端拉工具描述)。
- 来源:[PyPI mcp-scan](https://pypi.org/project/mcp-scan/)、[invariantlabs-ai/mcp-scan](https://github.com/invariantlabs-ai/mcp-scan)、[cli-reference.md](https://github.com/invariantlabs-ai/mcp-scan/blob/main/docs/cli-reference.md)

**C2. ContextForge × microsandbox**
- **结论:无任何官方集成文档/示例;唯一可组合点是 microsandbox 自带 MCP server(SSE/streamable HTTP)可作普通上游注册进 `/gateways`——通用机制推断,非官方验证。对本项目无影响:VM 执行面在 fetch/shell server 内部,server 作上游挂网关,对网关透明。**
- 来源:[microsandbox docs](https://docs.microsandbox.dev/getting-started/agents)、[IBM/mcp-context-forge](https://github.com/IBM/mcp-context-forge)

## 关键落地方案提示(研究子代理结论,已被票 10 Answer 吸收)

路线 3 的"细粒度授权"若用 ContextForge 原生能力,粒度上限 = 团队可见性 + 类别级权限 + virtual server 工具子集;要真正做到"用户×Agent×工具×资源"四元组,需引入 OpenFGA 作为外部 PDP(用 `tool_pre_invoke` CPEX 插件调 `fga_client.check`,审计直接落 `audit_trails` 表 + `/api/logs/*` 查询)。
