# 阶段 4:virtual_terminal 裸执行(先能跑,下阶段装门卫)

## 一、三问(阶段动机)

**你在整盘棋的哪一步**(终极目标:给 AI 助手用的工具,每个进门先安检):

```
✅ 阶段 2-3   写文件工具:能写,且有边界+语法两道闸
👉 阶段 4     跑命令工具:先做到"能跑",暂无闸——本阶段
⬜ 阶段 5-6   给它装安检:危险命令硬拦 → 可疑的送另一个 AI 审批
⬜ 阶段 7-9   跑代码工具、长输出截断、文件编辑
⬜ 阶段 10-12 换回 agent 身上:同一个攻击,裸奔版闯祸、带闸版被拦
```

**这一阶段是干嘛的**:长出第二个执行工具 `virtual_terminal`——给它一条 shell 命令,
它在 workspace 目录里跑,把输出和退出码拿回来。

**为什么需要**:AI 干活免不了跑命令(统计词数、看目录、跑脚本……)。
我们先做"能跑"这一半;**门卫(危险命令拦截)故意留给阶段 5-6**——
这样你能亲眼看到"裸奔的执行工具长什么样",才知道门卫在防什么。
所以注意:此刻它和 starter-agent 的 run_command 一样裸,别拿它跑危险命令。

**解决了什么问题**:给"执行"一个统一入口——30 秒超时上限、输出结构化、
出发点钉在 workspace,而不是随手 subprocess 散落各处。

## 二、全链路一览

```
python cli.py shell "wc -w hello.txt"
  → cli.py               解析出命令字符串
  → virtual_terminal()   执行工具本体
  → subprocess.run       起子进程,在 workspace 里跑,最多等 30 秒
  → 结果 JSON            success / returncode / stdout / stderr
```

## 三、跟着数据走 3 步

拿失败的 `ls /nonexistent_dir_xyz` 走一遍(实跑记录):

1. **进来时**:就是字符串 `"ls /nonexistent_dir_xyz"`。
   `shell=True` 表示把它交给系统 shell 整个解释——所以 `&&`、管道这些都能用。
2. **执行时**:子进程在 workspace 目录里跑,`ls` 找不到目标,
   往 stderr 写报错,退出码 1。
3. **回来时**:`{"success": false, "returncode": 1, "stdout": "", "stderr": "ls: ..."}`。
   **成不成不看有没有输出,看退出码**——0 才是成功,这是 shell 世界的老规矩。

## 四、新技术点:subprocess.run

- **名字**:`subprocess.run`,Python 标准库 subprocess 模块
- **作用**:起一个子进程执行命令,等它结束,收集结果。是 Python 里"跑外部命令"的正门。
- **参数**(本项目 `execution_tools.py:15`):
  - `shell=True`:命令交给系统 shell 解释。好处:`&&`、管道、通配符都能用;
    代价:命令文本会被完整解释,**方便和危险同体**——注入一个 `;rm -rf xx` 也会被执行。
  - `capture_output=True`:把 stdout/stderr 接住,不然直接打到你自己终端上
  - `text=True`:输出按字符串解码,不然是字节
  - `timeout=30`:最多等 30 秒,超时抛 `TimeoutExpired`(我们兜住转成 success=false)
  - `cwd=WORKSPACE_DIR`:子进程的出发点目录
- **用法**:`subprocess.run(command, shell=True, capture_output=True, text=True, timeout=30, cwd=WORKSPACE_DIR)`

## 五、关键顿悟

- **cwd 是出发点,不是围墙**:`cwd=workspace` 只是"命令从这里出发",
  命令里写绝对路径(如 `cat /etc/hosts`)照样够得到外面。参考项目也一样——
  所以真正的防线是下两个阶段的门卫,不是 cwd。
- **shell=True 方便与危险同体**:能写 `ls && wc` 的代价,是恶意文本也会被完整执行。
  这就是为什么命令进门必须先查(下阶段),不能像文本一样信任。
- **成功看退出码,不看输出**:很多命令成功时一个字都不输出(如 `mv`)。
  用"输出为空"判断成败会冤枉好命令。
