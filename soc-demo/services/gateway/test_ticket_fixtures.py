"""票 02 契约自检：fixtures/tickets/ 的内部一致性（py 签发侧视角）。

验的不是任何实现，是契约数据本身——两端（gateway py 铸票 / agent TS 验票）
落地前，fixture 集必须自洽：签名与测试密钥咬合、字段集照 PRD §5.8/§5.9、
TTL/时钟/探针/期望结果互洽。TS 侧消费同一组数据（票 07）。
"""
import base64
import hashlib
import hmac
import json
from pathlib import Path

ROOT = Path(__file__).parents[2]
FIXTURES = ROOT / "fixtures" / "tickets"

FIVE_CLASSES = {"合法", "过期", "scope不足", "参数篡改", "已焚毁jti"}
TASK_FIELDS = {"jti", "sub", "case_id", "run_id", "scope", "allowed_tools", "iat", "exp"}
APPROVAL_FIELDS = {
    "jti", "approval_id", "approved_by", "tool",
    "params_hash", "case_id", "iat", "exp", "used",
}


def load_contract():
    return json.loads((FIXTURES / "contract.json").read_text(encoding="utf-8"))


def load_fixture(rel):
    return json.loads((FIXTURES / f"{rel}.json").read_text(encoding="utf-8"))


def b64u_decode(seg):
    return base64.urlsafe_b64decode(seg + "=" * (-len(seg) % 4))


def sign(key: bytes, unsigned: str) -> str:
    return hmac.new(key, unsigned.encode(), hashlib.sha256).hexdigest()


def params_hash(params: dict) -> str:
    canon = json.dumps(params, ensure_ascii=False, sort_keys=True,
                       separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canon.encode()).hexdigest()


def split_token(token: str):
    b64h, b64p, sig = token.split(".")
    return b64h, b64p, sig


def case_fixture():
    for case in load_contract()["cases"]:
        yield case, load_fixture(case["fixture"])


def test_contract_references_existing_fixtures():
    contract = load_contract()
    classes = set()
    for case in contract["cases"]:
        path = FIXTURES / f"{case['fixture']}.json"
        assert path.exists(), f"契约表引用了不存在的 fixture: {case['fixture']}"
        fx = load_fixture(case["fixture"])
        assert fx["type"] == case["type"], case["fixture"]
        assert fx["type"] in {"task_ticket", "approval_token"}
        classes.add(case["class"])
        assert fx["class"] == case["class"], case["fixture"]
        assert fx["probe"] == case["probe"], case["fixture"]
        assert fx["expected"] == case["expected"], case["fixture"]
    assert classes == FIVE_CLASSES, f"五类票面不齐: {FIVE_CLASSES - classes}"


def test_payload_fields_match_prd():
    for case, fx in case_fixture():
        payload = fx["payload"]
        if fx["type"] == "task_ticket":
            assert set(payload) == TASK_FIELDS, f"{case['fixture']}: 字段集≠PRD §5.8"
        else:
            assert set(payload) == APPROVAL_FIELDS, f"{case['fixture']}: 字段集≠PRD §5.9"


def test_signature_bites_test_key():
    contract = load_contract()
    key = contract["hmac_key"]["value"].encode()
    for case, fx in case_fixture():
        b64h, b64p, sig = split_token(fx["token"])
        if "signed_payload_b64" in fx:
            # 票体型篡改：sig 只咬原始 payload，不咬被改后的
            orig_unsigned = f"{b64h}.{fx['signed_payload_b64']}"
            assert sign(key, orig_unsigned) == sig, case["fixture"]
            assert b64p != fx["signed_payload_b64"], case["fixture"]
            assert sign(key, f"{b64h}.{b64p}") != sig, case["fixture"]
        else:
            assert sign(key, f"{b64h}.{b64p}") == sig, case["fixture"]
        decoded = json.loads(b64u_decode(b64p))
        assert decoded == fx["payload"], f"{case['fixture']}: payload 解码不符"


def test_ttl_900s_task_300s_approval():
    for case, fx in case_fixture():
        ttl = fx["payload"]["exp"] - fx["payload"]["iat"]
        want = 900 if fx["type"] == "task_ticket" else 300
        assert ttl == want, f"{case['fixture']}: TTL {ttl}≠{want}（决策记录 #3/§5.9）"


def test_frozen_clock_window():
    for case, fx in case_fixture():
        now, iat, exp = (fx["verify_now"], fx["payload"]["iat"],
                         fx["payload"]["exp"])
        if fx["class"] == "过期":
            assert now > exp, f"{case['fixture']}: verify_now 未越过 exp"
        else:
            assert iat < now < exp, f"{case['fixture']}: verify_now 不在票有效窗口内"


def test_probe_against_scope_and_hash():
    for case, fx in case_fixture():
        probe = fx["probe"]
        if fx["type"] == "task_ticket":
            inside = probe["tool"] in fx["payload"]["allowed_tools"]
            if fx["class"] in {"合法", "已焚毁jti"}:
                assert inside, f"{case['fixture']}: 探针工具应在对 scope 集"
            if fx["class"] == "scope不足":
                assert not inside, f"{case['fixture']}: 探针工具应在 scope 外"
        else:
            bound = params_hash(probe["params"]) == fx["payload"]["params_hash"]
            if fx["class"] == "合法":
                assert bound, f"{case['fixture']}: 合法票探针参数应与 hash 咬合"
            if fx["class"] == "参数篡改":
                assert not bound, f"{case['fixture']}: 篡改参数必须偏离 hash"


def test_expected_reasons_legal_and_consistent():
    contract = load_contract()
    legal = set(contract["reasons"])
    for case, fx in case_fixture():
        expected = fx["expected"]
        assert expected["reason"] in legal, f"{case['fixture']}: reason 不在契约枚举"
        assert expected["allow"] == (expected["reason"] == "allow"), case["fixture"]


def test_burned_class_declares_registry_check():
    for case, fx in case_fixture():
        if fx["class"] == "已焚毁jti":
            assert fx["expected"]["reason"] == "token_used", case["fixture"]
            assert fx.get("burn") and fx["burn"]["registry"] == "used_tokens", \
                f"{case['fixture']}: 缺焚毁登记说明（INV-2，查表在 M2 库）"
            assert fx["payload"]["jti"] == fx["burn"]["jti"], case["fixture"]
