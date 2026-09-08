# 26: gateway ContextForge 官方镜像对齐——重试获取并落档结论（回补票）

**What to build:** 票 12 因 ghcr.io 匿名拉取被 DENIED，降级为 contextforge.Dockerfile 用官方 PyPI 包钉版自建（mcp-contextforge-gateway==1.0.8）。本票重新走获取渠道：逐 tag 试拉官方镜像 `ghcr.io/ibm/mcp-contextforge-gateway` 并留存证据；**可达 → compose 切官方 image:（插件全走挂载不变）+ 三容器冒烟全过；不可达 → 用尽合法渠道（匿名/重试/镜像代理候选）后落 ADR 记录"维持自建 + 重试口径"**。两条路都算完成，但证据与结论必须落档。

**Blocked by:** （回补票）

**Touches modules:** `m8`, `m9`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] 官方镜像可达性证据落盘（试拉命令与完整错误输出，多 tag 至少 1.0.x/latest），结论二选一：切官方 / ADR 记录维持自建（源：票 12 出入记录·ADR 0002 决策 4·框架红线裁决）——证据见下方实现记录，结论=**切官方（旧仓 latest）**
- [x] 若切官方：compose 三容器并排冒烟（scripts/gateway-smoke-12.sh）全过，fga_check 插件挂载与 A.2 矩阵裁决行为不变（源：票 12 回归）——SMOKE PASS，13/13 裁决 ✓，ALLOW/DENY(403)×2 全对
- [x] ~~若维持自建：ADR 记录自建版的升级跟踪口径~~ → 不适用（走切官方分支，无需 ADR 0003）；官方镜像的升级跟踪口径（新仓开闸检查 + 旧仓 revision 前进检查）按同等工作量记入下方实现记录「升级跟踪口径」，责任人=阶段 7 体检
- [x] docker-compose.yml 的 contextforge 服务定义与结论一致；CI compose job 仍绿（源：票 12 拓扑断言）——`image: ghcr.io/ibm/mcp-context-forge@sha256:98dfab27…`，`docker compose config` OK，test_compose_topology 5 项全过
- [x] 架构投影文档（architecture-gateway-internal.*）与最终形态一致（源：收尾第⑤样）——投影图本就标注「ContextForge（官方镜像）」，本票使其成为事实，无需改图

## 实现记录（2026-09-09，分支 A：切官方镜像）

**渠道取证（L0 复核 + 本票补证）：**

1. **新仓 ghcr.io/ibm/mcp-contextforge-gateway：不可达（匿名渠道关闭）**。匿名 token 端点
   `curl -s -m 15 "https://ghcr.io/token?scope=repository:ibm/mcp-contextforge-gateway:pull"`
   返回体直接是 `{"code":"DENIED"}`（无 token 可发）；对 latest/1.0.8/0.5.0 的 manifest 请求一律
   HTTP 403。无 IBM 凭据，镜像代理候选无合法可用的（无凭据的第三方 mirror 不在允许渠道内）。
   结论维持票 12：此路在匿名条件下不可达。
2. **旧仓 ghcr.io/ibm/mcp-context-forge（同一 GitHub 源 IBM/mcp-context-forge 的旧包名）：匿名可达**。
   `latest` 为多 arch OCI index（amd64/arm64/s390x/ppc64le），index digest
   `sha256:31cf1d45ab56d83fc109ac0de1ada7b359df2497a52765af73421f013fa76b4d`，arm64 子 manifest
   digest `sha256:98dfab27a38b8aa1c1d3bc02c1e911d5a3dfc230559fea22ccdffad2cfd58b6a`（压缩层合计 121.4MB）；
   label：`org.opencontainers.image.revision=13d5493714861a2d0edb9c6a9702bce106f65711`、
   `source=github.com/IBM/mcp-context-forge`、Red Hat UBI10 底座（catalog 构建）。

**获取过程（网络操作全程有界，无一条无超时命令）：**

- `docker pull ghcr.io/ibm/mcp-context-forge:latest` 两次尝试（后台+轮询）各 5~12 分钟零字节进展，
  期间发现并清掉了前任卡死的两个 `docker pull …:v1.0.8` 僵尸进程（已挂 34 分钟）。**结论：本机
  docker daemon 对 ghcr 的 pull 链路卡死，但宿主 curl 到 ghcr token 端点与 blob CDN 全程通畅**——
  卡的是 pull 实现（如 VM 内解析/代理），不是网络。
- 改走 registry API 手工落地：匿名 token（`-m 15`）→ 逐 blob 下载（每层独立
  `-m 240/480 --speed-limit 10240 --speed-time 30` 限速熔断，一次一层）→ sha256 全部与 digest 对账
  通过 → 组装 OCI layout（index 带 platform）`docker load`。
- **关键坑（记档防复发）**：不带 platform 的 OCI index load 后镜像记录立即消失（containerd store 不认）；
  legacy docker 归档 load 成功但镜像 digest 是 load 时重算的（`sha256:4ca6f55b…` ≠ registry 真值）。
  只有「OCI layout + platform」load 出的镜像才以 registry 原版 arm64 manifest digest（98dfab27…）
  落地、可被 `image: …@sha256:` 引用；**index digest（31cf…）无本地记录，daemon 解析不了**——
  这是对「多 arch index 优先」偏好的唯一偏离，见「出入」第 1 条。

**镜像内容验证（分支 A 闸门全过）：**

