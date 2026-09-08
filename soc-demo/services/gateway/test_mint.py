"""票 06 验收测试：POST /internal/mint 签任务票/ApprovalToken + fixtures 契约消费。

对位票面四条验收（.scratch/tickets/issues/06-m9-mint.md）：
1. POST /internal/mint 签任务票/ApprovalToken（m9 卡公开接口·PRD §6-M9）→ test_mint_endpoint_*
2. 票型 HMAC-SHA256 + scope + exp + 任务绑定，TTL 900s（ADR 0001·决策记录 #3）
   → test_task_ticket_ttl_scope_and_bindings / test_tampered_or_malformed_fails_closed
3. py 侧对 fixtures/tickets/ 五类票面契约测试全过（m9 卡 Seam·票 02 产物）
   → test_contract_cases_through_py_verify_path / test_mint_reproduces_fixture_tokens_byte_for_byte
4. ApprovalToken 绑定参数 hash，改参数即失效（PRD FR-S2.2·INV-2）
   → test_approval_params_hash_binding

密钥只从 contract.json 读（fixtures README：不要在代码里复制字符串）；
verify_now 一律显式注入（契约 clock policy：禁 wall clock）。
"""
import mint
from app import app
from fastapi.testclient import TestClient
from test_ticket_fixtures import (
    APPROVAL_FIELDS,
    TASK_FIELDS,
    load_contract,
    load_fixture,
)

KEY = load_contract()["hmac_key"]["value"].encode()  # 测试固定密钥，仅限测试
client = TestClient(app)


# ---------- 验收 1：POST /internal/mint 签两种票 ----------

def test_mint_endpoint_issues_task_ticket(monkeypatch):
    monkeypatch.setenv("SOC_HMAC_KEY", KEY.decode())
    r = client.post("/internal/mint", json={
        "type": "task_ticket", "jti": "tk_06TEST0001", "sub": "agent:triage",
        "case_id": "case_000012", "run_id": "run_06TEST0001",
        "scope": ["case:write"], "allowed_tools": ["create_case"],
    })
    assert r.status_code == 200, r.text
    out = r.json()
    payload = out["payload"]
    assert payload["exp"] - payload["iat"] == 900  # 决策记录 #3：统一 900s
    assert set(payload) == TASK_FIELDS  # PRD §5.8 字段集一字不增不减
    assert len(out["token"].split(".")[2]) == 64  # 第三段 hex(hmac-sha256)，非 JWT 标准 b64 段
    # 签出的票能走自己的验签路径圆 trip：scope 内工具放行
    got = mint.verify(KEY, out["token"], tool="create_case", now=payload["iat"] + 1)
    assert got["allow"] is True and got["reason"] == "allow"


def test_mint_endpoint_issues_approval_token(monkeypatch):
    monkeypatch.setenv("SOC_HMAC_KEY", KEY.decode())
    r = client.post("/internal/mint", json={
        "type": "approval_token", "jti": "ap_06TEST0001",
        "approval_id": "apr_06TEST0001", "approved_by": "duty_lead",
        "tool": "isolate_host", "params": {"host": "web-01"},
        "case_id": "case_000012",
    })
    assert r.status_code == 200, r.text
    payload = r.json()["payload"]
    assert payload["exp"] - payload["iat"] == 300  # PRD §5.9：更短，默认 300s
    assert set(payload) == APPROVAL_FIELDS  # PRD §5.9 字段集一字不增不减
    assert payload["used"] is False  # 一次性铸票侧形态（焚毁登记在 M2，INV-2）
    assert payload["params_hash"] == mint.params_hash({"host": "web-01"})


def test_mint_endpoint_fail_closed(monkeypatch):
    # 密钥缺失拒绝铸票（fail-closed，INV-1）；票型未知 / 缺字段 400
    monkeypatch.delenv("SOC_HMAC_KEY", raising=False)
    assert client.post(
        "/internal/mint", json={"type": "task_ticket"}).status_code == 500
    monkeypatch.setenv("SOC_HMAC_KEY", KEY.decode())
    assert client.post(
        "/internal/mint", json={"type": "nope"}).status_code == 400
    assert client.post(
        "/internal/mint", json={"type": "task_ticket"}).status_code == 400


# ---------- 验收 2：票型 HMAC-SHA256 + scope + exp + 任务绑定，TTL 900s ----------

