# 授权模型设计文档(草案 → 阶段 46 升级为交付物 01)

> 阶段 37 产出。可运行的世界:`scripts/setup-openfga.sh` 一键重建(store/model/12 tuples/演示 check)。
> 本地实例:OpenFGA 单容器内存存储,API `127.0.0.1:8080`,Playground `localhost:3001`(Langfuse 占 3000)。

## 1. 授权矩阵(人 × Agent × 工具 × 资源)

| 人 | Agent | 工具范围 | 授权途径 |
|---|---|---|---|
| divh(运维位) | starter-agent(Python) | 全部 6 个 | `agent:starter-agent#admin@user:divh` → 经 `deployed_on` 级联获得所有部署其上的工具 |
| bob(只读位) | ts-second-agent(TS) | filesystem-read-file、filesystem-list-dir | 直接 `can_execute` 授权;这两个工具部署在 ts agent 上 |
| bob | starter-agent | 无 | 没有任何元组指向——OpenFGA 默认拒绝(fail closed) |

资源维度:`resource:workspace-notes` 经 `accessible_via tool:filesystem-read-file` 级联——**能执行读工具的人才能访问该资源**。四维里"资源"不单独发授权,永远从工具级联,避免同一权限两处维护。

## 2. 模型(model.fga DSL)

```
model
  schema 1.1

type user

type agent
  relations
    define admin: [user]        # 谁管理这个 agent

type tool
  relations
    define deployed_on: [agent]              # 工具部署在哪个 agent 上
    define can_execute: [user] or admin from deployed_on   # 直接授权 or 经 agent 管理权级联

type resource
  relations
    define accessible_via: [tool]            # 资源经由哪个工具触达
    define can_access: can_execute from accessible_via     # 沿工具的 can_execute 级联
```

与 API JSON 的对应(踩坑记):OpenFGA API 不吃 DSL,要 JSON——**集合运算必须套 `child` 数组**(`{"union": {"child": [{"this": {}}, {"tupleToUserset": ...}]}}`),直接把成员平铺在 union 里是 400。DSL→JSON 的心译规则:`A or B` → union.child;`X from R` → tupleToUserset(tupleset=R, computedUserset=X);每个 `{"this": {}}` 的 relation 要在 metadata 里声明 directly_related_user_types。

## 3. Zanzibar 关系元组:四元组怎么落成三元组

OpenFGA 原生只有 (user, relation, object) 三元组,"人×Agent×工具"靠**对象类型层级 + 级联展开**表达:

```
user:divh        admin         agent:starter-agent     # divh 管理 starter-agent
agent:starter-agent  deployed_on  tool:shell-run-command  # 该工具部署在该 agent 上
→ check(divh, can_execute, tool:shell-run-command) = True   # 自动沿两级展开
```

实际写入 12 条:运维位 1(admin)+ 全量部署 6 + 只读位部署 2 + 只读直接授权 2 + 资源级联 1。

## 4. 验证证据(阶段 37 实测,六条全中)

```
✓ check(user:divh, can_execute, tool:shell-run-command)   = True   经 agent#admin 级联
✓ check(user:bob,  can_execute, tool:shell-run-command)   = False  无授权即拒绝(fail closed)
✓ check(user:bob,  can_execute, tool:filesystem-read-file)= True   直接授权
✓ check(user:bob,  can_execute, tool:filesystem-write-file)= False
✓ check(user:divh, can_access,  resource:workspace-notes) = True   资源级联(经 admin→deployed_on→can_execute 两级展开)
✓ check(user:bob,  can_access,  resource:workspace-notes) = True   (经直接授权一级展开)
```

## 5. 设计取舍(为什么这么建)

- **授权引擎引入而非自写**:图纸原文"自己写是灾难"。OpenFGA 单容器内存存储教学够用,重跑脚本 30 秒重建;生产要挂 Postgres(一致性,不是性能)。
- **"能执行什么"归 OpenFGA,"能看什么"归网关 RBAC**:票 10 拍板的粒度分工——ContextForge 原生无 per-tool grant(团队可见性+virtual server 止步于"可见"),四元组细粒度必须外部 PDP。
- **agent 维的建模方式**:选"工具 deployed_on agent + 人 admin/直接授权"而不是"人-agent-工具绑定表",让"给运维位加一个新工具"只写一条 deployed_on 元组,人侧授权自动继承——加工具不加授权,这是 ReBAC 级联的红利。
- **已知留白(阶段 38 处理)**:模型此刻不含"通过哪个 agent 发起"的请求上下文——check 由网关插件按调用方身份组装(user 取 token、tool 取请求参数);资源级联的 check 在网关场景暂不触发,属交付物文档的完整性部分。

## 6. 下一步(阶段 38)

自写 ContextForge `tool_pre_invoke` CPEX 插件:拦截每次工具调用 → 从 token 取 user、从请求取 tool 名 → 调 `check` → 拒绝则 fail closed。到时候 `check(bob, can_execute, tool:shell-run-command) = False` 将变成 TS client 的一次真实 403。
