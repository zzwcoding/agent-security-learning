# #52 · CI ruff 步骤两代尺子皆红 + 远端 CI 从未执勤

- Status: open
- Priority: P2
- Discovered: 2026-09-10（场景 8 步 8.5 收官实测，教学导览发现）
- Modules: guards / gateway / CI

## 缺口解剖

位置三处：
- `.github/workflows/ci.yml:53` —— python job 的 `ruff check services/guards services/gateway`
- `services/guards/requirements-dev.txt:3` —— 浮动钉 `ruff>=0.6`（没钉精确版本）
- 违规文件本体（见现象）

现象三层：
1. 本机 .venv ruff **0.16.6** 对 services/guards 报 5 处 **I001**（app.py:13 / conftest.py:7 / pii.py:12 / test_guards_contract.py:8 / test_pii_mapstore.py:12），连 `--isolated` 纯默认也报 = 新版 ruff 把 isort 纳入默认规则集；
2. 换 ruff **0.6.9**（uv tool run）I001 消失、却报 services/gateway/test_proxy.py:192,195 两处 **E741** —— **两代尺子都红，该步骤按现状不可能绿**；
3. origin/main 仅 17 个文件的旧 stub（.github/workflows 未推送、本地 main 领先 156 提交），**CI 从未在远端跑过任何一次** —— 而 7.4 的本地等价当时漏抄了 ruff 半步（只跑了 pytest），红因此一直没暴露。

## 修法（推荐，组合拳）

1. 修 7 处违规：5×I001（import 排序，`ruff --fix` 可自动）+ 2×E741（歧义变量名，手改）。**验收口径：0.6.9 与 0.16.6 两代尺子各自全绿**（不管最终钉哪版，都别让另一版一跑就红）；
2. `requirements-dev.txt` 把 `ruff>=0.6` 改为**精确钉**（版本以修完实测两版皆绿的那一版为准，倾向钉新版）；若有必要加 ruff.toml 明示规则集，防止未来 ruff 再改默认集时静默翻红；
3. 把 ruff 步补进**本地 CI 等价命令清单**（8-5.md 交底过漏抄，总纲学习日志有备案）；
4. 推 workflows 上远端让 CI 真执勤 —— **此半步留给用户执行**（外向动作，子 agent 不做 git push / 远端操作），票内只交付本地就绪态。

## 验收清单

- [ ] `ruff check services/guards services/gateway` 在钉定版本下 exit 0
- [ ] 另一代 ruff（0.6.9 / 新版各跑一遍）对该目录也 exit 0 或仅剩钉定版本之外的合法差异（目标：双绿）
- [ ] `pytest services/guards services/gateway` 全绿（改 import / 变量名不破坏行为）
- [ ] requirements-dev.txt 为精确钉（无 `>=` 浮动）
- [ ] 本地等价命令清单已补 ruff 步（更新 8-5.md 文末备注或总纲学习日志，原文正文零改动）
- [ ] 不推送远端（留给用户），报告中说明

## 实现记录

（待填）
