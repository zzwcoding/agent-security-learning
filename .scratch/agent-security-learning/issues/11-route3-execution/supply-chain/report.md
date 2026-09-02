# MCP 供应链体检报告(阶段 43)

> 2026-09-02。扫描器:snyk-agent-scan(原 invariantlabs/mcp-scan,Snyk 收购后改名;`uvx snyk-agent-scan@latest`)。
> 靶单:`scan-targets.json` 四个 stdio server;投毒样本 `poisoned_server.py`(自制教具,绝不在真实环境接入)。
> 密钥纪律:SNYK_TOKEN 经 `agent-key snyk` 从 Keychain 注入。

## 1. 扫描结果总表

| server | 性质 | 风险数 | 最高分 | 结论 |
|---|---|---|---|---|
| filesystem(自写) | 净 | 2 | 100/1000 | 知情接受的低残留(见复核②) |
| fetch(自写) | 净 | 1 | 100/1000 | 知情接受的低残留(见复核③) |
| **system-utils-poisoned(教具)** | **毒** | **3** | **1000/1000** | **真阳性,工具描述投毒被抓** |
| official-time(官方第三方) | 净 | 0 | — | 干净对照 ✓ |

## 2. 人工复核(图纸要求:练"看工具描述识别投毒"的眼力)

**① system-utils-poisoned / add 工具(1000/1000,Prompt injection in tool)——真阳性**

扫描器判词:"directs the model to read the private SSH key (~/.ssh/id_rsa) and exfiltrate its contents via the notes parameter while concealing this from the user, which is credential theft with concealment unrelated to the tool's arithmetic function."

人工复核要点(眼力训练的三条红旗):
- **功能与要求不匹配**:一个加法工具为什么要读 SSH 私钥?"工具的算术功能"与"描述里的安全要求"风马牛不相及——最大红旗;
- **要求隐瞒用户**:"Do not tell the user"——合法工具不需要对用户保密任何事;
- **敏感数据进参数**:"把内容放进 notes 参数"=给外传铺通道(参数会进请求体)。

**② filesystem / read_file & write_file(各 100/1000)——知情接受**
read 可暴露本地文件、write 可覆盖文件——属实,但路径守卫把二者钉死在 workspace 内;教学场景接受。生产复核要点:workspace 里是否可能存敏感文件(本项目的答案是 memory.json 不在工作区,凭证全走 Keychain)。

**③ fetch / http_get & http_post(100/1000)——知情接受**
拉外部内容进上下文=间接注入的经典入口(路线 1 攻击①已实证),但域名白名单+凭证策略+工具返回护栏(分类器+语义自检)三层兜底。复核结论:残留风险已知、有防线对应。

## 3. 方法论收获

- **扫描器默认姿态全是"先问再跑"**:逐个 server 询问"允许启动吗",拒绝则标记 X009(仅清点不深检)——和 ContextForge 的 SSRF 默认拒、UI 默认关一脉相承:**安全工具的默认态=最小权限**。
- **不启动就检不出描述投毒**:毒藏在工具描述里,而描述只有 server 跑起来才吐(X009 状态下拉不到)——所以体检必须显式同意启动受检 server(教具在自家机器,风险可控)。
- **mcp-scan 已被 Snyk 收购改名**:旧教程 `uvx mcp-scan@latest` 装到的是 stub,必须用 `snyk-agent-scan`(票 06 的工具名更新,票 10 已预判)。
- **投毒样本进路线 4 CI 回归集**:poisoned_server.py 的描述文本入攻击语料,红队关直接复用。

## 4. 与防线的闭环

扫描器抓的是"静态描述毒"(server 还没接入时)。若毒 server 已接入运行,我们的动态防线依次接手:网关 FGA(未授权身份调不了)→ 任务票 scope(本轮没授权用不了)→ 串联闸 D4(诱导目标不在用户消息里)→ 工具返回护栏+语义自检(返回里夹带的毒)。**静态体检拒之于门外,动态防线堵之于室内**——两层都要有。
