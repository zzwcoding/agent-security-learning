# HANDOFF:阶段 30 — chapter3/log-sanitization 对照复刻(平行窗口开工包,2026-08-31)

> ✅ **已完成(2026-09-01,平行窗口执行)**:11/11 阶段收官,commit `555a1c7`(campaign 基准)→ `c90302e`(收官)。产物:仓库根目录 `日志脱敏复刻/`(lessons/records 0001-0011 自编号,pytest 7 绿)。**收官交付物 `日志脱敏复刻/对照复盘-三引擎分工拍板.md`**:四方同卷成绩单(regex 泄露8/0.1ms、LLM 泄露10、hybrid 泄露2/R0.94、Presidio 泄露11)+ 五维必答 + **三出口拍板——memory.json=Presidio 保留;Langfuse trace 与本地日志=regex 在线全量 + hybrid 离线补扫**(阶段 33 收官报告直接引用)。重要实测:阶段 9 推翻"零命中才进 LLM"省成本设计;揪出"占位符幻觉磁铁"失效模式。Ollama 0.33.0 + qwen3:0.6b 已装(路线 4 复用,手动档不自启)。以下为开工时的原始交接,留档。

> 给新窗口的复刻专用交接。主线窗口(路线 2 阶段 31 四次攻击验收)与另一平行窗口(自修改agent复刻,阶段 25)可能与本窗口并行,互不阻塞。

## 0. 位置感

- 这是路线 2(票 09)的阶段 30:chapter3/log-sanitization **对照复刻**,教学纪律全文见 `learn-by-rebuild` skill(用户级已装,先读它)
- 复刻主题与路线 2 主线的关系:主线阶段 28 用 Presidio(`starter-agent/memory_guard.py`)守住了 `memory.json` 这**一个**数据出口;日志文件、工具输出、trace 落盘是另外几个出口。参考项目给的是"日志落盘前第一道防线"的完整形态:**离线规则引擎 + 端侧 LLM 引擎 + gold 基准对比**
- Ollama 环节同时是**路线 4 端云档热身**(路线 4 步骤 3 要精读 llama.cpp/Ollama 的按需加载与生命周期)——qwen3:0.6b 的能力边界体感直接复用
- **参考项目(只读,勿改)**:`/Users/divh/Downloads/深入理解agent 实验/ai-agent-book/chapter3/log-sanitization/`
- **本项目落点(沿用根目录惯例)**:`/Users/divh/Downloads/安全评估agent/日志脱敏复刻/`(与 `攻防矩阵复刻/`、`执行工具复刻/`、`自修改agent复刻/` 同风格)

## 1. 参考项目架构速览(共约 1750 行,开工先按此顺序读)

1. `README.md` — 双引擎全貌:离线规则引擎(默认,零依赖零网络)+ 本地 LLM 引擎(Ollama qwen3:0.6b 做 Level 3 PII)
2. `regex_sanitizer.py`(279 行)— **核心**:`_RULES` 18 条规则(类别/带标签占位符/正则/捕获组号/校验器),Luhn + 中国身份证校验码砍误报,重叠时高优先级胜出,按 span 重建文本;捕获组设计让 `password=xxx` 只脱值不脱键名;纯 stdlib
3. `samples.py`(65 行)— 离线演示样本(`--demo` 入口)
4. `config.py`(84 行)— Level 3 PII 系统 prompt + JSON Schema(`pii_items[].type/value`,value 要求逐字摘抄原文)
5. `agent.py`(409 行)— LogSanitizationAgent:Ollama 结构化输出流式(Ollama 挂了且设 OPENROUTER_API_KEY 才兜底出网);**`_value_appears_in_text` 原文出现检查——LLM 返回的值必须是源文本子串才收**,这是防"描述性前缀"幻觉回填的闸;TTFT/吞吐指标
6. `campaign.py`(269 行)— **实验 3-3 精华**:regex / LLM / 混合(regex 先行)三引擎在 gold 标注用例上对比 exact-span precision/recall、残余泄露、utility、延迟;负例用例(`13800138000 ns` 是延迟不是手机号、"password field must contain" 是规范语言不是口令)是防过拟合的考题
7. `main.py`(300 行)+ `test_loader.py`(173 行)— 入口编排 + 用例加载(loader 名字带 test_ 但**不是** pytest,是支持模块)
8. `metrics.py`(175 行)+ `tests/`(8 个离线回归)— 指标采集;规则边界回归(截断 PEM 到 EOF、带空格口令值、`Authorization: Basic` 不吃普通英文等)

