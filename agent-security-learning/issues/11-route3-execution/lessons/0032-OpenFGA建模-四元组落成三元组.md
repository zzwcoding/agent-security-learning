# 0032 - OpenFGA 建模:四元组落成三元组

## 1. 三问

**位置感**:

```
✅ 34 网关上岗 → ✅ 35 三server挂网关 → ✅ 36 Agent改走网关 → ▶️ 37 OpenFGA建模(你在这里) → 38 越权攻击 → ...
```

**这一阶段是干嘛的?** 把票 10 拍板的授权矩阵(人 × Agent × 工具 × 资源)变成一个**真的授权引擎里的活模型**:部署 OpenFGA、写模型、灌真实数据、用 check 验证六个预期。

**什么需求逼我们这么设计?** 阶段 36 结束时,网关认票不认人——谁持有管理员 token 谁就是上帝。可"运维位全权限、只读位仅两个读工具"这种业务判断,该由一个专职组件回答;自己写授权判断就是图纸说的"灾难"。而且单个 Agent 撑不起矩阵(36 里 TS 第二消费者的意义此刻兑现)。

**它解决了什么麻烦?** "能不能用这个工具"从此有了唯一裁决点(PDP):一个 check 调用,输的是 (人, 工具),出的只有 True/False,默认拒绝。阶段 38 把网关插件接上去,check 的 False 就变成真实的 403。

## 2. 全链路一览

```
 scripts/setup-openfga.sh(一键,幂等)
   ├─ docker run openfga(内存存储;Playground 挪 3001,Langfuse 占 3000)
   ├─ POST /stores                 → store(一个授权世界)
   ├─ POST /authorization-models   → 模型(user/agent/tool/resource 四类型)
   ├─ POST /write                  → 12 条关系元组
   └─ POST /check × 6              → 六条预期全中 ✓
 阶段 38:网关 tool_pre_invoke 插件 ──check──▶ 这里,False = 403
```

## 3. 跟着数据走:一条 check 是怎么判出来的

以最有趣的 `check(user:divh, can_execute, tool:shell-run-command)`(返回 True)为例:

1. 直查:divh 有没有 `can_execute → tool:shell-run-command` 的直接元组?没有;
2. 模型说 can_execute 还有第二条路:`admin from deployed_on`——去找 `tool:shell-run-command` 的 `deployed_on` 元组 → 找到 `agent:starter-agent`;
3. 顺着走:谁是这个 agent 的 `admin`?→ 元组 `agent:starter-agent#admin@user:divh` → 命中 divh;
4. 展开链闭合,返回 True。**全程没有任何一行代码写"运维位可以用 shell"——三条元组 + 模型规则,判定自己长出来**。这就是 ReBAC 的红利:给运维位加新工具 = 只写一条 deployed_on,人侧授权自动继承。

## 4. 新技术点四要素

### OpenFGA check API

- **名字**:POST /stores/{store_id}/check,body 是 tuple_key + authorization_model_id。
- **作用**:唯一裁决接口——(user, relation, object) 进,True/False 出,无第三种答案;默认拒绝。
- **参数**:不带 model_id 会用最新模型(生产建议显式钉版本,审计可复现)。
- **本项目**:阶段 38 的网关插件是它唯一的调用方;脚本里的六条 check 是回归基准。

### 模型的 DSL 与 API JSON 两种形态

- **DSL**(给人读,model.fga,进设计文档):`define can_execute: [user] or admin from deployed_on`;
- **JSON**(给 API):集合运算套 `child` 数组;`X from R` = tupleToUserset(tupleset=R, computedUserset=X);带 `{"this": {}}` 的 relation 必须在 metadata 声明 directly_related_user_types。
- **踩坑**:把 union 成员平铺写(不套 child)= 400 Bad Request。踩坑解决方式是让脚本把错误体打出来再改——**读错误体,不猜**。

## 5. 关键顿悟

- **四元组是三元组级联出来的**:OpenFGA 没有"人×Agent×工具"一格,"agent 维"是工具上的 deployed_on 关系——维度即关系,不是字段。
- **默认拒绝是免费赠品**:bob 对 shell 没有任何元组,check 自然 False。授权系统里"没写允许"="拒绝",这个语义必须一字不差。
- **授权数据和业务数据一样要版本化**:model_id 每次写入递增,check 可钉版本复现——审计时"当时按哪版规则判的"答得上来,这是把授权当工程做的标志。

## 6. 亲手验证

```bash
# Playground(图形界面看模型和元组):浏览器开 http://localhost:3001
# 命令行复跑六条 check(幂等,30 秒重建世界):
cd /Users/divh/Downloads/安全评估agent/.scratch/agent-security-learning/starter-agent && ./scripts/setup-openfga.sh
```

**捣乱实验**:往模型里加一个 `define can_execute: [user] or admin from deployed_on or banned from deployed_on` 之类的自创关系前,先在 Playground(3001)里改 DSL 看报错——OpenFGA 会精确告诉你哪条关系缺 directly_related_user_types。改坏不心疼,重跑脚本即复原。
