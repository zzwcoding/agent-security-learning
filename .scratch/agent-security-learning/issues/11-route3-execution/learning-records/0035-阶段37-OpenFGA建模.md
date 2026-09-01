# record 0035 - 阶段 37:OpenFGA 建模与授权矩阵落地(2026-09-01)

**学了什么**:OpenFGA 单容器内存存储部署(-p 8080:8080,Playground 挪 3001 避让 Langfuse);模型四类型 user/agent/tool/resource;四元组用三元组级联表达(agent 维 = 工具的 deployed_on 关系,资源维 = accessible_via→can_execute 两级展开);12 条真实元组(运维位 admin 1 + 全量部署 6 + 只读部署 2 + 只读直接授权 2 + 资源级联 1);check 六条全中。

**卡在哪**:模型 POST 400——OpenFGA API 的 union 必须套 `child` 数组(`{"union":{"child":[...]}}`),成员平铺非法;另有 metadata 的 directly_related_user_types 必须与 `{"this":{}}` 配套。解法:call() 带出错误体照改,不猜。小坑:Playground 3000 与 Langfuse 冲突,映射 3001。

**结论**:`scripts/setup-openfga.sh` 一键幂等重建整个授权世界(教学用内存存储,生产换 Postgres);`issues/11-route3-execution/authz-model.md` 为授权模型设计文档草案(阶段 46 升级交付物 01)。设计红利实测:运维位加新工具只需一条 deployed_on 元组,人侧授权自动继承。阶段 38:自写 tool_pre_invoke CPEX 插件把 check 接进网关,bob 打 shell 应得真实 403。
