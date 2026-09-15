# 0030 三 server 挂网关 —— 知识卡片

### FastMCP 传输参数（MCP transport）

是什么：transport 是 FastMCP（把普通 Python 函数直接变成 MCP server 的框架）上决定 server 用什么通道收发消息的参数，写成 `mcp.run(transport=...)`。MCP（Model Context Protocol，Agent 调用外部工具的开放协议）规范说：传输只是绑定，管消息怎么封装送达，不管消息什么含义——所以同一份代码换传输不改业务逻辑。三种通道：stdio 是 server 被客户端当子进程拉起、经标准输入输出通信，每个会话各拉一个进程。SSE（Server-Sent Events，HTTP 长驻事件流）是 2024 年版协议的 HTTP 传输，官方措辞已 deprecated（弃用，由 streamable-http 取代）。它握手（协议握手：双方先互发几条问候消息确认彼此听得懂，再谈正事）的第一步是任何人对 /sse 发 GET，立刻收到一条 `event: endpoint` 事件加带会话号的回传地址——先领"见面礼"再开口说话。streamable-http 是 2025 年版协议的单端点流式传输，消息走 HTTP POST，回复按需开请求级 SSE 流。注意参数值按包分家：官方 python-sdk 写 `transport="streamable-http"`，FastMCP v2 写 `transport="http"`——同一件事两套字面量，查文档先认包名。

解决什么问题：同一套工具既要被本机直连、又要以 HTTP 形态挂给网关（MCP 网关：代理并管理多个 MCP server 工具调用的中间层）时，不用写两份代码，换一个参数即可。它也把一个选型风险摆上台面：SSE 与 streamable-http 两套 HTTP 口味并不互通，两端吃的不一样就握手失败。FastMCP 官方建议新项目一律用 HTTP 传输，但这只是默认建议——MCP 规范自己的兼容思路是先试新传输、失败再回退旧传输，所以选型的现实依据是对接的另一端实测吃哪个。实测踩过一次真实的坑：用 streamable-http 向网关注册，网关握手第一步是对 /mcp 发 GET 开长驻事件流。而 server 处于 stateless 模式（不为连接保留会话状态），收到 GET 就把会话终结掉，日志里三连 `Terminating session: None`，网关傻等 30 秒超时；换 SSE 一次通过。教训：看 server 日志里的请求路径加会话终结记录，十分钟就能定位协议不合，比查文档快。

我们的办法：三个自写 server 在启动处用 `MCP_TRANSPORT` 环境变量切换传输，默认仍是 stdio，挂网关时切到 SSE。

### 登记即盘点（registration-time tool inventory）

是什么：「登记即盘点」[自造]指 MCP 网关登记上游时不只把名字记进表，而是亲自以 MCP 客户端身份对那个 URL 做一次完整握手（initialize 握手后 tools/list 抄工具清单）。这里的 MCP 网关即 ContextForge（IBM 的开源 AI 网关，把工具、Agent 和 API 汇成一条干净端点的注册与代理层）。这个动作在官方源码里就叫 gateway initialization：登记路径内跑一次远端握手，把抄回的工具列表直接入库。由此得到两个可用的性质：工具出现在网关工具列表里，就是那次真实握手成功的证明。上游 server 一挂，网关很快把它标成离线——感知机制不是事件推送，而是周期性健康检查（periodic health check / heartbeat，由主实例定时去探每个上游还活不活的心跳机制），最快也要等下一轮探测。配套机制是命名空间前缀：网关把工具改名为「server 名-工具名」，两个 server 即使有同名工具也不会撞车。

解决什么问题：网关要靠一张可信的工具总表来做可见性控制、团队范围限定和成员资格校验（ContextForge 官方原话是 visibility + team scoping + membership validation，即谁能看到哪些工具、令牌的团队归属是否匹配），并靠命名空间前缀避免撞车——例如 `read_file` 进了 filesystem 这个上游就变成 `filesystem-read-file`。若登记只存 URL 和名字，表里就会躺着一批实际调不通的死工具，授权决策建立在假清单上。上游死活的感知同样重要——网关要接管全部工具调用，前提是它知道每个上游此刻活不活着。

