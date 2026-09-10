"""guards 测试隔离（票 49）：每条用例把 PII mapstore 指到独立 tmp 文件。

mapstore 路径经 PII_MAPSTORE_PATH env 注入（agent 侧 TOOLS_MANIFEST_FILE 同款
接缝），生产缺省 data/pii-mapstore.sqlite。autouse 保证既有测试（票 04/24/32）
一行不改就回到隔离库上跑——不污染开发机的 data/，用例之间互不见对方的映射。
"""
import pii_store
import pytest


@pytest.fixture(autouse=True)
def _isolate_mapstore(tmp_path, monkeypatch):
    monkeypatch.setenv("PII_MAPSTORE_PATH", str(tmp_path / "pii-mapstore.sqlite"))
    pii_store.reset_store()
    yield
    pii_store.reset_store()
