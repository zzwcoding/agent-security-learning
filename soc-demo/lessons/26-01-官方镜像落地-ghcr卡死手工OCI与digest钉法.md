# 26-01 · 票 26：ContextForge 官方镜像落地——ghcr 卡死的手工 OCI 落地与 digest 钉法

## 三问

**位置感**：阶段 5 回补票进行中（23 LangGraph → 24 llm-guard → 25 MCP SDK → **26 你在这里** → 27 真 LLM）。
票 12 当时 ghcr 匿名拒拉，ContextForge 降级成"官方 PyPI 包钉版自建"——官方件是自建的，
这就是 ADR 0002 点名的最后一处"降级未裁决"：

```
票12 降级自建 → ADR 0002 拍板回补 → 票26 重试获取 → 切官方镜像（digest 钉）✅你在这里
```

- **这一步是干嘛的？** 把 compose 里的 contextforge 从"自己拿官方 PyPI 包攒的镜像"换成
  IBM 官方发布的镜像，并按 **digest** 钉死。插件还是挂载进容器，一行自写代码都不进镜像。
- **什么需求逼我们这么设计？** 框架红线（ADR 0002 决策 4）：点名要用官方件，就真得用官方件，
  "功能等价的自建"不算数；但网络不给力时也不许硬刚——**用尽合法渠道、证据落档**，两条路
  （切官方 / ADR 记录维持自建）都算完成。
- **解决什么麻烦？** 三个麻烦：① 新仓 ghcr.io/ibm/mcp-contextforge-gateway 匿名渠道整个关闭
  （token 端点直接 DENIED）；② `docker pull` 对 ghcr 卡死——5 分钟拉不进一个字节，还把前任
  俩僵尸进程挂在那儿；③ 官方镜像起不来（1.0.10 启动强校验比 1.0.8 严）。答案分别是：
  换旧仓（同一 GitHub 源的旧包名）、绕开 pull 用 registry API 手工落地、把新校验项用教学假值
  补进 compose。

## 全链路一览

一条镜像从 registry 到 compose 服务，要过的每一跳（全是内容寻址，名字只是别名）：

```
ghcr.io（匿名）                                    本机
────────────────────────────────────────────────────────────
token 端点 ?scope=repository:ibm/mcp-context-forge:pull
   │ 匿名 token（新仓在这一跳直接 {"code":"DENIED"}）
   ▼
/manifests/latest ──► OCI index（多 arch 目录，5 个 arch 各一条）
   │                  index digest 31cf1d45…（registry 总账）
   │ 按 arch 挑一条：linux/arm64 子 manifest digest 98dfab27…
   ▼
/manifests/sha256:98df… ──► 层清单：4 个 blob（121.4MB 压缩）+ 1 个 config
   ▼
/blobs/sha256:… ──► 逐层下载，sha256 对账（内容地址：下载错一个字节就对不上）
   ▼
组装 OCI layout（oci-layout + index.json + blobs/）──► docker load
   │  坑：index.json 不带 platform → load 完镜像记录立刻消失
   ▼
本地镜像以 registry 原版 digest 98dfab27… 落地
   ▼
compose: image: ghcr.io/ibm/mcp-context-forge@sha256:98dfab27…
   ▼
容器起来 → /health 200 → cpex 框架加载挂载的 fga_check → 403 闸照常工作
```

## 跟着数据走：一次"卡死的 pull"是怎么被解剖的

1. **先探路再迈腿**（网络纪律：先看 manifest 大小再决定拉不拉）：`docker manifest inspect`
   / 或 curl registry API 拿 index——旧仓 latest 是 5 arch 的 OCI index，arm64 压缩层合计
   121.4MB。量小，值得拉。
2. **pull 卡死现场**：`docker pull ghcr.io/ibm/mcp-context-forge:latest` 后台跑 12 分钟，
   日志零字节、`docker images` 没新货；`ps aux` 里还躺着前任挂了 34 分钟的
   `docker pull …:v1.0.8` 俩僵尸。全部清掉。
3. **关键对照实验**：同样这台机器，`curl -m 15` 拿 token 秒回、下载 67MB 的 config blob
   秒下。**结论：网络是通的，卡的是 docker pull 自己**（daemon 在 VM 里的解析链路）。
   这一步把"网络问题"和"工具问题"分开了——不分开就会白等一小时然后骂网络。
4. **手工落地**：token → 按 manifest 里列的 digest 逐层 curl（每层独立超时 + 限速熔断：
   `--speed-limit 10240 --speed-time 30`，30 秒内速度低于 10KB/s 就掐）→ 每层
   `shasum -a 256` 对账 → 组装 OCI layout → `docker load`。
5. **load 进去的镜像叫什么 digest？** 实测三连：
   - OCI layout 不带 platform：`Loaded image: latest:latest` 打印成功，随即查无此镜像；
   - legacy docker 归档：能 load，但 digest 是 load 时重算的 `4ca6f55b…`（≠registry 真值，
     按 digest 引用会落空）；
   - **OCI layout + platform：digest = registry 原版 `98dfab27…`**，`image: …@sha256:` 直接可用。
6. **镜像里是什么**：site-packages 一眼定版本——`mcp_contextforge_gateway-1.0.10.dist-info`
   （比自建钉的 1.0.8 还新）、`cpex-0.1.3.dist-info`（跟自建钉版一字不差）。cpex 框架导入
   成功，挂载的 fga_check 插件在容器内直调：openfga 不在场时
   `continue_processing=False | FGA_UNREACHABLE | 403`——fail-closed 原样。
