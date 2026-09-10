# #52 · CI ruff 步骤两代尺子皆红 + 远端 CI 从未执勤

- Status: done（2026-09-10，c588894）
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

- [x] `ruff check services/guards services/gateway` 在钉定版本下 exit 0
- [x] 另一代 ruff（0.6.9 / 新版各跑一遍）对该目录也 exit 0 或仅剩钉定版本之外的合法差异（目标：双绿）
- [x] `pytest services/guards services/gateway` 全绿（改 import / 变量名不破坏行为）
- [x] requirements-dev.txt 为精确钉（无 `>=` 浮动）
- [x] 本地等价命令清单已补 ruff 步（更新 8-5.md 文末备注或总纲学习日志，原文正文零改动）
- [x] 不推送远端（留给用户），报告中说明

## 实现记录

（2026-09-10 修复完成）

### 7 处违规逐个修法

5×I001（`ruff 0.16.6 --fix` 自动，动手前人工核对 `pii_store.py` 仅 `import os/sqlite3/time` + DDL 常量、无 import 副作用，排序语义安全；修完 pytest 复跑确认）：
1. `services/guards/app.py:13` —— fastapi 与本地模块（injection_scan/pii/pii_store）两段 import 合并为单一排序块（删中间空行）；
2. `services/guards/conftest.py:7` —— `import pytest` / `import pii_store` 按字母序对调为 `pii_store` → `pytest`；
3. `services/guards/pii.py:12` —— `from pii_store import get_store` 从文件尾单独块移入 presidio 前的第三方排序块（pii_store 被默认集判为第三方，字母序在 presidio_analyzer 前）；
4. `services/guards/test_guards_contract.py:8` —— `from app import app` / `from fastapi.testclient import TestClient` / `from injection_scan import …` 合并为单一排序块（删空行）；
5. `services/guards/test_pii_mapstore.py:12` —— stdlib 块（pathlib）保留，`from fastapi.testclient import TestClient` 移到 `import pii_store` / `from app import app` 之后（同段内 `import x` 先于 `from x import` 的默认序）。

2×E741（手改，`l` → `line`，含两处绑定与 193/194 行全部用点）：
6. `services/gateway/test_proxy.py:192` —— 列表推导 `[line for line in dockerfile.splitlines() if line.startswith("COPY") and "requirements.txt" not in line]`；
7. `services/gateway/test_proxy.py:195` —— 生成器 `any(all(m in line for m in …) for line in copy_lines)`。

### 版本钉与 ruff.toml 决策

- `services/guards/requirements-dev.txt`：`ruff>=0.6` → **`ruff==0.16.6`**（钉新版：0.16 是把 isort 纳入默认规则集的"新尺"，本机 .venv 实测可得；精确钉同时冻结规则集，上游再改默认集也不会静默翻红）。文件内留注释说明缘由。
- **未新增 ruff.toml**：精确钉已实现"规则集冻结"这一目的，两代尺子对修后代码各自默认集实测双绿，无需再加第二重配置面（少一份配置 = 少一处两服务漂移的可能）。
- 备查（授权范围外未动）：`services/gateway/requirements-dev.txt` 仍有浮动 `ruff>=0.6`，但 CI 的 pip 对两条 requirements-dev 一次解析安装，guards 的精确钉已把解析版本约束到 0.16.6，不构成漂移面。

### 双尺验证证据（修复后实测，`cd soc-demo` 下执行）

- 钉定版：`.venv/bin/ruff --version` → `ruff 0.16.6`；`.venv/bin/ruff check services/guards services/gateway` → `All checks passed!`，**exit 0**
- 旧版：`uv tool run ruff==0.6.9 check services/guards services/gateway` → `All checks passed!`，**exit 0**
- （修复前基线：0.16.6 报 5×I001 exit 1；0.6.9 报 2×E741 exit 1——两代各红半边，与本票"现象"节一致）

### pytest 证据（照 CI 抄：各服务目录内 `python -m pytest`，soc-demo/.venv，Python 3.12）

- `services/guards` → **26 passed**（1 warning，torch FutureWarning，既有）
- `services/gateway` → **43 passed**（2 warnings，starlette DeprecationWarning，既有）
- 与 8-5.md 站 3 记录的修复前基线（26 + 43）一致 → import 排序/变量名改动零行为变更

### 文档半步

- `soc-demo/lessons/scenario/8-5.md`：**正文零改动**，文末追加引用块备注（照 2-2.md 票 50 先例）：引用等价清单 job3 原文，给出票 52 修复后的完整三行抄法（ruff + 两 pytest）与双尺验收数据。
- `soc-demo/lessons/scenario/00-导览总纲.md`：学习日志加一条票 52 修复记录；"发现的问题"节 #52 条目改"**已开票 #52 并修复（2026-09-10，…）**"并文末回填修复落地情况 + gateway 浮动钉备查说明。

### 未做半步（留给用户）

- **git add/commit 一律未执行**（主窗口验收后统一提交）；
- **推 workflows 上远端**（`git push` 让 origin/main 带上 .github/workflows，CI 真执勤）——外向动作，留用户执行。