我们的办法：用 `POST /admin/gateways` 登记（body 只有 name、url、description 三件套），登记完立刻查网关工具列表就能看到全部带前缀的工具。实测杀掉一个上游 server 进程后，网关侧显示它离线而登记仍保留，重启进程即恢复。

### JWT teams claim 的权限边界（teams claim semantics）

是什么：teams claim 是 JWT（JSON Web Token，带签名的登录令牌）里名为 teams 的字段，在 ContextForge 网关（IBM 的开源 MCP 网关：把多个工具 server 代理成一条端点的中间层）里它决定令牌的权限边界，三种形态的语义完全不同。键缺席等于公开级（只能调用公开工具的最低权限档）——网关源码注释称之为 secure default（安全默认：宁可降权，也不默认放开）。空列表 `[]` 也等于公开级——它不是「什么都没有」，而是「明示只看公开内容」。只有 `teams: null` 且同时带 is_admin（令牌里的管理员标志字段）标志才是管理员旁路；反过来 `teams: null` 但 is_admin=false 仍被压回公开级，旁路不生效。按 RFC 7519（JWT 的标准文档）的命名分类，teams 属于 Private Claim（私有 claim：字段名不进标准注册表，语义完全由签发方和校验方自行约定，易撞名、易随版本漂移）。所以「给不给键、给空还是给 null」这三道门长什么样，全由实现方说了算，凭直觉猜必错。

解决什么问题：给网关签测试令牌时，若凭直觉以为「空列表等于无约束、等于最大权限」，实际拿到的只是公开级，基于它的权限测试会全盘得出错误结论。通用纪律：JWT 里任何用作权限边界的私有 claim，「缺席 / 空集合 / null」三种形态必须逐个核对语义；而且约定随时可能变——网关新版本起会话令牌（人登录会话用的令牌）已不再内嵌 teams claim（改为每个请求查数据库解析），只有 API 令牌（程序调接口用的令牌）仍内嵌，复习时记着这是特定版本的行为。

我们的办法：签发测试令牌用网关自带的 create_jwt_token 函数（60 分钟有效），要管理员旁路就显式传 `teams=None`，令牌里才会序列化出 `"teams": null`；实测这样的令牌能走通管理员接口，空列表令牌则被压到公开级。

### 毒注册打内网（SSRF via poisoned gateway registration）

是什么：SSRF（Server-Side Request Forgery，服务端请求伪造）按 OWASP（发布权威攻防指南的安全行业组织）的定义，是攻击者滥用服务器自身的功能去读取或改写内网资源的攻击——不只是探测，还包括改写。在 MCP 网关（代理并管理多个 MCP server 工具调用的中间层）场景下，「毒注册」[自造]指攻击者向上游（被网关代理、以 URL 挂进来的 MCP server）注册接口提交一个指向内网的 URL，诱骗网关替他去连。成因正是 OWASP 那句：服务端拉取远端资源，却不校验用户提供的 URL。毒从哪进：登记接口本身。网关收到注册请求后会亲自连到提交的 URL 去握手抄工具清单——这个「网关替你出手连网」的动作，正好被攻击者借作跳板（借别人机器的网络位置代发请求的中转点）。

怎么得手：拿到注册权限的攻击者提交形如 `http://10.0.0.5:6379/` 的内网地址，网关就会向它发握手请求；攻击者拿不到响应内容，只能从响应快慢和报错差异推断内网哪台机器活着、哪个端口开着——这有现成术语：blind SSRF（盲 SSRF：响应不回传给攻击者，只能靠这类侧信推断结果的探测形态）。

我们的对策：网关在注册入口默认拒收 localhost 和私网地址，报错明说被 SSRF protection 拦下，本地教学环境可用 `SSRF_ALLOW_LOCALHOST=true` 只放行回环地址（127.0.0.1，只有本机能连）。但要诚实标注成色：按地址黑名单拦截属 deny-list（deny-list：只拒已知坏地址的黑名单式防御），OWASP 明说 deny-list 天然可绕，DNS rebinding（DNS 重绑定：让同一域名先后解析到内外网不同 IP、绕过地址校验的攻击）、重定向、十进制 IP 等变体都能换着法绕开，更稳的是 allow-list（只放行显式许可地址的白名单）——所以它是必要但不充分的防线，和沙箱默认封私网出网同属「把内网不可达做成默认姿态」这一条设计思想。
