# 0029 - 网关上岗:ContextForge 安装与最小闭环

## 1. 三问(这一阶段是干嘛的)

**位置感**——路线 3 全景图,✅ 是已经走完的,你在这里:

```
✅ 路线 1 守门员:护栏穿衣服(拦在门口)
✅ 路线 2 堡垒:microVM+凭证代理(攻进来也拿不到)
▶️ 路线 3 城堡:网关+授权+审计(每个调用可认证/可授权/可追责)← 你在这里 · 阶段 34/46
⬜ 路线 4 攻防者:红队打自己
```

路线 3 又分 13 小步(阶段 34–46):

```
34 网关上岗 ✅ → 35 三server挂网关 → 36 Agent改走网关+TS第二身份 → 37 OpenFGA建模
→ 38 越权攻击 → 39 串联闸 → 40 记忆校验+语义自检 → 41 哈希链 → 42 短时令牌
→ 43 供应链体检 → 44 五条验收 → 45 复刻 → 46 收官
```

**这一阶段是干嘛的?** 把 MCP 网关(ContextForge)装起来、跑起来、能在浏览器里看到它。仅此而已——还一个工具都没接。

**什么需求逼我们这么设计?** 路线 2 结束时的世界是:Agent 直接连着三个自写 MCP server,谁连的、有没有权限、干了什么,server 自己根本不知道。就像一栋楼每个房间都直接开在街上,谁都能推门进。要盖"城堡",第一件事不是加锁,是**盖一个前台**——所有人从大门走,前台认得出你是谁、你能不能进这扇门、并且登记你来过。这个前台就是 MCP 网关。

**它解决了什么麻烦?** 目前什么都没解决——这个阶段解决的是"前台得先存在"。可观察的变化:浏览器打开 `http://127.0.0.1:4444` 能看到网关登录墙。

## 2. 全链路一览

本阶段结束后的全景(注意:目前只有"网关"这一节点亮):

```
                ┌────────────────────────────┐
                │  ContextForge 网关  ✅本阶段  │  127.0.0.1:4444
                │  (独立 venv + 独立 .env)     │  ← 前台已开门,还没接入住客
                └────────────────────────────┘
                       ▲              ▲
             阶段 36 接 │              │ 阶段 35 接
                       │              │
              ┌────────┴───┐   ┌──────┴───────────────┐
              │ 起步 Agent  │   │ 三个自写 MCP server    │
              │ (Python)   │   │ filesystem/shell/fetch │
              │ + TS client │   │ (shell/fetch 内部进 VM) │
              │ (阶段 36)   │   └────────────────────────┘
              └────────────┘
        阶段 37-38 挂授权(OpenFGA) · 阶段 41 挂哈希链 · 阶段 42 挂令牌
```

## 3. 跟着数据走:网关启动时发生了什么

以我们这次启动为例,一步步看数据(不是工具调用,是"启动本身"这条数据):

1. `scripts/run-gateway.sh` 被执行 → 脚本 `cd` 进 `starter-agent/gateway/` → 以该目录为工作目录启动 `.venv/bin/mcpgateway`。**关键:工作目录决定网关读哪个 `.env`、建哪个数据库文件**——我们有意让它住在自己的 `gateway/` 家里。
2. 网关启动第一件事:读工作目录的 `.env`,拿到三把密钥(`JWT_SECRET_KEY`=签发登录令牌的私章、`AUTH_ENCRYPTION_SECRET`=加密存储用的钥匙、`BASIC_AUTH_PASSWORD`=admin 登录密码)。这三样不是我们手写的,是 `init_secrets` 脚本生成的随机值。
3. 接着跑数据库迁移(SQLite,`gateway/` 下自动建库文件)——这就是我们第一次 curl 全是 000 的原因:**端口还没监听,服务还在搬桌椅**。以后写启动等待逻辑要记得这段窗口。
4. 然后逐个挂载路由。日志里两行 WARNING 值得读:`Admin API routes not mounted`、`Static files not mounted - UI disabled`——默认配置下,前台连"访客登记本"(Admin API)和"看板"(UI)都不开。这就是我们往 `.env` 追加两行 `MCPGATEWAY_UI_ENABLED=true`、`MCPGATEWAY_ADMIN_API_ENABLED=true` 再重启的原因。
5. 现在再 curl,数据流是:`GET /health` → 网关进程 → 直接回答 `{"status":"healthy",...}`(健康检查不碰数据库);`GET /` → 303 跳转到登录墙 → `GET /admin/login` → 200(看板在,等你登录);`GET /docs` → 401(API 文档也在,但要先登录)。

## 4. 新技术点四要素

### uv venv --python(钉 Python 版本)