- mcpgateway 版本：`mcp_contextforge_gateway-1.0.10.dist-info`（≥1.0.x ✓，比自建钉的 1.0.8 还新）。
- cpex 插件框架：`cpex-0.1.3.dist-info`（与自建钉版逐版本一致）+ 官方插件全家桶
  （pii_filter/secrets_detection/url_reputation/sql_sanitizer/rate_limiter/encoded_exfil_detection 等）；
  `from cpex.framework import PluginConfig, PluginContext, ToolPreInvokePayload` 导入成功。
- 真容器（挂载 plugins/、compose 同款 env）：`/health` 200 `{"status":"healthy",…}`；
  容器内直调 fga_check 插件，openfga 不在场时回 `continue_processing=False | FGA_UNREACHABLE | 403`
  （fail-closed 语义原样）。
- **1.0.10 启动强校验比 1.0.8 多出三件（实测撞出来的，全教学假值）**：
  `HOST=0.0.0.0`（gunicorn 默认绑容器内 127.0.0.1，不放开则宿主端口映射不通）、
  `PLATFORM_ADMIN_PASSWORD`、`DEFAULT_USER_PASSWORD`（email_auth_enabled 默认开，密码 ≥12 位）。

**落档改动：**

- `docker-compose.yml`：contextforge 从 `build:` 切
  `image: ghcr.io/ibm/mcp-context-forge@sha256:98dfab27…`，注释注明 revision/index digest/新仓 DENIED/
  1.0.10 新增 env；`HOST`/两个密码教学假值对位 SECRETS_* 金丝雀口径。插件挂载、PLUGINS_ENABLED、
  depends_on、healthcheck 原样未动（插件全走挂载不变）。
- `services/gateway/contextforge.Dockerfile`：保留为回退路径（compose 不再引用），头注写明身份
  （回退）、切换日期（2026-09-09）与回退方法（把 compose 的 image: 换回 build: 即用）。
- `scripts/gateway-smoke-12.sh` 第 5 步：compose 已无 build:，验收④「换镜像不碰自写件」改为
  官方镜像按 digest `--force-recreate` 容器 + 挂载件 grep 原样（语义不变：镜像升级零漂移）。

**冒烟证据（scripts/gateway-smoke-12.sh，SMOKE PASS）：**

- 三容器并排 up：contextforge 镜像列显示 `ghcr.io/ibm/mcp-context-forge@sha256:98dfab27…`；
  `[openfga] up (200)` `[contextforge] up (200)` `[gateway] up (200)`。
- setup-openfga.sh 幂等两连跑：两遍 `store/model (reused)`、`tuples written=0 deleted=0`；
  A.2 矩阵 13 条裁决全 ✓。
- fga_check 插件官方镜像容器内真跑：`ALLOW soc1@soc.local -> kb_lookup`、
  `DENY(403) soc1@soc.local -> isolate_host`、`DENY(403) stranger@evil.example -> kb_lookup`。
- 第 5 步重建容器后 `/app/plugins/config.yaml` 原样（挂载件不随镜像升级漂移）。

**测试：** services/gateway pytest 42 passed；票面点名三件
test_compose_topology.py + test_fga_matrix.py + test_fga_plugin.py = 18 passed；
`python3 tools/check_specs.py` = PASS（2 警告，均为规划中模块目录尚不存在的合法警告）。

**升级跟踪口径（责任人=阶段 7 体检；每阶段跑一次，两条都有界 `-m 15`）：**

```bash
# ① 新仓是否开闸：403/DENIED=仍关闭；200=新仓可达，评估切新仓 tag/digest
T=$(curl -s -m 15 "https://ghcr.io/token?scope=repository:ibm/mcp-contextforge-gateway:pull" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
curl -s -m 15 -H "Authorization: Bearer $T" -o /dev/null -w '%{http_code}\n' \
  "https://ghcr.io/v2/ibm/mcp-contextforge-gateway/manifests/latest"
# ② 旧仓 latest 是否前进：index digest 仍 31cf1d45…=没动；变了→取新 revision/版本，走本票同款
#    手工落地+验证流程后升 compose 钉版（arm64 manifest digest 以当次 Docker-Content-Digest 为准）
curl -s -m 15 -D - -o /dev/null "https://ghcr.io/v2/ibm/mcp-context-forge/manifests/latest" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  -H "Authorization: Bearer $(curl -s -m 15 "https://ghcr.io/token?scope=repository:ibm/mcp-context-forge:pull" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")" | grep -i docker-content-digest
```

## 出入记录（不改 spec 本体，报总窗口对账）

1. **digest 钉法偏离「多 arch index 优先」**：按的是 arm64 子 manifest digest（98dfab27…），
   不是 index digest（31cf1d45…）。原因：本机 containerd store 对手工 load 的镜像只登记子 manifest
   digest，index digest 引用会被 daemon 判缺失而触发 pull——而本机 docker pull 对 ghcr 卡死，
   index 钉法等于冒烟必挂。代价：跨平台机器（amd64）不能直接用这条 digest 引用（拉到的是 arm64
   manifest），升级跟踪口径②已把两个 digest 都列入核对。若后续 pull 链路恢复，可无成本换成 index 钉法。
2. **smoke 脚本第 5 步适配**：切 image: 后 compose 无 build:，原「docker compose build → 重建」
   步骤改为「按 digest --force-recreate → 挂载件原样 grep」。验收④语义（镜像升级不碰自写件）不变。
3. **1.0.10 新增三个必需 env**（教学假值入 compose）：HOST / PLATFORM_ADMIN_PASSWORD /
   DEFAULT_USER_PASSWORD。fail-closed 方向的收紧（密码强校验、绑定面显式声明），与 INV-1 同向，
   不构成行为偏移。