7. **起不来的三次碰壁**（1.0.10 启动强校验，fail-closed，一次比一次接近真相）：
   `platform_admin_password: too short (8 chars, minimum 12)` → 补 `PLATFORM_ADMIN_PASSWORD`；
   又 `default_user_password: too short` → 补 `DEFAULT_USER_PASSWORD`；
   起来了但宿主 14444 探不进去——容器内 `cat /proc/net/tcp` 显示绑的是 `0100007F:115C`
   （127.0.0.1:4444）→ 补 `HOST=0.0.0.0`。三个 env 都是教学假值进 compose，跟金丝雀口径一致。
8. **收口**：SMOKE PASS——compose 按 digest 起 official 镜像、13/13 矩阵裁决 ✓、
   容器内插件 ALLOW/DENY(403)×2 全对、按 digest 重建容器挂载件原样。

## 新技术点四要素：OCI 镜像模型与 digest 寻址

- **名字**：OCI Image Spec（Open Container Initiative）。四个角色：`index`（多 arch 目录）、
  `manifest`（某 arch 的层清单）、`config`（镜像元数据：env/Cmd/label/diff_ids）、`layer`
  （gzip tar 文件系统补丁）。全部用 sha256 内容寻址。
- **作用**：digest 是**内容的哈希**，不是名字。`latest` 会变，`sha256:98df…` 永远是那堆字节
  ——这就是"按 digest 钉"的不可变性保证；同时也是下载后的**对账凭据**（哈希对不上=传输坏）。
- **参数（四个核心对象怎么串）**：index.manifests[] 按平台挑一条 → manifest.layers[] 列出
  每层 digest+size → manifest.config.digest 指向 config → config.rootfs.diff_ids 是每层
  **解压后**的哈希（所以 legacy load 重算 digest 会跟 registry 的 manifest digest 对不上）。
  registry 三条 API 就够：`/token`、`/manifests/<ref>`、`/blobs/<digest>`。
- **用法（本项目）**：compose 用 `image: ghcr.io/ibm/mcp-context-forge@sha256:98dfab27…`
  钉 arm64 子 manifest digest（index digest 31cf1d45… 记在注释里备案）；升级跟踪口径写进票 26
  （阶段 7 定期比对新仓开闸与否 + 旧仓 index digest 是否前进）。

## 关键顿悟

- **"网络不通"和"工具不通"必须分开取证**。pull 卡死时先做对照实验：同一台机器 curl 能不能
  摸到同一个 registry？能——那卡的是 docker 的链路，绕过去（registry API 手工落地）比傻等
  有用。纪律不是"不许拉大镜像"，是"每一步都有界、可观测、可对账"。
- **digest 是指纹不是门牌**。legacy 归档 load 的镜像字节一样、digest 却不同——因为 digest
  锚在 manifest 清单上，装载方式换清单就换指纹。要让 `image: …@sha256:` 引用生效，本地
  镜像必须以 registry 同款 digest 登记（OCI layout + platform 的 load 才行）。
- **官方件的"开箱体验"也是它安全性的一部分**。1.0.10 把弱密码、占位符、默认绑定面全在启动时
  拒掉——和我们在 m9 写的 fail-closed 是同一哲学：宁可起不来，不可带病跑。教学环境用假值
  过闸，真部署由环境注入真值，闸门语义一点没让。
- **降级是可逆的，前提是当初留了回退缝**。票 12 降级时留了"ghcr 可达时把 build 换 image:
  一行即回官方"的缝，插件全走挂载所以镜像怎么换自写件零漂移——今天能 30 分钟切回去，
  靠的是当天的降级姿势标准。

## 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo

# 0) 单测基线（含 compose 拓扑断言 5 项：image: 钉法下照样全过）
(cd services/gateway && ../../.venv/bin/python -m pytest -q)   # 42 passed
python3 tools/check_specs.py                                   # spec gate: PASS

# 1) 真容器全链路冒烟：三容器并排 + 幂等两连跑 + 13 裁决 + 插件容器内真跑 + digest 重建
bash scripts/gateway-smoke-12.sh
# 应看到：contextforge 镜像列 = ghcr.io/ibm/mcp-context-forge@sha256:98dfab27…
#         ALLOW soc1→kb_lookup、DENY(403)×2、末尾 SMOKE PASS

# 2) 亲手摸一遍镜像身份（不出网，全部本地）
docker images --digests ghcr.io/ibm/mcp-context-forge   # latest 的 digest 应 = 98dfab27…
docker compose exec contextforge sh -c 'ls /app/.venv/lib/python3.12/site-packages | grep dist-info | grep -E "mcpgateway|contextforge|cpex"'
# 应看到 mcp_contextforge_gateway-1.0.10.dist-info 与 cpex-0.1.3.dist-info

# 3) 捣乱实验：把 compose 里 HOST=0.0.0.0 删掉再 up contextforge，宿主 curl 127.0.0.1:4444
#    会超时——容器内 cat /proc/net/tcp 看 0100007F:115C（127.0.0.1:4444），
#    体会"gunicorn 绑定面"这个 1.0.10 的坑；改回来再 up 恢复

# 4) 渠道体检（阶段 7 口径，票 26 实现记录里两条 -m 15 的命令）：
#    新仓 latest manifest 仍 403 = 匿名渠道没开；旧仓 index digest 仍 31cf1d45… = 没新版
```
玩完收摊：`docker compose stop contextforge openfga gateway`（openfga 内存存储，授权世界
随容器散，下次 setup-openfga.sh 30 秒重建）。
