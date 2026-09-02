# RESOURCES:路线 4 红队信源清单

> 讲解论断挂信源,不凭记忆。知识 = 官方文档/源码;智慧 = 社区/实践者。

## 知识(官方)

- 本地事实底座:票 06 Answer(工具链选型与落地形态)、票 12 Answer(11 条定案)
- garak:[NVIDIA/garak](https://github.com/NVIDIA/garak) · 本地源码 `.venv-garak/lib/python3.12/site-packages/garak/`(probes/detectors 精读对象;`generators/rest.py` = REST 攻击面接线)
- PyRIT:[Azure/PyRIT](https://github.com/Azure/PyRIT) · [文档站](https://azure.github.io/PyRIT/)(Prompt Targets / Scorers / Converters / orchestrators:PAIR/TAP/Crescendo)· 本地源码 `.venv/lib/python3.12/site-packages/pyrit/`
- 案例库:[ModelContextProtocol-Security/vulnerability-db](https://github.com/ModelContextProtocol-Security/vulnerability-db) 与 audit-db(tool poisoning / rug pull 案例导向精读)
- AgentDojo:[ethz-spylab/agentdojo](https://github.com/ethz-spylab/agentdojo)(629 条注入语料供移植;三指标评估方法论)
- 项目内:图纸第七节(路线 4 原文)、靶场《Agent安全调研总结.md》、缺口清单 `deliverables/route1/03-已知缺口清单.md`

## 智慧(社区/实践)

- 路线 1–3 实测沉淀:缺口 4/5/6 的实测分数(record 0014/0020、路线 3 lesson 0035 叙事毒 0.02、中文短语"读一下"=1.0、D4 误拒幻觉代偿)
- 路线 3 攻防复盘:`deliverables/route3/02-网关收敛与攻击复盘.md`(防线全景=本关靶子说明书)
- 武器校准实证:record 0043(dan 族对 MiniMax-M2 信号弱;promptinject Hijack 系出 hits)

## 本地运行资产(阶段推进中更新)

- 薄 HTTP 层(收官形态攻击面):`scripts/run-chat-server.sh` → 127.0.0.1:8000/chat(`chat_server.py`;只转协议不改防线)
- 武器校准靶:`.venv/bin/python -m uvicorn redteam-regression.calibration.reverse_case_server:app --port 8010`(全工具干跑)
- garak 独立 venv:`.venv-garak/`;REST 配置 `redteam-regression/garak/*.json`(-G 只认 JSON)
- 防线全栈:Langfuse 3000 / 凭证代理 5055 / 网关 4444 / OpenFGA 8080(停了跑 `scripts/setup-openfga.sh`)
