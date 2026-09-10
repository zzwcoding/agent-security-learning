"""种子脚本：创建默认知识库。

为什么 KB 创建走脚本而不是页面？webui 对 store 只读（modules.md webui 卡约定），
写操作一律走管线模块；KB 创建本幕没有管线承接，走脚本最干净（spec 依赖与风险③）。
多 KB 管理界面是阶段 13 的事。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # 让脚本能找到项目根的模块包

import store

store.init_db("data/app.db")
if store.list_kbs():
    print(f"知识库已存在：{store.list_kbs()}")
else:
    kb_id = store.create_kb("默认知识库")
    print(f"已创建默认知识库 kb_id={kb_id}")
