# 12: gateway 三容器并排：contextforge + openfga

**What to build:** compose 接入 contextforge 与 openfga 官方镜像：setup-openfga.sh 按 A.2 幂等重建授权模型（4 角色 × 4 工具族），fga_check 插件挂载 contextforge。自写件不动镜像内部。

**Blocked by:** 08

**Touches modules:** `m8`, `m9`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] compose 三容器并排 up：contextforge + openfga + 自写件（源：modules.md §2·2026-09-04 拍板）
- [x] setup 脚本幂等重建授权模型（4 角色 × 4 工具族）（源：modules.md §2·ADR 0001）
- [x] fga_check 插件挂载，改 user_map 对位 A.2 角色矩阵（源：ADR 0001 直接搬件）
- [x] 升级官方镜像不碰自写代码（排障简单验证）（源：ADR 0001 决策）

## 实现记录（2026-09-08）

- compose 新增 `openfga`（openfga/openfga:v1.19.0，宿主映射 **18080**→8080）与 `contextforge`（:4444，PLUGINS_ENABLED=true，挂载 `services/gateway/plugins:/app/plugins`），与票 08 的 `gateway` 自写件并排；`gateway`/`guards` 未动。
- 授权模型数据化：`services/gateway/fga/openfga_model.json`（user/family/tool 三型，tool.can_execute 经 member_of 级联到 family.can_execute——「角色×工具族」就级联在这一跳）+ `services/gateway/fga/matrix.json`（4 族 × 4 角色，A.1 全部 23 个工具入族）。setup 引擎 `services/gateway/fga/setup_openfga.py`（`scripts/setup-openfga.sh` 薄壳）：store 按名复用 → 模型骨架比对复用 → 元组差量同步（先读后写、缺补多删）→ 13 条 A.2 裁决自检 → 刷 `plugins/fga_ids.json`。幂等两连跑：第二遍 store/model (reused)、`written=0 deleted=0`。
- fga_check 插件（搬自 starter-agent，ADR 0001「直接搬」）：HTTP 查询抽成 `query_openfga` seam 供单测；user_map 对位 A.2 四身份 `soc1/duty_lead/admin/redteam@soc.local`，`default_user: user:anonymous`（零权限匿名位，比参考工程的「最小可读位」更收窄，fail-closed，INV-1）。
- 测试：`test_compose_topology.py`（三容器并排/官方件不 build 不 COPY 自写码/挂载面）、`test_fga_matrix.py`（4 角色×4 工具族、A.1 全覆盖、**L2 两族任何角色无直接授权**、user_map 对位）、`test_fga_plugin.py`（allow/deny/不可达/ids 不可读/匿名回退）；真容器冒烟 `scripts/gateway-smoke-12.sh`（SMOKE PASS，四条验收证据齐）。gateway pytest 42 passed，guards 9 passed，ruff 全绿，check_specs PASS。

## 出入与拍板解读（不改 spec 本体，报总窗口对账）

1. **官方镜像拉取被网络拒**：`ghcr.io/ibm/mcp-contextforge-gateway`（含 1.0.0/0.7.0/latest）匿名 token 端点直接 `DENIED`，本机只能拉到旧仓 `ghcr.io/ibm/mcp-context-forge:0.5.0`（内无 cpex 插件框架，挂不上插件）。降级路径：`services/gateway/contextforge.Dockerfile` 用**官方 PyPI 包钉版自建**（`mcp-contextforge-gateway==1.0.8 cpex==0.1.3`，与参考工程 venv 同版本），镜像内零自写代码、插件全走挂载；ghcr 可达时 compose 把 build 换成 `image:` 一行即回官方镜像。ADR 0001 决策（自写件不动镜像内部）不受影响。
2. **A.2「需审批/审批回路」的 FGA 落法**：kb_write 与高危两族（L2）**不给任何角色直接授权**（含 duty_lead/admin）——三态裁决的 `require_approval` 走审批铸 ApprovalToken（INV-3），不经过这个布尔闸；A.2 的「✓」两族（L0/L1）照搬。13 条裁决自检里 duty_lead/admin 对 isolate_host/kb_write 的 deny 即此解读的机器化。
3. **端口**：宿主 8080 被本机无关进程占用（`python -m http.server 8080`），openfga 宿主侧映射改 18080，容器网络内恒为 8080（contextforge 走服务名，不受影响）。
4. **contextforge 启动密钥**：mcpgateway 1.0.x 启动即校验 `JWT_SECRET_KEY`/`AUTH_ENCRYPTION_SECRET`（占位符拒绝启动）；compose 注入教学假值（对位 SECRETS_* 金丝雀口径），真部署由环境注入。
