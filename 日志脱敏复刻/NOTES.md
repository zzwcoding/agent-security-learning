# NOTES:用户教学偏好随记

(从交接文档与主线沉淀继承;反复出现的升级进 learn-by-rebuild skill)

- 大白话教学:术语第一次出现配生活化比喻(门卫/纸条/门牌号);能举例子就不下定义
- 编号独立:本目录内 lessons/learning-records 从 0001 起,与主线(0025)、自修改agent复刻(0008)互不干扰
- 节奏:用户说"下一步"才推进;说"提交"才 commit,前缀 `复刻 N:`
- 参考项目只读勿改;对照物 memory_guard 从主线 .venv 借环境跑,勿改主线文件

## 选型决定(2026-08-31)

- 本复刻**留 Python 不换 TS**(依据根目录《Agent开发分层与语言选型.md》三语策略):① campaign 延迟指标要求三引擎同进程,regex 微秒级优势不能被跨语言 IPC 污染;② 阶段 11 对照物 Presidio/memory_guard 是 Py 垄断区(JS 无对应物);③ 本复刻是安全工程活,TS 合理位在路线 3 产品/MCP 客户端层。
- 后续挂账:**路线 3 用 TS 写被治理 agent 时**,把本复刻结论移植成 TS 日志脱敏中间件(langchainjs middleware / Mastra 挂载位)——那是练 TS 的正确位。

## 机器/环境偏好(2026-09-01)

- **Ollama 不开机自启**:用户选择手动管理(已 `brew services stop`,list 状态 none;安装与 qwen3:0.6b 模型保留)。要用时:`brew services run ollama`(临时跑,不注册自启)。LLM 相关阶段开工前先起服务,安全视角也是教学点:少一个常驻监听服务 = 少一分本机攻击面。
