# MISSION —— 票 13 路线 4 红队执行

> 方案:票 12 Answer(11 条定案)。本文件跟阶段进度,每阶段一段:做了什么、证据在哪、下一步。

## 阶段 47 ✅(2026-09-02):开工先决 + 薄层 + 武器校准

- 环境:garak 0.16.0(.venv-garak 独立)+ PyRIT 1.0.1(.venv 主环境);
  transformers 4.51.3→5.16.1 共存实证(llm-guard 钉死 4.x vs pyrit 要 5.x,两扫描器实测正常)——record 0043
- 薄 HTTP 层:`chat_server.py`(8000)+ `scripts/run-chat-server.sh`;烟测:良性轨迹✓ 注入拦截 blocked✓
- OpenFGA 重建(内存存储,`scripts/setup-openfga.sh`)
- 武器校准靶:反向案例 coding-agent 裸靶(8010,**全工具干跑**);garak 校准:
  dan 0 hits / promptinject.HijackHateHumans ASR 1.56% —— 武器响了
- 资产:`starter-agent/redteam-regression/`(payloads/tests/calibration/garak/reports + README)
- 教学:lesson 0042(薄 HTTP 层)、record 0043(开工先决坑)
- **下一阶段的钩子**:阶段 48 = garak 宽谱扫描——白名单五族(promptinject/encoding/
  packagehallucination/leakreplay 全量 + dan 节选)打 8000 收官形态,hits 人工分诊;
  注意 dan 族对 MiniMax-M2 信号弱(校准已示),判表阅读重心放 promptinject/encoding