def test_task_ticket_ttl_scope_and_bindings():
    token, payload = mint.mint_task_ticket(
        KEY, jti="tk_06TEST0002", sub="agent:triage", case_id="case_000012",
        run_id="run_06TEST0002", scope=["case:write"],
        allowed_tools=["create_case"], iat=1757000000)  # 冻结 iat：确定性
    assert set(payload) == TASK_FIELDS
    assert payload["exp"] - payload["iat"] == 900
    now = payload["iat"] + 1
    # 任务绑定生效：scope 内 allow；scope 外（L2 工具任何票都没有，INV-3）403
    assert mint.verify(KEY, token, tool="create_case", now=now)["allow"] is True
    got = mint.verify(KEY, token, tool="isolate_host", now=now)
    assert got == {"allow": False, "reason": "scope_insufficient"}
    # 时效生效：verify_now 越过 exp（注入时钟，非 wall clock）→ 403
    got = mint.verify(KEY, token, tool="create_case", now=payload["exp"] + 1)
    assert got == {"allow": False, "reason": "token_expired"}


def test_tampered_or_malformed_fails_closed():
    token, payload = mint.mint_task_ticket(
        KEY, jti="tk_06TEST0003", sub="agent:triage", case_id="case_000012",
        run_id="run_06TEST0003", scope=["case:write"],
        allowed_tools=["create_case"], iat=1757000000)
    b64h, b64p, sig = token.split(".")
    bad_p = b64p[:-4] + ("AAAA" if b64p[-4:] != "AAAA" else "BBBB")
    # 票体改一字节不重签 → 签名不符（fail-closed 第一关，契约扩展 reason）
    got = mint.verify(KEY, f"{b64h}.{bad_p}.{sig}", tool="create_case",
                      now=payload["iat"] + 1)
    assert got == {"allow": False, "reason": "signature_invalid"}
    got = mint.verify(KEY, "not-a-token", tool="create_case",
                      now=payload["iat"] + 1)
    assert got == {"allow": False, "reason": "signature_invalid"}


# ---------- 验收 3：fixtures/tickets/ 五类票面契约测试全过 ----------

def test_contract_cases_through_py_verify_path():
    """票 02 契约的 py 侧消费：九张 fixture 跑自己的解码/验签路径断言 expected。

    焚毁现场照 fixture 的 burn 登记造（验票前先把 jti 入 used 集再验，重放现场）；
    now 用 fixture 的 verify_now 注入，绝不读 wall clock。
    """
    for case in load_contract()["cases"]:
        fx = load_fixture(case["fixture"])
        used = {fx["burn"]["jti"]} if "burn" in fx else frozenset()
        out = mint.verify(KEY, fx["token"], tool=fx["probe"]["tool"],
                          now=fx["verify_now"], params=fx["probe"]["params"],
                          used=used)
        assert out["allow"] == fx["expected"]["allow"], case["fixture"]
        assert out["reason"] == fx["expected"]["reason"], case["fixture"]


def test_mint_reproduces_fixture_tokens_byte_for_byte():
    """签发确定性（fixtures README 建议）：冻结 iat + fixture claims + 测试密钥，
    铸票输出必须与 fixture token 逐字节一致——py 铸票侧与契约同源的铁证。"""
    p = load_fixture("task-ticket/valid")["payload"]
    token, _ = mint.mint_task_ticket(
        KEY, jti=p["jti"], sub=p["sub"], case_id=p["case_id"],
        run_id=p["run_id"], scope=p["scope"], allowed_tools=p["allowed_tools"],
        iat=p["iat"])
    assert token == load_fixture("task-ticket/valid")["token"]
    fx = load_fixture("approval-token/valid")
    p = fx["payload"]
    token, _ = mint.mint_approval_token(
        KEY, jti=p["jti"], approval_id=p["approval_id"],
        approved_by=p["approved_by"], tool=p["tool"],
        params=fx["probe"]["params"], case_id=p["case_id"], iat=p["iat"])
    assert token == fx["token"]


# ---------- 验收 4：ApprovalToken 绑定参数 hash，改参数即失效 ----------

def test_approval_params_hash_binding():
    token, payload = mint.mint_approval_token(
        KEY, jti="ap_06TEST0002", approval_id="apr_06TEST0002",
        approved_by="duty_lead", tool="isolate_host",
        params={"host": "web-01", "reason": "bruteforce"},
        case_id="case_000012", iat=1757000000)
    now = payload["iat"] + 1
    # 原参数放行——键序无关（sort_keys 规范化），跨语言逐字节一致的前提
    reordered = {"reason": "bruteforce", "host": "web-01"}
    assert payload["params_hash"] == mint.params_hash(reordered)
    got = mint.verify(KEY, token, tool="isolate_host", now=now, params=reordered)
    assert got["allow"] is True
    # INV-2：改参数即失效——hash 咬死，换主机直接 params_mismatch
    got = mint.verify(KEY, token, tool="isolate_host", now=now,
                      params={"host": "web-02", "reason": "bruteforce"})
    assert got == {"allow": False, "reason": "params_mismatch"}
    # 带外耍赖不带参数也过不去
    got = mint.verify(KEY, token, tool="isolate_host", now=now)
    assert got == {"allow": False, "reason": "params_mismatch"}