- **名字**:`uv venv --python <版本>`,uv 的虚拟环境创建命令。
- **作用**:给网关一个**依赖隔离的家**。为什么必须钉 3.12?PyPI 上 `mcp-contextforge-gateway` 声明 `requires_python=<3.14,>=3.12`,而系统 python3 是 3.14.7——直接装会被 pip/uv 拒绝。uv 找到并复用了本机已有的 CPython 3.12.13(和起步 Agent 的 venv 同版本)。
- **参数**:`--python 3.12` 声明版本约束;不满足时 uv 会自己下载对应解释器(本机已缓存,秒过)。
- **用法**:`cd starter-agent/gateway && uv venv --python 3.12 .venv`,装包用 `uv pip install --python .venv/bin/python <包名>`。已写入 `scripts/run-gateway.sh` 的注释。

### mcpgateway CLI(网关本体入口)

- **名字**:`mcpgateway`,PyPI 包 `mcp-contextforge-gateway` 的命令行入口(FastAPI 应用 + uvicorn 打包)。
- **作用**:一条命令起整个网关(含 SQLite、限流器、路由挂载)。
- **参数**:`--host 127.0.0.1`(只听本机,教学场景别开 0.0.0.0)、`--port 4444`。默认读**工作目录**的 `.env`。
- **用法**:`.venv/bin/mcpgateway --host 127.0.0.1 --port 4444`,封装在 `scripts/run-gateway.sh`。

### init_secrets(密钥生成器)

- **名字**:`python -m mcpgateway.scripts.init_secrets`(模块方式运行)。
- **作用**:生成三把随机密钥,写进 `.env.secrets`;`--patch-env .env` 会把值补写进 `.env`。**网关没有这三样拒绝正常工作**(JWT 签发没有私章就发不出登录令牌)。
- **用法**:`.venv/bin/python -m mcpgateway.scripts.init_secrets --patch-env .env`。纪律:`.env` 已被仓库 .gitignore 覆盖,密码值永远不进文档/聊天记录。

## 5. 关键顿悟

- **网关是"部署对象",不是"你写的代码"**——这正是《分层与语言选型》说的:重资产只部署+精读。你亲手写的部分(锚点件)从阶段 38 的授权插件才开始。本阶段你写的只有 4 行启动脚本,这很正常。
- **默认配置是"最 Lockdown"的**:连 UI 和 Admin API 都默认关着。安全产品默认不开管理面是好习惯——记住这个感觉,阶段 35 我们打开 Admin API 注册上游时,它就是"带锁的登记本"。
- **网关有两套凭证面**:看板登录走邮箱账号体系(首次启动自动种下 `admin@example.com`/`changeme`,且强制首登改密——账号在 SQLite 的 `email_users` 表里可查);API 的 HTTP Basic 用的是 `.env` 里的 `BASIC_AUTH_PASSWORD`。两套互不通用,混用就会像我一样在登录页卡住。
- **Secure cookie 是"只在 HTTPS 里递的纸条"**:登录页会种一张 CSRF 通行 cookie(20 分钟有效),但 `secure_cookies` 默认 True 会给它加 `Secure` 标志——浏览器在 `http://` 上直接丢弃它(Chrome 对 localhost 放行,**Safari 不放行**),提交登录时就报 `CSRF token cookie missing`。本地教学在 `.env` 里 `SECURE_COOKIES=false`(生产保持默认并上 HTTPS)。CSRF 防护本身是网关"安全修复密集"的体现:登录这种改状态的动作,必须证明"请求是从网关自己发的登录页来的"——cookie 里一张票、表单里一张票,两张对上才放行。
- **工作目录是网关的"户口"**:同一个 mcpgateway 命令,在哪个目录跑,读哪个 `.env`、用哪个数据库。独立家目录(`gateway/`)= 独立户口,和起步 Agent 互不污染。

## 6. 亲手验证(建议你自己跑一遍)

```bash
# 1. 看看网关是不是活的(在任意终端)
curl -s http://127.0.0.1:4444/health | head -c 120
#    应看到 {"status":"healthy",...}

# 2. 打开看板:浏览器访问 http://127.0.0.1:4444
#    登录是邮箱制(平台账号体系):admin@example.com / changeme(出厂默认)
#    首次登录会强制改新密码——新密码自己记住,别写进任何文档
#    注意:BASIC_AUTH_PASSWORD 是 API 的 HTTP Basic 凭证(阶段 36 接 Agent/TS client 才用),
#    不是看板登录密码——网关有两套凭证面,别混

# 3. 你自己接管网关(教学纪律:服务优先你自己的终端托管)
lsof -ti:4444 | xargs kill        # 停掉 agent 代跑的这个
/Users/divh/Downloads/安全评估agent/.scratch/agent-security-learning/starter-agent/scripts/run-gateway.sh
#    终端会滚日志;看到 "Uvicorn running on http://127.0.0.1:4444" 即成功
```

**捣乱实验**:把 `gateway/.env` 里 `MCPGATEWAY_UI_ENABLED` 改回 false,重启,再访问 `/`——登录墙应该消失(303 没了)。改回来,重启。你就亲眼见过"配置开关 → 行为变化"这条最短的数据流了。