核心思想一句话:**脱敏不是选一个引擎,而是分层管道——确定性规则打第一线(快、可审计、零依赖),语义盲区(病历/诊断/自然语言口令)才交给端侧 LLM,且 LLM 的每个检出值必须过"原文出现"的确定性验收才能回填;最后用 gold 基准量化三引擎各自的地盘。**

## 2. 阶段路线(11 阶段,每阶段 ≤30 行新增、可运行、有可观察变化)

| # | 新增什么 | 可观察变化 | 学到什么 |
|---|---|---|---|
| 1 | 骨架 + 自造样本集:8-10 条中文 Agent 日志(密钥类/PII 类/负例都要有,场景与主线 memory_guard 测试语料同风格) | 打印样本清单与分类 | 日志是 Agent 数据出海口;负例为什么第一天就要在 |
| 2 | 规则引擎上(密钥类):PEM 私钥/JWT/AKIA/ghp_/xoxb-/AIza/sk-/Bearer/Basic/口令赋值 + 带标签占位符 | before/after 打印 | Agent 日志最高频泄露是密钥不是身份证;占位符保留"这里原本是什么"的调试价值 |
| 3 | 校验器与重叠裁决:Luhn + 身份证校验码;多规则命中同段时高优先级胜,按 span 重建 | 假卡号不脱敏/真卡号脱敏;JWT 不被 email 规则吃掉 | 校验器砍误报;重叠裁决防重复替换——纯规则的工程细节全在这 |
| 4 | 规则引擎下(PII 类):邮箱/IBAN/SSN/中国手机/中国身份证/IPv4 + 类别 Counter 汇总 | 类别汇总报表打印 | 规则引擎完工;CN_PHONE/CN_ID 正则与主线 memory_guard 同款,对照着看 |
| 5 | 离线回归:pytest(截断 PEM/带空格口令/Basic 不吃普通英文/负例语言不误报) | pytest 全绿 | 规则是资产也是负债,回归护住它 |
| 6 | **Ollama 起步(路线 4 热身)**:安装 + `ollama pull qwen3:0.6b` + 裸 `/api/chat` 冒烟 | 模型流式回复打印 | 端侧小模型就位;0.6B 能力边界第一次体感 |
| 7 | LLM 引擎:Level 3 PII 系统 prompt + JSON Schema 结构化输出 + 流式 + TTFT/吞吐指标 | 流式 JSON + 指标打印 | 小模型干结构化任务;schema 约束防自由发挥 |
| 8 | 回填验收与失败模式:`_value_appears_in_text` 原文出现检查;造一个"描述性前缀"失败样例演示拒收 | 拒收样例打印 | 模型输出永不直接信任;确定性验收是防幻觉回填的闸 |
| 9 | 混合管道:regex 先行,规则零命中才进 LLM;结果合并去重 | 每条样本打印"走了哪条路" | 管道分工:便宜确定的先走,贵的补漏 |
| 10 | campaign 基准:gold 标注用例集(含负例),三引擎对比 exact-span P/R、残余泄露、延迟 | 三引擎对比表打印 | 用数据回答"哪种引擎管哪类",不靠感觉 |
| 11 | **对照收官(路线 2 特色)**:同批样本过主线 `memory_guard.py`(Presidio);按 §4 必答出对照表写复盘 | 对照表 + 复盘 md | 规则 vs NER vs 端侧 LLM 的分工拍板 |

