"""阶段 1 · webui 冒烟测试。

绑定 spec rag-core.md 验收测试表第 4 行：Streamlit main() 可 import 且入库页函数存在。
页面可观察变化由用户亲手验证（learn-by-rebuild 纪律），不进 CI。
"""

import webui


def test_webui_smoke_ingest_page():
    """spec 验收第 4 行：入口 main 与入库页 page_ingest 存在且可调用。"""
    assert callable(webui.main)
    assert callable(webui.page_ingest)
