# 阶段 8:Docker 容器化

## 一、三问(阶段动机)

**这一阶段是干嘛的**:把整个 Agent(Python 代码 + 三个 MCP server + workspace 素材)打进一个 Docker 镜像,容器里跑通验收流。

**因为什么需求需要这么设计**:规格验收③要求 `docker build` 可容器化运行。学习层面还有两重动机:一是"可复现"——依赖锁定 + 镜像构建意味着任何机器上行为一致,这是安全实验的基本功(结论要能被别人复现);二是为路线 1/2 埋伏笔——现在 Agent 和你同机同权,容器化之后"Agent 能干的事"被关进了一个可度量的边界里,后面的沙箱关卡就是把这个边界越收越紧。

**解决了什么问题**:依赖从"直接依赖钉版本"升级为全量锁定(63 个包一个不漏);密钥注入方式从"宿主机脚本"平移为"容器环境变量";CLI 交互、MCP 子进程、workspace 挂卷这三个容器化的经典坑全部趟平。

## 二、全链路一览

```
构建时(不含任何秘密):
Dockerfile: python:3.12-slim → COPY 锁文件 → pip install(63 包全量锁定)
           → COPY 代码(agent/config/mcp_servers/workspace 素材)
           → 镜像 starter-agent:latest

运行时(秘密此刻才注入):
scripts/docker-run.sh
   │  agent-key minimax → -e LLM_API_KEY=...(只存在于容器进程环境)
   │  -v $PWD/workspace:/app/workspace(容器写 summary.md,宿主立刻可见)
   ▼
容器内: python agent.py → 照旧拉起 3 个 MCP 子进程(同容器 stdio,无需端口)
   │  fetch 出网走容器 NAT;memory.json 写在容器层,--rm 后消失
   ▼
宿主机: cat workspace/summary.md 验证容器内写盘成功
```

## 三、跟着数据走 3 步

1. **构建分层**:`COPY requirements-lock.txt` 和 `pip install` 在前,`COPY . .` 在后。改代码不重装依赖(缓存命中),改依赖才重装——层序就是构建速度的开关。
2. **运行时注入**:镜像里没有任何密钥。`docker run -e LLM_API_KEY=$(agent-key minimax)` 让 key 只出现在容器进程的环境里;对照:`workspace/.env` 里的假 key 是 COPY 进镜像的——**一个是"镜像的一部分",一个是"运行的参数",真假密钥走两条完全不同的路**,这条分野就是路线 2 凭证代理要形式化的东西。
3. **容器内验收**:容器里一句话完成 读 notes.txt → 总结 → 写 summary.md,`run_command` 和 `http_get`(200 OK)也在容器内真实触发;summary.md 通过挂卷在宿主机可见——容器内副作用、宿主机可观测。
4. **容器里的记忆(踩坑实录)**:第一版 `docker-run.sh` 只挂了 `workspace/`,`memory.json` 写在容器可写层,`--rm` 一退即焚——"重启失忆"。修复=把 `memory.json` 也挂卷;但挂卷要求宿主文件先存在(否则 docker 建出同名**目录**),所以脚本里先 `touch` 占位,`load_memory()` 相应加了"空文件跳过"的守卫。**容器里任何想留下的状态,都必须显式挂卷**——忘了挂的默认结局就是丢。

## 四、新技术点四要素

### 依赖锁定(直接 vs 全量)

- **名字**:lockfile;本项目两档:`requirements.txt`(直接依赖,人维护)+ `requirements-lock.txt`(`uv pip freeze` 生成,63 个包含间接依赖全钉死)
- **作用**:解决"我这能跑你那不能跑"。只锁直接依赖时,间接依赖(如 httpx 的依赖)会随时间漂移;全量锁定让任何时间的构建结果逐字节一致
- **参数**:`uv pip freeze --python .venv/bin/python > requirements-lock.txt`;什么时候重新生成:每次改 `requirements.txt` 后
- **用法**:挂载点 `Dockerfile` 的 `pip install -r requirements-lock.txt`(容器内用标准 pip,不引 uv,镜像更小)

### Docker 关键三参数(本项目用到的)

- **名字**:`-e`(环境变量)/ `-v`(卷挂载)/ `-i` 与 `-it`(交互)
- **作用**:`-e` 运行时注入配置与秘密;`-v` 把宿主目录映射进容器(workspace 双向同步);`-i` 保 stdin 开放(CLI 管道输入需要),`-t` 分配伪终端(人肉交互才需要,脚本里加 `-it` 在非 TTY 下会直接报错)
- **参数**:`-v 宿主路径:容器路径` 方向别搞反;`--rm` 跑完即删容器,不留尸体
- **用法**:挂载点 `scripts/docker-run.sh`;教学坑:自动化测试用 `-i` 不用 `-it`

## 五、关键顿悟

- **密钥进镜像=永久泄露**:打进镜像层的东西,删文件也救不回来(层还在)。所以秘密永远走 `-e` 运行时注入,`.dockerignore` 再兜一层(防止误 COPY 真 `.env`)。
- **容器内 stdio MCP 零改动**:三个 server 本来就是同机子进程,进容器后依然同机——MCP 的 stdio 形态天然适合整体容器化;哪天 server 要拆出去单独隔离,才需要换 HTTP transport。
- **容器边界是现在最松、未来最紧的那道墙**:今天容器只是打包工具;路线 1 给它加只读文件系统、降权用户、网络白名单,它才开始变成防线。先跑通,再收紧。
