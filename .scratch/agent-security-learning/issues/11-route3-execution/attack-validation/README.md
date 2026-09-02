# 路线 3 五条验收:证据索引(阶段 44)

> 2026-09-02 采集。判表对应票 10 Answer 验收五条;每条证据为真实运行的落盘输出。

| # | 验收 | 结果 | 证据 |
|---|---|---|---|
| ① | 网关收敛(三 server 全流量过网关,直连拔除) | ✅ | `01-gateway-convergence/agent-wiring.txt`(agent.py 唯一入口 4444/mcp,stdio 直连名单已拔除);`02-authz/*.txt` 三次调用全部经网关(工具名带前缀);网关侧流量账本见 `04-audit-token/gateway-tool-metrics.txt` |
| ② | 授权生效(OpenFGA check;越权 fail closed;运维位放行) | ✅ | `02-authz/bob-shell-denied.txt`(FGA_DENIED 带身份归属)/ `bob-read-allowed.txt`(放行)/ `admin-shell-allowed.txt`(放行执行返回 pwned) |
| ③ | 核销(缺口 2/3/7 + 缺口 4 接线 + shell 公网出口) | ✅ | 缺口 3:`03-gap-close/gate-lines.txt`(D4 拒 date 命令+法官放行合法写+任务票 scope);缺口 2/7+4:阶段 40 三攻击实录(见 record 0038,引用);shell 公网:`03-gap-close/admin-curl-egress-denied.txt`(deny_command 插件 EGRESS_DENIED——**admin 也拦,出口策略与身份无关**) |
| ④ | 审计三面 + 令牌 fail closed | ✅ | Langfuse:`04-audit-token/` 注明 v4.24.0 活性(五要素 trace 在 40/41 轮次);网关面:`gateway-tool-metrics.txt`(FGA 拒/curl 拒/放行全在案;**诚实记录**:ContextForge 的 `audit_trails` 表为 admin 操作审计,空表属实,工具调用审计走 metrics+结构化日志);证据链:`chain-verify.txt`(完整)+ `chain-tampered-verdict.txt`(篡改即断)+ 截断重造报警(验证器新语义);令牌:`token-four-gates.txt`(真票/超scope/伪造/过期四关) |
| ⑤ | 供应链体检 | ✅ | 阶段 43 `supply-chain/report.md`(毒样本 1000/1000 抓获+人工复核三红旗) |

## 网关侧双插件(本阶段新增)

- `deny_command.py`:shell 出网命令过滤(curl/wget/nc/ssh…命中即 EGRESS_DENIED)——**shell 公网出口残余的网关侧核销件**,出口策略与身份无关(admin 同拦)。
- 与 fga_check 的顺序:deny_command(priority 5)在 fga_check(priority 10)之前——出口闸最前。

## 诚实记录(不粉饰)

1. `audit_trails` 空表:ContextForge 的 audit_trails 面向 admin 操作(CRUD)审计;工具调用审计落在 `tool_metrics`(含 is_success/error)+ 控制台结构化日志。交付物文档将按实际行为写,不按宣传写。
2. 哈希链"前代延续"语义:验证器新增——首条 prev_hash 非空 = 文件是前代链的截断延续,本文件内不可锚定,按破坏处理(生产应外锚链头)。
3. D4 误拒的可用性代价(date 查日期被拒→模型幻觉日期)在 gate-lines.txt 场景中再次可见:闸门拦下合法意图,模型绕行但数据质量降级。