节奏纪律(learn-by-rebuild):用户说"下一步"才推进;说"提交"才 commit(前缀建议 `复刻 N:`,与主线 `阶段 N:` 区分)。

## 3. 环境现实(本机已核实 2026-08-31,勿重复调研)

- **Ollama 未装**(无 `ollama` 命令、无 /Applications/Ollama.app)。阶段 6 先 `brew install ollama`(或官网 app)+ `ollama pull qwen3:0.6b`(~500MB;arm64 Metal 直接跑,冷加载数秒,CPU 也够)
- **不依赖参考项目的评测框架**:参考 `main.py` 批量路径要 `../user-memory-evaluation/`(在语料仓库里);复刻**不需要**它——样本与 campaign 用例全自造,参考项目只读勿抄
- **依赖极简**:规则引擎纯 stdlib 零依赖;LLM 路径 `pip install ollama`,或直接 `curl http://127.0.0.1:11434/api/chat`(更贴协议本质,二选一在阶段 6 定)
- **对照物在主线**:`starter-agent/memory_guard.py`(Presidio Analyzer→Anonymizer + 自定义 CN_PHONE/CN_ID PatternRecognizer),主线 lesson 0024 有 pipeline 图。阶段 11 对照时**从 `starter-agent/.venv` 借环境跑它,勿改主线文件**
- **本复刻零真密钥**:样本里所有 key/token 全是假值,不碰 Keychain,`.env` 假密钥纪律照旧
- **macOS + arm64**:全程本地,无其它环境依赖

## 4. 对照复盘必答题(阶段 11 的落点,写进复盘 md)

**同一个数据出口的脱敏,规则引擎 / Presidio NER / 端侧 LLM 三者怎么分工?** 至少从五个维度对比后给结论,不许和稀泥:
1. 检测面:密钥类(格式固定,规则稳赢)vs Level 3 语义 PII(病历/诊断/自然语言口令/住址,正则写不出)——用 campaign 的 medical/passport/financial/natural_password 用例实测各自边界
2. 负例守恒:脱敏过度毁调试价值(`13800138000 ns`);三引擎谁误报少,拿数据说话
3. 幻觉与验收:Presidio 给 span(无幻觉问题);LLM 给"它认为的值",必须过原文出现检查——两种防幻觉机制的本质区别
4. 成本与可解释性:规则微秒且可审计;NER 模型加载一次后毫秒;0.6B 推理秒级;出事复盘时"为什么脱敏这里"谁能举证
5. **落点拍板**:starter-agent 的数据出口——`memory.json`(主线阶段 28 已配 Presidio)、Langfuse trace、本地日志文件——三个出口各配哪层,给结论

## 5. 归档与编号约定

- 项目内自建 `MISSION.md` / `RESOURCES.md` / `lessons/` / `learning-records/`(learn-by-rebuild 纪律);**编号从 0001 起在自己的目录内**,与主线 `issues/09-route2-execution/lessons/`(已用到 0025)、`自修改agent复刻/`(已用到 0008)互不干扰
- 收官动作:项目内收官 commit(`复刻收官:`前缀)+ 顺手把 `issues/09-route2-execution/MISSION.md` 阶段 30 行勾掉(⚠ 只 add 自己的文件和 MISSION 这一行,主线/另一平行窗口可能有未提交改动);已知遗留:`lessons/0019-tool&mcp.md` 编号撞车待用户处置,复刻窗口不要动它
- Ollama 装完是**全局环境**,路线 4 直接复用(热身目的达成,不要卸)
- 复盘结论同步:主线阶段 33 收官(`deliverables/route2/`)可引用本复刻的三引擎对照表

## 6. 复制即用开场白

```
读 /Users/divh/Downloads/安全评估agent/.scratch/agent-security-learning/issues/09-route2-execution/HANDOFF-阶段30-日志脱敏复刻.md,
按 learn-by-rebuild 的纪律在仓库根目录做 chapter3/log-sanitization 的对照复刻(项目放 日志脱敏复刻/),从阶段 1 开始。
```
