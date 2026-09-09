"""票 49 验收测试（ADR 0004-3）：PII mapstore 落盘 + 受控反查口 /pii/reveal。

- 脱敏产出映射落 guards 自持 sqlite，重启（重开库）不丢（验收 1）；
- 同占位符多实体存多条（去重），反查返回全部原文（形态记票：wire 占位符
  保持 `<TYPE>` 不编号——FR-S4.1 契约不动，多原文以列表回）；
- 反查查无此人 404、缺参 400（错误面 {"error": code} 全仓同款）。

角色闸不在 guards：反查是人的动作不是工具调用，agent 侧端点白名单
（duty_lead/admin）把关后转发到这里（见 agent 侧 pii-reveal.test.ts）。
存储隔离：conftest.py autouse 把 PII_MAPSTORE_PATH 指到每条用例的 tmp_path。
"""
from pathlib import Path

from fastapi.testclient import TestClient

import pii_store
from app import app

client = TestClient(app)

TEXT = "请联系 张三 13812345678，邮箱 zhangsan@example.com"
PHONE = "13812345678"
EMAIL = "zhangsan@example.com"


def anonymize(text: str) -> dict:
    r = client.post("/pii/anonymize", json={"text": text, "language": "zh"})
    assert r.status_code == 200, r.text
    return r.json()


def reveal(placeholder: str) -> object:
    return client.post("/pii/reveal", json={"placeholder": placeholder})


def test_anonymize_records_mapping_and_reveal_returns_originals():
    out = anonymize(TEXT)
    assert PHONE not in out["text"] and EMAIL not in out["text"]
    r = reveal("<PHONE_NUMBER>")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["placeholder"] == "<PHONE_NUMBER>"
    assert PHONE in body["originals"]
    r = reveal("<EMAIL_ADDRESS>")
    assert r.status_code == 200, r.text
    assert EMAIL in r.json()["originals"]


def test_reopen_store_survives_restart():
    """验收 1：落盘重启不丢。reset_store() 关掉现连再按同一路径重开 = 换进程的等价物。"""
    anonymize(TEXT)
    pii_store.reset_store()
    assert reveal("<PHONE_NUMBER>").json()["originals"] == [PHONE]


def test_same_placeholder_lists_all_distinct_originals():
    two = "白卡 13812345678，黑卡 13998887777，邮箱再抄送 zhangsan@example.com"
    out = anonymize(two)
    assert out["text"].count("<PHONE_NUMBER>") == 2  # wire 不变：占位符不编号
    originals = reveal("<PHONE_NUMBER>").json()["originals"]
    assert originals == ["13812345678", "13998887777"]  # 两条都收，首见序
    # 同原文重复出现只存一条（PRIMARY KEY (placeholder, original) 去重）
    anonymize("再次出现 13812345678")
    assert reveal("<PHONE_NUMBER>").json()["originals"] == ["13812345678", "13998887777"]


def test_reveal_unknown_placeholder_404():
    r = reveal("<NO_SUCH_TYPE>")
    assert r.status_code == 404
    assert r.json() == {"error": "placeholder_unknown"}


def test_reveal_requires_placeholder():
    r = client.post("/pii/reveal", json={})
    assert r.status_code == 400
    assert r.json() == {"error": "placeholder_required"}


def test_anonymize_response_shape_unchanged():
    """加映射落盘是旁路记录，anonymize 的响应键集一尘不动（票 32 形状锁精神）。"""
    out = anonymize(TEXT)
    assert set(out.keys()) == {"text", "entities"}


def test_store_file_lands_on_configured_path(tmp_path: Path):
    """落盘真相可指认：PII_MAPSTORE_PATH 指哪库就落哪（conftest 已把 env 指到 tmp）。"""
    path = Path(pii_store.default_path())
    assert not path.exists()  # 懒建：没人脱敏就先不开库
    anonymize(TEXT)
    assert path.stat().st_size > 0
