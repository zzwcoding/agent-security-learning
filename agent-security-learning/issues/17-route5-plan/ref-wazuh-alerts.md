# Wazuh 告警格式研究（路线 5 票 17 参照）

> 研究目的：为「SOC 数字员工」demo 提供真实格式的告警数据源与接入层设计依据。
> 主要来源：Wazuh 官方文档（4.14 版）、wazuh/wazuh 仓库 ruleset（v4.14.0 tag）、wazuh-qa issue、TheHive 集成脚本。所有 JSON 样例均为官方文档或官方仓库中真实输出的原文。

## 1. 告警 JSON 结构

Wazuh manager 处理 agent/agentless 事件后产出告警，默认写入 `/var/ossec/logs/alerts/alerts.log`（文本）和 `/var/ossec/logs/alerts/alerts.json`（每行一个 JSON），再由 Filebeat 推给 Wazuh indexer。（[Alert management](https://documentation.wazuh.com/current/user-manual/manager/alert-management.html)）

顶层字段结构（以官方 logtest API 输出为准，见附录 A）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `timestamp` | string | ISO8601 带时区，如 `2023-04-25T13:50:43.764000Z` |
| `id` | string | 唯一 ID，格式 `<unix秒>.<计数>`，如 `1682430643.3725` |
| `rule` | object | 命中规则的完整信息（见下） |
| `agent` | object | `id`（`"000"`=manager 本机）、`name`、`ip` |
| `manager` | object | `name` |
| `full_log` | string | **原始日志行原文** |
| `predecoder` | object | 预解码：`program_name`、`timestamp`、`hostname` |
| `decoder` | object | `name`、（可选）`parent` |
| `data` | object | 解码器提取的动态字段，如 `srcip`/`srcport`/`srcuser`/`url`/`id`（HTTP 状态码）；integration 告警则是 `data.virustotal` 等嵌套对象 |
| `location` | string | 事件来源：`/var/log/syslog`、`syscheck`、`virustotal`、`rootcheck`、agent 名等 |
| `previous_output` | string | 仅频率类规则（`frequency`）出现，拼接前 N 条原始日志 |

`rule` 子结构：

- `id`（字符串形式的数字）、`level`(0-15)、`description`
- `firedtimes`、`mail`（布尔，是否触发邮件）、频率类规则还有 `frequency`
- `groups`：数组，语义分类（见 §2）
- `mitre`：`{id: [..], tactic: [..], technique: [..]}`，均为数组
- 合规映射：`pci_dss`、`gdpr`、`hipaa`、`nist_800_53`、`tsc`、`gpg13`（各为字符串数组）

特定模块的扩展顶层字段：

- FIM：`syscheck` 对象——`path`、`mode`、`event`(added/modified/deleted)、`size_after`、`md5_after`、`sha1_after`、`sha256_after`、`uid_after`、`uname_after`、`mtime_after`、`inode_after`、`win_perm_after`（Windows）等（附录 C）
- Rootcheck：`data.file`、`data.title`（附录 E）
- VirusTotal/Shuffle 等 integrator：`data.<integration>` 嵌套对象 + `data.integration`（附录 D）

## 2. 规则体系

### 2.1 level 分级语义（0–15，注意无 1 级惯例；官方最新表述上限写 16）

来自 [Rules classification](https://documentation.wazuh.com/current/user-manual/ruleset/rules/rules-classification.html)：

| Level | 标题 | 语义 |
|---|---|---|
| 0 | Ignored | 不动作，用于压误报，不上 dashboard |
| 2 | 系统低优先级通知 | 无安全意义 |
| 3 | 成功/授权事件 | 登录成功、防火墙放行等 |
| 4 | 系统低优先级错误 | 配置错误等，无安全意义 |
| 5 | 用户产生的错误 | 密码错误、被拒绝操作等 |
| 6 | 低相关度攻击 | 无效的蠕虫/病毒尝试等 |
| 7 | "坏词"匹配 | 未分类，可能有安全意义 |
| 8 | 首次出现 | 首次 IDS 事件/首次登录等 |
| 9 | 非法来源错误 | 未知用户登录尝试等 |
| 10 | 多次用户错误 | 多次密码错误/登录失败，可能是攻击 |
| 11 | 完整性检查告警 | 二进制被改、rootkit（rootcheck） |
| 12 | 高重要性事件 | 系统/内核错误，可能是针对性攻击 |
| 13 | 异常错误（高重要性） | 多数匹配已知攻击模式 |
| 14 | 高重要性安全事件 | 多为关联触发，表明攻击 |
| 15 | 严重攻击 | 无误报可能，需立即处理 |

### 2.2 groups 分类

`rule.groups` 是多层标签，典型组合：

- 来源层：`syslog`、`sshd`、`web`、`accesslog`、`ossec`、`syscheck`、`rootcheck`、`ids`、`suricata`、`windows`
- 语义层：`authentication_failed`、`authentication_failures`、`authentication_success`、`invalid_login`、`attack`、`sql_injection`、`exploit_attempt`、`recon`、`syscheck_entry_added`、`syscheck_file`
- 合规层会以 `pci_dss_10.2.4` 这类扁平 group 形式同时出现在 groups 和专名字段里

### 2.3 规则集规模（实测 v4.14.0）

`wazuh/wazuh` 仓库 `ruleset/` 目录（[GitHub API 实测](https://api.github.com/repos/wazuh/wazuh/contents/ruleset/rules?ref=v4.14.0)）：**168 个规则 XML 文件 + 120 个解码器 XML 文件**，单 SSH 一个服务（`0095-sshd_rules.xml`）就有 5700–5763 共 60+ 条规则。规则 id 区间按源分配，自定义规则从 100000 起。

### 2.4 MITRE ATT&CK 映射方式

规则 XML 内嵌 `<mitre><id>T1110</id></mitre>`；告警产出时 analysisd 查 MITRE 知识库把 id 展开成 `tactic`/`technique` 名称数组。例（`0095-sshd_rules.xml` v4.14.0 原文）：

```xml
<rule id="5710" level="5">
  <if_sid>5700</if_sid>
  <match>illegal user|invalid user</match>
  <description>sshd: Attempt to login using a non-existent user</description>
  <mitre>
    <id>T1110.001</id>
    <id>T1021.004</id>
  </mitre>
  <group>authentication_failed,gdpr_IV_35.7.d,...,pci_dss_10.2.4,...</group>
</rule>

<rule id="5712" level="10" frequency="8" timeframe="120" ignore="60">
  <if_matched_sid>5710</if_matched_sid>
  <same_source_ip />
  <description>sshd: brute force trying to get access to the system. Non existent user.</description>
  <mitre><id>T1110</id></mitre>
  ...
</rule>
```

频率关联范式：`frequency`（次数）+ `timeframe`（窗口秒）+ `if_matched_sid`（子规则）+ `same_source_ip`，触发后 `level` 从 5 升到 10，且告警带 `previous_output` 拼接历史日志——**这正是"告警聚合/升级"语义的真实样板**。

SQLi 规则（`0245-web_rules.xml`）：31103「SQL injection attempt」(level 7, T1190) 匹配 URL 中 `select+|union%20|xp_cmdshell` 等；31106（level 6, T1190）在 31103/31104/31105 之后且 HTTP 状态码 `^200` 时触发——"攻击成功"判定。

## 3. 可直接用的测试资产

1. **官方文档内的真实告警 JSON**（本报告附录全部来源）：
   - [Testing decoders and rules](https://documentation.wazuh.com/current/user-manual/ruleset/testing.html)：5710/5712 完整 JSON（附录 A/B）
   - [VirusTotal integration](https://documentation.wazuh.com/current/user-manual/capabilities/malware-detection/virus-total-integration.html)：FIM 554 + VT 87101/87102/87104/87105 五条完整 JSON（附录 C/D）
   - [wazuh-qa#2864](https://github.com/wazuh/wazuh-qa/issues/2864)：rootcheck 510 真实 alerts.json 行（附录 E）
   - [wazuh#15722](https://github.com/wazuh/wazuh/issues/15722)：active-response stdin 包装格式（`{"version":1,"origin":{...},"command":"add","parameters":{"alert":{...}}}`，附录 F）
2. **规则原文（可溯源）**：`github.com/wazuh/wazuh` tag `v4.14.0`，`ruleset/rules/0095-sshd_rules.xml`、`0245-web_rules.xml`、`0270-web_appsec_rules.xml`；旧仓库 `wazuh/wazuh-ruleset` 已归档（2026-06 只读）。
3. **最省事的"造数"路径（强烈推荐）**：Wazuh 自带 `wazuh-logtest`（CLI + Server API `PUT /logtest`），输入任意原始日志行即可得到与生产完全同构的告警 JSON（附录 A/B 就是这么生成的）。demo 只需一个 Wazuh manager 容器 + 一批真实日志样本，就能批量产出带 MITRE/合规映射的真实告警，且可用 token 会话复现频率升级（5710→5712）。这直接满足"真实数据"水位线，且可编程批量生成。
4. 其他社区资产（质量参差，作补充）：SOC homelab 类仓库（如 [alejandroZ345/wazuh-soc-homelab](https://github.com/alejandroZ345/wazuh-soc-homelab)）、[VTechWorks 论文附录的 web 告警样例](https://vtechworks.lib.vt.edu/bitstreams/06a9133e-71bb-4f19-89c1-3890a851b64f/download)（附录 G，真实 web-accesslog 告警节选）。

代表性样例清单（附录原文）：SSH 单次失败 5710（L5, T1110.001/T1021.004/T1078）、SSH 暴力破解 5712（L10, T1110, 含 previous_output）、FIM 新增文件 554（L5）、VT 恶意文件命中 87105（L12, T1203）、VT 限流/无记录 87101/87104、rootcheck 木马文件 510（L7）、web 扫描/SQLi（31101/31103 规则 + 附录 G 样例）、agent 接入 501。

## 4. 告警里的注入面（攻击者可控字段）

| 字段 | 可控方式 | 注入演示价值 |
|---|---|---|
| `full_log` | **完全可控**：SSH 登录用户名、HTTP 请求行/UA、SQL 参数都原样进 full_log | 最高。LLM 分诊必读字段 |
| `data.srcuser` | SSH 暴力破解的用户名任意填，如 `"admin'; DROP TABLE--"` 或 "Ignore previous instructions…" | 高。已进结构化字段 |
| `data.url` | HTTP 请求路径任意构造 | 高 |
| `previous_output` | 频率告警拼接 N 条原始日志，攻击者可写多行多轮"对话式"载荷 | 高（多行注入/伪造日志分隔） |
| `data.srcip` / `srcport` | 来源 IP 本身可控（非文本注入，但可用于白名单绕过话术） | 中 |
| web `full_log` 中的 User-Agent | 完全可控（附录 G 样例里就是 `WPScan v3.8.20`） | 高 |
| `syscheck.path` | 攻击者在被控主机上创建任意文件名 | 中。文件名可带指令文本 |
| Windows `data.win.eventdata.commandLine` / `image`（Sysmon） | 被控主机执行任意命令行 | 高（真实告警里命令行原文进 data） |
| `data.audit.command`（auditd） | 同上 | 中 |

要点：**凡是"从原始日志提取"的字段（full_log、data.*）都不可信**；可信的只有 rule/agent/manager/decoder 等 Wazuh 自身生成的元数据。demo 的注入演示应让载荷经 `data.srcuser`/`full_log` 进入分诊 prompt。

## 5. Wazuh → 下游平台（TheHive）对接

Wazuh 侧统一走 **integratord 模块**（[External API integration](https://documentation.wazuh.com/current/user-manual/manager/integration-with-external-apis.html)）：

- 内置集成：`slack`、`pagerduty`、`virustotal`、`shuffle`、`maltiverse`；TheHive **没有内置**，走自定义集成（name 以 `custom-` 开头）。
- 机制：integratord 按过滤条件（`rule_id`/`level`/`group`/`event_location`）把 alerts.json 中的告警写成临时 JSON 文件，调用 `/var/ossec/integrations/<name>` 脚本，参数为 `argv[1]=告警文件路径, argv[2]=api_key, argv[3]=hook_url`。必须配 `<alert_format>json</alert_format>`。
- **Shuffle 路径**：ossec.conf 里配 `<name>shuffle</name>` + Shuffle webhook URL，告警 JSON 整包 POST 给 Shuffle 工作流，再由 Shuffle 建 TheHive case（[malwarekid/SOAR-Flow](https://github.com/malwarekid/SOAR-Flow) 即此架构）。
- **直连脚本路径**（社区事实标准 [custom-w2thive.py](https://github.com/ls111-cybersec/wazuh-thehive-integration-ep13/blob/main/custom-w2thive.py)，多个教程同源）的字段映射：
  - `title` ← `rule.description`
  - `tags` ← `['wazuh', 'rule='+rule.id, 'agent_name=..', 'agent_id=..', 'agent_ip=..']`
  - `description` ← 整条告警 JSON 递归拍平成 `key|||value` 再渲染成 Markdown 表格
  - `artifacts` ← 对拍平文本做正则提取 `ip`/`url`/`domain`（注意：**不做 severity 映射**，tlp 固定 2，sourceRef 随机 uuid）
  - `type='wazuh_alert'`、`source='wazuh'`
  - 阈值过滤：非 suricata 按 `rule.level >= lvl_threshold`，suricata 按 `data.alert.severity`

其他转发通道：syslog_output（可多级、按 level 过滤）、邮件（email_alert_level 默认 12）、database_output（MySQL/PG，需源码编译）、Filebeat→indexer。

## 6. 我们可借什么（接入层设计建议）

**告警格式子集（demo ingestion schema）**——每条告警至少保留：

```
timestamp, id,
rule: {id, level, description, groups[], firedtimes, frequency?, mitre{id[],tactic[],technique[]}},
agent: {id, name, ip}, manager.name,
decoder.name, location, full_log, previous_output?,
data: {...动态字段原样保留}, syscheck? / data.virustotal?
```

**Wazuh → TheHive 风格 alert schema 映射对照表**：

| Wazuh | TheHive alert | 备注 |
|---|---|---|
| `rule.description` | `title` | |
| `id` | `sourceRef`（建议，优于社区脚本的随机 uuid，天然去重） | |
| `'wazuh'` + manager.name | `source` | |
| `'wazuh_alert'` 或 `location` | `type` | |
| `rule.level` | `severity`（建议补上映射，社区脚本没做）：0–4→1 Low，5–9→2 Medium，10–14→3 High，15→4 Critical | |
| `data.srcip`/`srcuser`/`url`、syscheck.path、hash | `observables`（dataType: ip/other/url/filename/hash） | 比社区脚本的全文正则精确——直接用结构化字段 |
| `rule.groups` + `rule.mitre.id` | `tags`（如 `mitre:T1110`、`group:authentication_failed`） | |
| `full_log` + `previous_output` | `description` 附录段落（**注入面所在，原样保留但标记为不可信内容**） | |
| `timestamp` | `date` | |

**数据源落地建议**：跑一个 Wazuh manager 容器，用 `PUT /logtest` API 喂真实日志样本（SSH auth.log 行、apache access.log 行、syscheck 事件）批量产出告警 JSON 落盘为数据集；注入变体只需把载荷写进日志行的用户名/URL/UA 位置再喂一遍。这样数据集同时满足"真实格式"与"注入载荷可控植入"两个水位线。

## 附录：真实告警 JSON 原文

### A. SSH 单次失败 rule 5710（官方 logtest API 输出原文，[来源](https://documentation.wazuh.com/current/user-manual/ruleset/testing.html)）

```json
{
   "timestamp": "2023-04-25T13:50:43.764000Z",
   "rule": {
      "level": 5,
      "description": "sshd: Attempt to login using a non-existent user",
      "id": "5710",
      "mitre": {
         "id": ["T1110.001", "T1021.004", "T1078"],
         "tactic": ["Credential Access", "Lateral Movement", "Defense Evasion", "Persistence", "Privilege Escalation", "Initial Access"],
         "technique": ["Password Guessing", "SSH", "Valid Accounts"]
      },
      "firedtimes": 1,
      "mail": false,
      "groups": ["syslog", "sshd", "authentication_failed", "invalid_login"],
      "gdpr": ["IV_35.7.d", "IV_32.2"],
      "gpg13": ["7.1"],
      "hipaa": ["164.312.b"],
      "nist_800_53": ["AU.14", "AC.7", "AU.6"],
      "pci_dss": ["10.2.4", "10.2.5", "10.6.1"],
      "tsc": ["CC6.1", "CC6.8", "CC7.2", "CC7.3"]
   },
   "agent": {"id": "000", "name": "centos7"},
   "manager": {"name": "centos7"},
   "id": "1682430643.3725",
   "full_log": "Oct 15 21:07:00 linux-agent sshd[29205]: Invalid user blimey from 18.18.18.18 port 48928",
   "predecoder": {"program_name": "sshd", "timestamp": "Oct 15 21:07:00", "hostname": "linux-agent"},
   "decoder": {"parent": "sshd", "name": "sshd"},
   "data": {"srcip": "18.18.18.18", "srcport": "48928", "srcuser": "blimey"},
   "location": "master->/var/log/syslog"
}
```

### B. SSH 暴力破解升级 rule 5712（同源，注意 `previous_output` 与 `frequency`）

```json
{
   "timestamp": "2023-04-25T13:51:36.409000Z",
   "rule": {
      "level": 10,
      "description": "sshd: brute force trying to get access to the system. Non existent user.",
      "id": "5712",
      "mitre": {"id": ["T1110"], "tactic": ["Credential Access"], "technique": ["Brute Force"]},
      "frequency": 8,
      "firedtimes": 1,
      "mail": false,
      "groups": ["syslog", "sshd", "authentication_failures"],
      "gdpr": ["IV_35.7.d", "IV_32.2"],
      "hipaa": ["164.312.b"],
      "nist_800_53": ["SI.4", "AU.14", "AC.7"],
      "pci_dss": ["11.4", "10.2.4", "10.2.5"],
      "tsc": ["CC6.1", "CC6.8", "CC7.2", "CC7.3"]
   },
   "agent": {"id": "000", "name": "centos7"},
   "manager": {"name": "centos7"},
   "id": "1682430696.3725",
   "previous_output": "Oct 15 21:07:00 linux-agent sshd[29205]: Invalid user blimey from 18.18.18.18 port 48928\nOct 15 21:07:00 linux-agent sshd[29205]: Invalid user blimey from 18.18.18.18 port 48928\nOct 15 21:07:00 linux-agent sshd[29205]: Invalid user blimey from 18.18.18.18 port 48928\nOct 15 21:07:00 linux-agent sshd[29205]: Invalid user blimey from 18.18.18.18 port 48928\nOct 15 21:07:00 linux-agent sshd[29205]: Invalid user blimey from 18.18.18.18 port 48928\nOct 15 21:07:00 linux-agent sshd[29205]: Invalid user blimey from 18.18.18.18 port 48928\nOct 15 21:07:00 linux-agent sshd[29205]: Invalid user blimey from 18.18.18.18 port 48928",
   "full_log": "Oct 15 21:07:00 linux-agent sshd[29205]: Invalid user blimey from 18.18.18.18 port 48928",
   "predecoder": {"program_name": "sshd", "timestamp": "Oct 15 21:07:00", "hostname": "linux-agent"},
   "decoder": {"parent": "sshd", "name": "sshd"},
   "data": {"srcip": "18.18.18.18", "srcport": "48928", "srcuser": "blimey"},
   "location": "master->/var/log/syslog"
}
```

### C. FIM 文件新增 rule 554（[VirusTotal integration 文档](https://documentation.wazuh.com/current/user-manual/capabilities/malware-detection/virus-total-integration.html)原文）

```json
{
   "timestamp":"2022-11-17T19:17:42.694+0200",
   "rule":{
      "level":5,
      "description":"File added to the system.",
      "id":"554",
      "firedtimes":2,
      "mail":false,
      "groups":["ossec","syscheck","syscheck_entry_added","syscheck_file"],
      "pci_dss":["11.5"],
      "gpg13":["4.11"],
      "gdpr":["II_5.1.f"],
      "hipaa":["164.312.c.1","164.312.c.2"],
      "nist_800_53":["SI.7"],
      "tsc":["PI1.4","PI1.5","CC6.1","CC6.8","CC7.2","CC7.3"]
   },
   "agent":{"id":"010","name":"Ubuntu","ip":"10.0.2.15"},
   "manager":{"name":"localhost.localdomain"},
   "id":"1668705462.50453",
   "full_log":"File '/media/user/software/suspicious-file.exe' added\nMode: realtime\n",
   "syscheck":{
      "path":"/media/user/software/suspicious-file.exe",
      "mode":"realtime",
      "size_after":"0",
      "perm_after":"rw-r--r--",
      "uid_after":"0",
      "gid_after":"0",
      "md5_after":"d41d8cd98f00b204e9800998ecf8427e",
      "sha1_after":"da39a3ee5e6b4b0d3255bfef95601890afd80709",
      "sha256_after":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "uname_after":"root",
      "gname_after":"root",
      "mtime_after":"2022-11-17T19:17:42",
      "inode_after":1704505,
      "event":"added"
   },
   "decoder":{"name":"syscheck_new_entry"},
   "location":"syscheck"
}
```

### D. VirusTotal 恶意文件命中 rule 87105（同源；level 12 + MITRE）

```json
{
   "timestamp":"2022-11-17T19:30:25.085+0200",
   "rule":{
      "level":12,
      "description":"VirusTotal: Alert - /media/user/software/eicar.com - 66 engines detected this file",
      "id":"87105",
      "mitre":{"id":["T1203"],"tactic":["Execution"],"technique":["Exploitation for Client Execution"]},
      "firedtimes":1,
      "mail":true,
      "groups":["virustotal"],
      "pci_dss":["10.6.1","11.4"],
      "gdpr":["IV_35.7.d"]
   },
   "agent":{"id":"010","name":"Ubuntu","ip":"10.0.2.15"},
   "manager":{"name":"localhost.localdomain"},
   "id":"1668706225.104492",
   "decoder":{"name":"json"},
   "data":{
      "virustotal":{
         "found":"1",
         "malicious":"1",
         "source":{
            "alert_id":"1668706222.103798",
            "file":"/media/user/software/eicar.com",
            "md5":"44d88612fea8a8f36de82e1278abb02f",
            "sha1":"3395856ce81f2b7382dee72602f798b642f14140"
         },
         "sha1":"3395856ce81f2b7382dee72602f798b642f14140",
         "scan_date":"2022-11-17 17:15:04",
         "positives":"66",
         "total":"68",
         "permalink":"https://www.virustotal.com/gui/file/275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f/detection/f-275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f-1668705304"
      },
      "integration":"virustotal"
   },
   "location":"virustotal"
}
```

（同页另有 87101 限流、87102 凭证错误、87104 无记录三条完整 JSON，结构同上、`data.virustotal.error/found/malicious` 不同。）

### E. Rootcheck 木马文件 rule 510（[wazuh-qa#2864](https://github.com/wazuh/wazuh-qa/issues/2864) 真实 alerts.json 行，单行原文）

```json
{"timestamp":"2022-05-09T18:32:50.251+0000","rule":{"level":7,"description":"Host-based anomaly detection event (rootcheck).","id":"510","firedtimes":1,"mail":false,"groups":["ossec","rootcheck"],"pci_dss":["10.6.1"],"gdpr":["IV_35.7.d"]},"agent":{"id":"000","name":"manager-2864"},"manager":{"name":"manager-2864"},"id":"1652121170.506138","full_log":"Trojaned version of file '/bin/grep' detected. Signature used: 'bash|givemer|/dev/' (Generic).","decoder":{"name":"rootcheck"},"data":{"title":"Trojaned version of file detected.","file":"/bin/grep"},"location":"rootcheck"}
```

### F. Active Response stdin 包装（[wazuh#15722](https://github.com/wazuh/wazuh/issues/15722)）——demo 若接响应动作需要这层信封

```json
{"version":1,"origin":{"name":"node01","module":"wazuh-execd"},"command":"add","parameters":{"extra_args":[],"alert":{"timestamp":"2022-12-20T09:30:18.052+0000","rule":{"level":5,"description":"File added to the system.","id":"554","firedtimes":1,"mail":false,"groups":["ossec","syscheck","syscheck_entry_added","syscheck_file"],"pci_dss":["11.5"],"gpg13":["4.11"]}, ... }}}
```

### G. Web 扫描告警（web-accesslog 解码器，真实部署样例，[VTechWorks 论文](https://vtechworks.lib.vt.edu/bitstreams/06a9133e-71bb-4f19-89c1-3890a851b64f/download)，原书排版去空格后）

```json
{
  "rule": {"description": "Web server 400 error code.", "id": "31101", "mitre": {"id": ["T1595.002"]}},
  "decoder": {"name": "web-accesslog"},
  "agent": {"name": "intranet-server", "ip": "192.168.10.4"},
  "data": {"srcip": "192.168.10.99", "id": "404", "url": "/admin/login.php"},
  "full_log": "192.168.10.99 - - [24/Jan/2022:03:57:25 +0000] \"GET /admin/login.php HTTP/1.1\" 404 488 \"-\" \"WPScan v3.8.20\""
}
```

SQLi 场景（31103，level 7，T1190）的完整 JSON 可用 logtest 直接产出：向 `PUT /logtest` 喂 `192.168.1.10 - - [..] "GET /users/?id=SELECT+*+FROM+users HTTP/1.1" 200 ..`（log_format 取 accesslog 对应值），即得与上同构、含 `data.url` 的告警。
