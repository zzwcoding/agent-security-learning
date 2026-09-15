# 0032 OpenFGA 建模 —— 知识卡片

### OpenFGA check 裁决接口（OpenFGA check API）

是什么：check 是 OpenFGA 提供的授权裁决接口。OpenFGA 是 Google Zanzibar 论文的开源实现（Zanzibar 是 Google 用关系元组做集中授权的系统）。输入是一个三元组 (user, relation, object)（谁、对什么对象、有什么关系），响应体只有 `{"allowed": true/false}` 一种形态。语义是存在性判定：仅当存在一条直接或可递归到达的关系路径（路径由 tuple 组成，tuple 是一条"谁对什么有什么关系"的记录）才返回 true，否则返回 false——等价于默认拒绝。check 在架构里扮演 PDP（Policy Decision Point，专职回答"允不允许"的集中式判定端点）。

解决什么问题：让"这个人能不能用这个工具"有唯一裁决点，而不是散落在各处业务代码里自己写 if——自己手写授权判断是安全实践里公认的灾难。存在性语义还省掉了"写拒绝名单"这门功课：用户 bob 对 shell 工具没有任何可到达的关系路径，check 自然返回 false，不需要任何人写过"拒绝 bob"。

我们的办法：用 docker 起一个内存存储的 OpenFGA，向 `/stores/{store_id}/check` 发 POST，body 带 tuple_key 和 authorization_model_id（即按哪版模型判）。跑六条 check 当回归基准。授权网关（拦下工具调用先问权限的中间层）是它唯一的调用方，check 返回 false 就被网关翻译成 HTTP 403。

### 四元组落成三元组（dimension as relation）

是什么：四元组落成三元组 [自造] 是把授权矩阵（把谁能用什么都列成一张表的业务侧写法）里"人 × Agent × 工具 × 资源"四个维度，翻译成 OpenFGA 只认的三元组 (user, relation, object) 的建模动作，规范等价说法是"把高维授权矩阵分解成关系图上的可达路径"。机制根基在 Zanzibar 的元组文法：user 端可以是一个 userset（"另一对象#关系"形式的集合型用户），所以 Agent 不必做成工具上的字段，而可以是工具对象上的一条关系。实例：给工具 `tool:shell-run-command` 写一条 `deployed_on`（部署于哪个 Agent）元组指向 `agent:demo`，"运维位通过这个 Agent 用 shell"就由模型规则推导出来，而不是存成一行配置。

解决什么问题：授权矩阵是业务语言，三元组是引擎语言，中间缺一条翻译规则就会退化成给每种"人-工具"组合硬写一条元组，矩阵每加一格数据就翻一倍。有了 userset 这条文法出路，给运维位上新工具只需新增一条 deployed_on 元组，人侧授权自动继承，不用挨个改人。

我们的办法：模型里建 user / agent / tool / resource 四个类型，工具类型上定义 `can_execute: [user] or admin from deployed_on`——人是 Agent 的 admin、工具部署在该 Agent 上，两条链一接，执行权就长出来了。

### ReBAC 级联判定（ReBAC cascade evaluation）

是什么：级联判定是 ReBAC（Relationship-Based Access Control，基于关系的访问控制）引擎求值一条 check 时的走法：在关系图上找一条可达路径，而不是查一张静态表。落到 Zanzibar 的三个重写原语上：`_this`（直接查本对象的元组）、`computed_userset`（同一对象换一条关系继续查）、`tuple_to_userset`（先沿关系跳到另一个对象再查）。实例：查 divh 对 shell 工具的 can_execute。直查：`_this` 没查到直接元组，模型给出第二条路 `admin from deployed_on`。级联：这一步是 tuple_to_userset，顺着工具的 deployed_on 元组跳到 `agent:demo`。再用 computed_userset 查谁是这个 Agent 的 admin——命中 divh，返回 true。全程没有任何一行代码写"运维位可以用 shell"。

解决什么问题：它让"权限从哪来"变得可解释——每个 true 都是 pointer chasing（顺指针追踪：沿关系图一步步走向答案）走出的一条路径，可以人工复走一遍，答案的出处清清楚楚。这是静态权限表给不了的，表只能告诉你"有"，说不出"凭什么有"。

我们的办法：六条 check 回归基准刻意覆盖直接命中和级联命中两条路径，改模型后重跑一遍，两条路径的判定行为都能对上预期。

### 授权模型双形态（DSL 与 API JSON）

是什么：授权模型双形态是指同一份模型有 DSL 与 JSON 两种等价写法。官方把 DSL 定位成加在 JSON 之上的语法糖（外表更甜、底层同一份的写法），发给 API 前会编译成 JSON。DSL（domain-specific language，为建模专门设计的小语言）写成给人读的 model.fga 文件，例如 `define can_execute: [user] or admin from deployed_on`；JSON（模型的机器形态）里 `or` 对应 union（并集）、`X from R` 对应 tupleToUserset（先沿 R 关系找到目标对象、再取其上 X 关系的标准算子）。两条官方硬约束最容易被漏。其一，tupleToUserset 里 from 后面的关系不能再引用另一个关系。其二，DSL 里不写 `[...]`（方括号类型限制）就禁止直接挂元组，等价于 JSON 里没有 `{"this": {}}` 和 directly_related_user_types（哪些用户类型能直接跟它建关系的声明）。

解决什么问题：两种形态各有一类读者——DSL 进设计文档给人审（官方把它用在 Playground、CLI、IDE），JSON 才能提交给 API 建模。手写 JSON 有实测的坑：把 union 成员平铺而不套 `child` 数组，API 直接回 400 Bad Request，报错信息还不直观。

我们的办法：踩坑后不靠猜——把错误响应体完整打出来读，OpenFGA 会精确指出哪条关系缺 directly_related_user_types；改模型前先在官方 Playground（图形化建模调试界面）里改 DSL 看报错，改坏了重建环境即复原。

### 授权模型版本化（authorization model versioning）

是什么：授权模型版本化指 OpenFGA 的模型是 immutable（不可变：模型一经创建就不能再删除或修改）。每次写入新模型都会新建一个版本，拿到新的 authorization_model_id（模型的版本标识）。check 调用可以显式指定按哪一版判。

解决什么问题：它让授权决策可复现、可审计——事后能答上来"这条 403 当时是按哪版规则判的"。官方明确不传 model id 时会退回 store 里最后创建的那版模型，并强烈建议生产环境显式传，历史决策才对得上当时的规则。

我们的办法：check 调用一律显式带 authorization_model_id，例如请求体写 `{"tuple_key": {"user": "user:divh", "relation": "can_execute", "object": "tool:shell-run-command"}, "authorization_model_id": "<版本号>"}`。六条 check 回归跑在同一版模型上，同样的输入永远得到同样的判定。
