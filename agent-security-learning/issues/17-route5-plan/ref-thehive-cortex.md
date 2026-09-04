# TheHive + Cortex 参照分析报告

> 用途：为「SOC 数字员工」demo 的 mock 案件后端提供数据模型与案件生命周期设计依据。
> 重要背景：TheHive 3/4 开源版已于 2023 年停止分发、GitHub 仓库归档；TheHive 5 起转为 StrangeBee 商业分发（社区版可免费自部署，企业功能收费）。因此公开的权威资料以 TheHive 5 官方文档（docs.strangebee.com）为主，辅以 TheHive 4 时代公开资料。来源：[TheHive GitHub README](https://github.com/TheHive-Project/TheHive)、[TheHive 5 Overview](https://docs.strangebee.com/thehive/overview/)

## 1. 解决什么需求

- **定位**：Security Incident Response Platform（SIRP，也常自我定位为 SOAR），覆盖事件全生命周期——告警分诊 → 案件调查 → 任务协作 → 响应处置 → 复盘报告。来源：[strangebee.com/thehive](https://strangebee.com/thehive/)
- **目标用户**：SOC、CSIRT、CERT、MSSP 团队的一线/二线分析师与组织管理员。来源：[Overview](https://docs.strangebee.com/thehive/overview/)
- **在 SOC 工作流中的位置**：检测工具（SIEM/EDR/IDS/防火墙）、威胁情报平台（MISP）、邮件服务器产生 **Alert**，推入 TheHive；分析师在 TheHive 里分诊，需要深入调查的转 **Case**，挂上 Task/Observable/TTP；Cortex 提供 analyzer（富化 observable）与 responder（对实体执行动作）。**告警不允许手工创建，必须来自外部工具**——这明确了它是"下游汇聚层"而非检测层。来源：[About Alerts](https://docs.strangebee.com/thehive/user-guides/analyst-corner/alerts/about-alerts/)、[About Cases](https://docs.strangebee.com/thehive/user-guides/analyst-corner/cases/about-cases/)
- **Cortex 的定位**：解决"用单一入口批量分析 observable 而非逐个查工具"和"主动响应威胁、与其他团队/外部服务交互"两个问题；Scala 编写，REST API 无状态可横向扩展，analyzer 多为 Python。来源：[Cortex README](https://github.com/TheHive-Project/Cortex)、[About Cortex](https://docs.strangebee.com/thehive/administration/cortex/about-cortex/)

## 2. 数据模型（重点）

### 2.1 Alert 字段结构（TheHive 5 API）

创建示例（来自官方 Functions Objects 文档，与 `POST /api/v1/alert` 一致）：

```json
{
  "type": "brute_force",        // 告警类型，自由文本（如规则名/来源类别）
  "source": "Firewall logs",    // 来源系统
  "sourceRef": "3432",          // 来源系统内的唯一标识 —— source+sourceRef 用于去重/关联
  "title": "...", "description": "...",
  "severity": 3,                // 1-4 整数
  "tlp": 2, "pap": 2,
  "observables": [{ "dataType": "url", "data": "http://example.org" }],
  "tags": ["..."], "customFields": {...}, "caseTemplate": "...",
  "date": "<ms 时间戳>",        // 事件发生时间（Occurred date）
  "status": "New"               // 见 2.3
}
```

来源：[Functions Objects](https://docs.strangebee.com/thehive/user-guides/organization/configure-organization/manage-functions/functions-objects/)、[Date Field Definitions](https://docs.strangebee.com/thehive/user-guides/date-field-definitions-alerts-cases/)、[n8n TheHive 节点教程（source/sourceRef 去重说明）](https://moksaweb.com/n8n-thehive/)
- 生命周期时间戳字段：`date`（发生时间）、`_createdAt`、`_updatedAt`、`newDate`、`inProgressDate`、`closedDate`、`importedDate`（转入 case 的时间）。来源：[Date Field Definitions](https://docs.strangebee.com/thehive/user-guides/date-field-definitions-alerts-cases/)
- Alert 可挂：observables、TTPs（MITRE ATT&CK patternId）、attachments、comments。来源：[About Alerts](https://docs.strangebee.com/thehive/user-guides/analyst-corner/alerts/about-alerts/)

### 2.2 Case 字段结构（来自官方审计日志示例中的完整 Case 对象）

```json
{
  "number": 34,                 // 自增案件号
  "title": "...", "description": "...",
  "severity": 3, "severityLabel": "HIGH",
  "tlp": 2, "tlpLabel": "AMBER", "pap": 1, "papLabel": "GREEN",
  "status": "InProgress", "stage": "InProgress",   // status 挂靠在硬编码 stage 上
  "assignee": "sami@example.com",
  "tags": ["tagA"], "flag": false,
  "customFields": [], "customFieldValues": {},
  "startDate": "...", "newDate": "...", "inProgressDate": "...", "endDate": "...",
  "timeToDetect": "...", "timeToTriage": "...", "timeToAcknowledge": "..."   // 自动计算的 KPI
}
```

来源：[About Audit Logs（含完整 Case 对象示例）](https://docs.strangebee.com/thehive/user-guides/organization/about-audit-logs/)
- Case 组成：observables、tasks、TTPs（ATT&CK）、attachments、comments、pages（知识库）。来源：[About Cases](https://docs.strangebee.com/thehive/user-guides/analyst-corner/cases/about-cases/)
- Task 字段（函数文档示例）：`title`、`group`（如 Identification/Containment/Remediation/Recovery/Report，NIST 式分组）、`status`、`mandatory`、`dueDate`、`assignee`、`flag`；task 下有 log（任务日志）。来源：[Functions Objects](https://docs.strangebee.com/thehive/user-guides/organization/configure-organization/manage-functions/functions-objects/)

### 2.3 状态机

- **Stage 是硬编码的四段骨架**：`New` / `Imported` / `In progress` / `Closed`，不可改、不可删、不可扩展。**Status 挂在 stage 下**，可自定义（管理员可增删、设颜色、隐藏）。Task 状态完全硬编码。来源：[About Statuses](https://docs.strangebee.com/thehive/administration/status/about-statuses/)、[Create a Status](https://docs.strangebee.com/thehive/administration/status/create-a-status/)
- **Alert 状态流转规则**：
  - TheHive 4 时代的预定义枚举：`New`、`Updated`、`Ignored`、`Imported`（经第三方迁移文档证实：[OpenSOAR migration doc](https://docs.opensoar.app/migrations/from-thehive-detailed/)）。
  - TheHive 5：`In progress` stage 的状态只在"开始调查告警"或"重开已关告警"时可选；`Closed` stage 状态只在关闭操作时可选；Closed 告警回到 New/In progress 需要 `manageAlert/reopen` 权限。来源：[Change an Alert Status](https://docs.strangebee.com/thehive/user-guides/analyst-corner/alerts/change-status-alert/)、[About Statuses](https://docs.strangebee.com/thehive/administration/status/about-statuses/)
  - 外部源（如 MISP）更新事件时可自动把告警从 New 改为 Updated 语义（"Ignore Alert Updates from MISP"功能侧面证实）。来源：[Ignore Alert Updates from MISP](https://docs.strangebee.com/thehive/user-guides/analyst-corner/alerts/ignore-alert-updates-misp/)
- **Case 状态**：同样挂在四段 stage 上（`Imported` stage 主要属于 alert；case 实际用 New/In progress/Closed 三段）。Case 关闭时必填 custom field 未填则不可关闭。来源：[About Cases](https://docs.strangebee.com/thehive/user-guides/analyst-corner/cases/about-cases/)
- **Task 状态**：硬编码不可扩展；官方文档未列枚举值。TheHive 4 时代为 `Waiting/Todo/InProgress/Completed/Cancel`（**未在 TheHive 5 官方文档证实**，标注"未证实"）。来源：[About Statuses](https://docs.strangebee.com/thehive/administration/status/about-statuses/)

### 2.4 分级体系

- **Severity**：1–4 整数 = Low / Medium / High / Critical（`severityLabel` 自动派生）。来源：[OpenSOAR migration](https://docs.opensoar.app/migrations/from-thehive-detailed/)（1-4 → low/medium/high/critical 映射）、审计示例 `severity:3 → HIGH`
- **TLP**（Traffic Light Protocol，信息共享约束，采用 MISP taxonomy 定义）：TheHive 5.2 起升级 TLP 2.0——`0=CLEAR, 1=GREEN, 2=AMBER, 3=AMBER+STRICT, 4=RED`（5.2 之前 0-3 为 WHITE/GREEN/AMBER/RED）。来源：[TheHive 5.2 release blog](https://blog.strangebee.com/thehive-5-2-released/)、[Change Classification Settings](https://docs.strangebee.com/thehive/user-guides/analyst-corner/cases/change-case-alert-classification-settings/)
- **PAP**（Permissible Actions Protocol，可对数据采取动作的约束）：0–3 = WHITE/GREEN/AMBER/RED，语义同 MISP taxonomy。来源：[How to create an analyzer（max_pap 表）](https://docs.strangebee.com/cortex/api/how-to-create-an-analyzer/)
- TLP/PAP 同时挂在 case/alert/**每个 observable** 上，且 Cortex 侧用 `check_tlp/max_tlp/check_pap/max_pap` 做执行闸门（见 §4）。

### 2.5 Observable

- dataType 枚举（Cortex analyzer 官方列举）：`domain, file, filename, fqdn, hash, hostname, ip, mail, mail_subject, other, regexp, registry, uri_path, url, user-agent`；第三方集成文档另见 `autonomous-system`（XSOAR 集成列表）。来源：[How to create an analyzer](https://docs.strangebee.com/cortex/api/how-to-create-an-analyzer/)、[XSOAR TheHive Project integration](https://xsoar.pan.dev/docs/reference/integrations/the-hive-project)
- 关键字段：`data`（或 attachment）、`dataType`、`message`、`tlp/pap`、`ioc`（布尔，是否 IOC）、`sighted`（是否在环境中实际观测到）+ `sightedAt`、`tags`、`ignoreSimilarity`（排除相似度计算）。来源：[Functions Objects](https://docs.strangebee.com/thehive/user-guides/organization/configure-organization/manage-functions/functions-objects/)、[TheHive4py 1.8.0 blog](https://blog.thehive-project.org/2020/11/30/thehive4py-1-8-0-is-hot-off-the-press/)
- observable 类型可在平台里自定义新增（`observableType.create`）。来源：[Functions Objects](https://docs.strangebee.com/thehive/user-guides/organization/configure-organization/manage-functions/functions-objects/)

### 2.6 Case linking

- TheHive 5.5 起 case 可链接其他 case 或外部资源，链接有 category（默认 Internal link / External link），双向显示、随 case 删除而删，不进导出/报表。来源：[About Cases](https://docs.strangebee.com/thehive/user-guides/analyst-corner/cases/about-cases/)
- Alert→Case 转化自动建立 alert-case 链接；case 可查看 "Linked alerts" 标签页。来源：[View Alerts Linked to a Case](https://docs.strangebee.com/thehive/user-guides/analyst-corner/cases/view-alerts-linked-to-a-case/)

## 3. Alert → Case 转化机制

三种分诊结局（来源：[About Alerts](https://docs.strangebee.com/thehive/user-guides/analyst-corner/alerts/about-alerts/)）：

1. **Create case from alert**（`manageAlert/import`）：单独成案，自动建 alert↔case 链接。
2. **Merge/Add alert into existing case**（`manageAlert/update`）：发现已有相似调查时并入。**observables、TTPs、attachments、comments、custom fields 自动转移进 case**；支持批量，默认一次最多合并 50 条（`alert.maxMergeInCase` 可调）。来源：[Add an Alert to an Existing Case](https://docs.strangebee.com/thehive/user-guides/analyst-corner/alerts/add-an-alert-to-an-existing-case/)
3. **Close alert**（`manageAlert/update`）：误报/重复直接关；必填 custom field 未填不可关；可重开。
   - 转化后 alert 状态进入 `Imported`（记录 `importedDate`），原 alert 保留可查。来源：[Date Field Definitions](https://docs.strangebee.com/thehive/user-guides/date-field-definitions-alerts-cases/)
- **去重**：`source + sourceRef` 是来源系统内唯一标识，用于防止重复建告警（第三方集成教程明确说明此用途；TheHive 旧版 API 对同 sourceRef 的重复 POST 走更新语义——**后者未在 TheHive 5 文档中直接证实**）。来源：[n8n 教程](https://moksaweb.com/n8n-thehive/)
- API 层面三个动词分工清晰：`alert.createCase`（转新案）、`alert.mergeWithCase` / `alert.bulkMergeWithCase`（并入旧案）、`alert.importInCase`（仅导入 observables 和 procedures 进已有 case）。来源：[Functions Objects](https://docs.strangebee.com/thehive/user-guides/organization/configure-organization/manage-functions/functions-objects/)
- Case↔Case 也可 merge：合并生成新案、删除原案、要求同组织同权限对；访问级别合并取**最严格**配置（附完整 3×3 合并矩阵）。来源：[About Cases](https://docs.strangebee.com/thehive/user-guides/analyst-corner/cases/about-cases/)

## 4. Cortex 的 analyzer/responder 模型

### 4.1 Analyzer 契约（observable in, report out）

- **输入**（stdin JSON）：`{ "data": "...", "dataType": "ip|hash|...", "tlp": 0, "pap": "...", "message": "", "parameters": {...}, "config": { analyzer 自身配置, "check_tlp", "max_tlp", "check_pap", "max_pap", proxy, jobCache... } }`。来源：[How to create an analyzer](https://docs.strangebee.com/cortex/api/how-to-create-an-analyzer/)
- **输出**（stdout JSON）：
  - 失败：`{"success": false, "errorMessage": "..."}`
  - 成功：`{"success": true, "summary": {"taxonomies": [{"namespace","predicate","value","level"}]}, "full": {任意 JSON 完整报告}, "artifacts": [{提取出的新 observable}]}`
  - taxonomy 的 `level` 四档：`info`（蓝）/ `safe`（绿）/ `suspicious`（橙）/ `malicious`（红）——这是 TheHive UI 直接渲染的恶意度评级。
- **Flavor 机制**：一个 analyzer 可有多份 service interaction 文件（JSON 描述符），声明 `dataTypeList`（接受哪些 observable 类型）、`max_tlp/max_pap`（**超过即拒绝执行，防数据外泄的 OPSEC 闸门**）、配置项 schema。如 VirusTotal 分 GetReport / Scan 两个 flavor。
- **TLP/PAP 闸门**：`max_tlp=2` 时 TLP:RED 的 observable 不执行——**分级标签直接决定工具可否运行**，这是最值得我们借鉴的机制。

### 4.2 Responder 契约

- 输入是 TheHive 实体而非裸 observable：`dataTypeList` 取值为 `thehive:case / thehive:case_artifact / thehive:alert / thehive:case_task / thehive:case_task_log`；`data` 段是整个实体 JSON。来源：[How to create a Responder](https://docs.strangebee.com/cortex/api/how-to-create-a-responder/)
- 输出：`{"success": true, "full": {"message": "..."}, "operations": [...]}`——**operations 是让调用方（TheHive）执行的回写指令清单**，枚举值按上下文划分：
  - case 上下文：`AddTagToCase, AddTagToArtifact, AddCustomFields, AddArtifactToCase, AssignCase, CreateTask`
  - alert 上下文：`AddTagToAlert, MarkAlertAsRead`
  - task log 上下文：`AddLogToTask, CloseTask`
- responder 典型用途：对 case/alert/observable/task 执行响应动作（发邮件、隔离主机、调 CrowdStrike 遏制等），结果以报告回流。来源：[About Cortex](https://docs.strangebee.com/thehive/administration/cortex/about-cortex/)、[Cortex-Analyzers 3.4.0 blog](https://strangebee.com/blog/cortex-analyzers-3-4-0-unleashing-the-falcon/)

### 4.3 对"工具分级"的启发

- **analyzer/responder 二分 = 只读富化 vs 写操作/外联动作**：天然对应 agent 工具的"观察类工具（无审批直接跑）"和"动作类工具（需确认门/审批）"。
- **声明式准入清单**：每个工具用 JSON 描述符声明 `dataTypeList`（能吃什么输入）和 `max_tlp/max_pap`（多敏感的数据不给它）——agent 侧可照抄为 tool manifest，按数据分级自动 gate。
- **输出契约统一**：`success/errorMessage + summary(taxonomies 四档评级) + full + operations(回写指令)` 是干净的"工具→平台"协议；特别是 **operations 由平台而非工具自己执行**，即"工具提议动作、平台裁决执行"，与 agent 的 human-in-the-loop 门天然同构。
- **flavor = 同一工具的不同能力变体**分别声明数据类型和敏感度上限（GetReport 只读可放宽，Scan 要上传样本要收紧）。

## 5. 权限与多租户

- **三层结构**：Organization（多租户单元）→ User（账号，组织内角色）→ Profile（权限集）。组织间有 link（`default/supervised/notify` 等 linkType）和 case 共享规则（partner 组织、共享内容、权限级别、taskRule/observableRule 取 `autoShare/manual`）。来源：[Functions Objects](https://docs.strangebee.com/thehive/user-guides/organization/configure-organization/manage-functions/functions-objects/)、[About Cases](https://docs.strangebee.com/thehive/user-guides/analyst-corner/cases/about-cases/)
- **预定义 Profile 六个**：Admin（平台级）、Org-Admin（组织级管理）、Analyst（标准分析师）、Read-Only、External-Reader/External-Actor（5.6 Portal 外部用户）；除 Analyst 外预定义不可改。来源：[About Profiles](https://docs.strangebee.com/thehive/administration/profiles/about-profiles/)
- **RBAC 粒度**：权限命名 `manageEntity/action`，如 `manageAlert/create, manageAlert/update, manageAlert/import, manageAlert/reopen, manageCase/update, manageCase/merge, manageCaseAccess/restrict, managePlatform, manageProfile`；每个操作文档都标注所需权限（如转案要 `manageAlert/import`）。文档页面直接用权限名做标题前缀，粒度到动作级。来源：[About Profiles](https://docs.strangebee.com/thehive/administration/profiles/about-profiles/)、各操作页
- **案件级访问控制**（5.5+，Platinum）：case 可 restrict 到指定用户（`UserAccessKind`），assignee 和操作人永远保留访问；四种 access kind：`OrganisationAccessKind / UserAccessKind / AllExternalAccessKind / ExternalAccessKind`。来源：[Functions Objects](https://docs.strangebee.com/thehive/user-guides/organization/configure-organization/manage-functions/functions-objects/)、[About Cases](https://docs.strangebee.com/thehive/user-guides/analyst-corner/cases/about-cases/)
- **Cortex 侧**：同样多组织 + 角色（`read / analyze / orgadmin / superadmin`），按组织限速配 quota。来源：[Cortex roles](https://docs.strangebee.com/cortex/user-guides/roles/)、[About Cortex](https://docs.strangebee.com/thehive/administration/cortex/about-cortex/)

## 6. 审计与可观测

- **每个 create/update/delete/merge/函数调用都产生 Audit 条目**，字段：`_id/_type=Audit/_createdBy/_createdAt`、`action`（create/update/delete/merge/invoke）、`mainAction`（主/派生事件）、`requestId`、`details`（**只含变更字段 diff**）、`objectId/objectType/object`（对象变更后完整快照）、`rootId`（父对象）、`context`、`organisation`。来源：[About Audit Logs](https://docs.strangebee.com/thehive/user-guides/organization/about-audit-logs/)
- 展示位置：case/alert 的 History 标签页 + Live Feed 实时流；审计日志可转发 SIEM/SOAR 触发自动化。
- 5.5.9 起 tags 和 custom field 变更也入审计（含 `customFieldChanges` 的 valuesAdded/valuesRemoved 结构化 diff）。
- 注意点：case 设为 restricted 后，默认（Cassandra/JanusGraph 存储）历史审计立即变私有；Elasticsearch 存储则保留创建时可见性——**审计可见性跟随数据可见性是设计决策点**。来源：同上
- Task log 本身也是"分析师操作留痕"的一等公民（`Find a Task Log` 称 audit trail）。来源：[Find a Task Log](https://docs.strangebee.com/thehive/user-guides/organization/analyst-corner/tasks/search-for-tasks/find-a-task-log/)

## 7. 我们可借什么

### 7.1 建议照抄（mock 案件后端 schema 子集）

- **Alert schema**：`type / source / sourceRef / title / description / severity(1-4) / tlp(0-4) / pap(0-3) / status / tags / date / observables[] / customFields`，加生命周期时间戳 `newDate/inProgressDate/importedDate/closedDate`。`source+sourceRef` 去重键一定要抄——这是 demo 演示"同一 SIEM 告警重复推送不重复建单"的最佳素材。
- **Case schema**：`number(自增) / title / description / severity+tlp+pap(带 label) / status+stage / assignee / tags / startDate/endDate / timeToDetect/timeToTriage/timeToAcknowledge(KPI 三元组) / tasks[] / observables[] / linkedAlerts[]`。
- **Observable**：`dataType(枚举15种) / data / message / tlp / pap / ioc / sighted / tags`。
- **状态机**：四段硬编码 stage（New/Imported/In progress/Closed）+ 可自定义 status 挂靠 stage，这个"两层状态"设计直接抄；alert 三结局（成新案/并入旧案/关闭）+ Imported 终态链接回案。
- **分级枚举**：severity 1-4、TLP 0-4（含 AMBER+STRICT）、PAP 0-3，三者同挂 alert/case/observable 三级。
- **Analyzer 工具协议**：`{data,dataType,tlp,pap,config}` in → `{success, summary.taxonomies[level四档], full, artifacts}` out；工具描述符里的 `dataTypeList + max_tlp/max_pap` 闸门——这是我们 agent"工具分级+数据敏感度 gate"的直接模板。
- **Responder operations 模式**：工具不直接改数据，返回 `{operations: [AddTagToCase, CreateTask, AssignCase...]}` 由平台裁决执行——对应 demo 的确认门设计，叙事上可以说"连 TheHive 生态都不让工具直接写库"。
- **审计 schema 子集**：`action / _createdBy / details(diff) / objectId / requestId`，给 agent 的每次工具调用留痕足够用。

### 7.2 不该照抄

- **多租户/组织间共享/Portal 外部用户**：demo 单组织即可，org link、share rule、access kind 四枚举全部砍掉，只留"一个组织 + 两三个 profile（admin/analyst/read-only）"撑 RBAC 演示。
- **Case↔Case merge 的九格访问级矩阵**：合并取最严访问级的逻辑复杂，demo 只做 alert→case merge 就够讲故事。
- **自定义 status/stage 两层**可简化为固定枚举（New/InProgress/Closed + alert 加 Imported/Ignored），demo 不需要运行时自定义状态。
- **customFields 的 mandatory-on-close 校验、case template 引擎、report template（HTML 模板渲染 analyzer 输出）、知识库 page、函数（Functions）平台**：都是 TheHive 的产品化重资产，demo 全部省略。
- **底层栈**（Cassandra + Elasticsearch + 图存储审计）：mock 用 SQLite/内存即可，别被架构吓住。
- **TLP 2.0 的五档**若嫌啰嗦可退回 0-3 四档（WHITE/GREEN/AMBER/RED），但建议在文档里注明我们用的是 5.2 之后口径。

---

未证实项已标注：Task 状态枚举（TheHive 4 为 Waiting/Todo/InProgress/Completed/Cancel，5 未列）、同 sourceRef 重复 POST 走更新语义（TheHive 5 文档未直接证实）。
