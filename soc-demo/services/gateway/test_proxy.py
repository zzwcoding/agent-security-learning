"""票 08 验收测试：/proxy/llm/* 凭证代理（S1）——占位符注入 / 金丝雀断言 / fail-closed。

对位票面四条验收（.scratch/tickets/issues/08-m9-credential-proxy.md）：
1. 占位符 ${{ SECRETS.x.KEY }} 在出站白名单字段替换真值（PRD FR-S1.2·m9 卡公开接口）
   → test_placeholder_substituted_in_whitelisted_field_only
2. 金丝雀凭证全链路 grep 不到真值（m9 卡测试计划·INV-4）
   → test_canary_greps_clean_on_every_observable_surface
   （prompt 装配/工具调用/M2 审计表等面随票 10-19 落地后由 evals 全链路复跑同一断言；
     本票先锁住此刻已存在的面：响应体/错误消息/审计行/转发日志）
3. 占位符无对应凭证 → 执行失败 fail-closed + 审计（PRD S1 异常与边界）
   → test_missing_credential_fail_closed_and_audited
   → test_secret_value_in_model_context_denied（泄露检测：金丝雀命中即拒）
   → test_proxy_env_missing_fail_closed（INV-1：代理自己病了也一律拒）
4. 与铸币件合成 compose 服务 gateway（modules.md §2 三容器并排·自写件不动镜像内部）
   → test_gateway_selfbuilt_image_carries_mint_and_proxy

测试纪律：出站 seam 打在 proxy._client（httpx.MockTransport 捕获转发请求，绝不真出网）；
金丝雀一律用假凭证值——除「出站请求体那一瞬」外，任何可观测面 grep 都必须干净。
"""
import json
from pathlib import Path

import httpx
import proxy
import pytest
from app import app
from fastapi.testclient import TestClient

client = TestClient(app)

# 假凭证值（金丝雀）：只在测试进程 env 里活一瞬间，全链路任何面都不许再见到它
CANARY_VT = "canary-vt-key-0837-never-a-real-secret"
CANARY_LLM = "canary-llm-key-0842-never-a-real-secret"
PLACEHOLDER = "${{ SECRETS.vt.KEY }}"


@pytest.fixture()
def stub_upstream(monkeypatch):
    """出站 seam：捕获转发到上游的请求（方法/URL/头/体），返回固定回执、不回显请求体。"""
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append({
            "method": request.method,
            "url": str(request.url),
            "authorization": request.headers.get("authorization", ""),
            "body": request.read().decode("utf-8", errors="replace"),
        })
        return httpx.Response(200, json={"ok": True, "id": "cmpl-stub-0001"})

    monkeypatch.setattr(proxy, "_client", httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://stub-upstream"))
    monkeypatch.setenv("SOC_LLM_UPSTREAM", "http://stub-upstream")
    monkeypatch.setenv("SECRETS_LLM_API_KEY", CANARY_LLM)
    return seen


# ---------- 验收 1：占位符在出站白名单字段替换真值（FR-S1.2） ----------

def test_placeholder_substituted_in_whitelisted_field_only(monkeypatch, stub_upstream):
    monkeypatch.setenv("SECRETS_VT_KEY", CANARY_VT)
    r = client.post(
        "/proxy/llm/v1/chat/completions",
        headers={"authorization": "Bearer PLACEHOLDER", "x-request-id": "req-08-0001"},
        json={
            "model": "minimax-m2",
            "messages": [{"role": "user", "content": f"用 {PLACEHOLDER} 查 hash 44d88612"}],
            "metadata": {"tool_cred": PLACEHOLDER},
        },
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "id": "cmpl-stub-0001"}  # 上游回执原样回传
    assert len(stub_upstream) == 1
    sent = stub_upstream[0]
    body = json.loads(sent["body"])
    # 白名单字段（metadata）：占位符 → 真值（FR-S1.2 注入发生在这里）
    assert body["metadata"]["tool_cred"] == CANARY_VT
    # 白名单外（messages，模型可见）：占位符按原文透传——模型只见占位符（FR-S1.1）
    assert body["messages"][0]["content"] == f"用 {PLACEHOLDER} 查 hash 44d88612"
    # 参考件★唯一注入点：provider 真 key 进 Authorization，调用方手里的占位符不透传
    assert sent["authorization"] == f"Bearer {CANARY_LLM}"


def test_get_passes_through_catch_all(monkeypatch, stub_upstream):
    """转发本体：catch-all 任意路径/方法原样拼到上游（LLM base_url 指 /proxy/llm 的前提）。"""
    r = client.get("/proxy/llm/v1/models")
    assert r.status_code == 200, r.text
    assert stub_upstream[0]["method"] == "GET"
    assert stub_upstream[0]["url"].endswith("/v1/models")


# ---------- 验收 2：金丝雀全链路 grep 不到真值（INV-4） ----------

def test_canary_greps_clean_on_every_observable_surface(monkeypatch, stub_upstream, capsys):
    """INV-4：除「出站请求体那一瞬」外，响应/错误消息/审计行/日志 grep 不到金丝雀。"""
    monkeypatch.setenv("SECRETS_VT_KEY", CANARY_VT)

    # ① 正常转发（占位符注入）
    ok = client.post(
        "/proxy/llm/v1/chat/completions",
        headers={"x-request-id": "req-08-canary"},
        json={"model": "m", "messages": [{"role": "user", "content": PLACEHOLDER}],
              "metadata": {"cred": PLACEHOLDER}})
    assert ok.status_code == 200
    # ② 无对应凭证的占位符（fail-closed，见验收 3）
    miss = client.post(
        "/proxy/llm/v1/chat/completions",
        json={"model": "m", "messages": [],
              "metadata": {"cred": "${{ SECRETS.ghost.KEY }}"}})
    assert miss.status_code == 503
    # ③ 真值意外出现在模型可见字段（泄露检测命中）
    leak = client.post(
        "/proxy/llm/v1/chat/completions",
        json={"model": "m", "messages": [{"role": "user", "content": CANARY_VT}]})
    assert leak.status_code == 503

    # 金丝雀活着（防假绿）：唯一允许的面——出站那一瞬——必须真有它，且只有这一次
    assert CANARY_VT in stub_upstream[0]["body"]
    assert stub_upstream[0]["authorization"] == f"Bearer {CANARY_LLM}"
    assert len(stub_upstream) == 1  # ②③ 都在出站之前被拦下

    # 其余一切可观测面逐个 grep：响应体（成功+两种错误）、审计行+转发日志（stdout）
    surfaces = {
        "成功响应体": ok.text,
        "缺凭证错误消息": miss.text,
        "泄露错误消息": leak.text,
        "审计与日志(stdout)": capsys.readouterr().out,
    }
    for name, text in surfaces.items():
        assert CANARY_VT not in text, f"金丝雀泄露在 {name}"
        assert CANARY_LLM not in text, f"金丝雀泄露在 {name}"
    # 占位符原文不设密：报的是名字不是值（FR-S1.3「审计记 hash 不记原文」的同族纪律）
    assert "SECRETS.ghost.KEY" in miss.text


# ---------- 验收 3：无对应凭证 / 泄露命中 / env 缺失 → fail-closed + 审计 ----------

def test_missing_credential_fail_closed_and_audited(monkeypatch, stub_upstream, capsys):
    monkeypatch.setenv("SECRETS_VT_KEY", CANARY_VT)  # 有别的凭证，唯独缺 ghost
    r = client.post(
        "/proxy/llm/v1/chat/completions",
        headers={"x-actor-id": "agent:triage", "x-request-id": "req-08-0003"},
        json={"model": "m", "metadata": {"cred": "${{ SECRETS.ghost.KEY }}"}})
    assert r.status_code == 503
    assert stub_upstream == []  # fail-closed：上游一个字节都没发出去
    assert "SECRETS.ghost.KEY" in r.json()["error"]  # 报占位符名，不报值（也没值可报）
    lines = [json.loads(x) for x in capsys.readouterr().out.splitlines()
             if x.startswith("{")]
    deny = [e for e in lines if e["action"] == "proxy.deny_missing_credential"]
    assert deny, lines
    assert deny[0]["result"] == "deny"
    assert deny[0]["actor"] == "agent:triage"  # 五要素：actor
    assert deny[0]["request_id"] == "req-08-0003"  # 与调用链关联
    assert CANARY_VT not in json.dumps(deny)  # 审计永不记凭证值（FR-S1.3）


def test_secret_value_in_model_context_denied(monkeypatch, stub_upstream):
    """PRD 接口契约「凭证泄露检测」：模型可见字段检出 SECRETS_ 真值 → 拒绝 + 审计。
    （金丝雀命中 → run 终止的执行侧是 agent，代理侧先把这一发出站拦死。）"""
    monkeypatch.setenv("SECRETS_VT_KEY", CANARY_VT)
    r = client.post(
        "/proxy/llm/v1/chat/completions",
        json={"model": "m",
              "messages": [{"role": "user", "content": f"key={CANARY_VT}"}]})
    assert r.status_code == 503
    assert stub_upstream == []
    assert CANARY_VT not in r.text  # 拒绝消息里也不回显真值


def test_proxy_env_missing_fail_closed(monkeypatch, stub_upstream):
    """INV-1：密钥 env / 上游 env 任一缺失 → 拒绝转发（跟 /internal/mint 缺密钥同口径）。"""
    monkeypatch.delenv("SECRETS_LLM_API_KEY")
    r = client.post("/proxy/llm/v1/chat/completions", json={"model": "m"})
    assert r.status_code == 503
    assert stub_upstream == []
    monkeypatch.setenv("SECRETS_LLM_API_KEY", CANARY_LLM)
    monkeypatch.delenv("SOC_LLM_UPSTREAM")
    r = client.post("/proxy/llm/v1/chat/completions", json={"model": "m"})
    assert r.status_code == 503
    assert stub_upstream == []


# ---------- 验收 4：与铸币件合成 compose 服务 gateway（自写件） ----------

def test_gateway_selfbuilt_image_carries_mint_and_proxy():
    """自写件镜像带全三块（薄装配+铸票+凭证代理）；compose 给 gateway 挂 SECRETS_* 真值仓。

    compose 配置语法门禁在 CI compose-config job（docker compose config -q），
    这里锁的是「自写件不缺文件、真值仓 env 不断线」两处最容易漏的接线。
    """
    dockerfile = (Path(__file__).parent / "Dockerfile").read_text(encoding="utf-8")
    copy_lines = [line for line in dockerfile.splitlines()
                  if line.startswith("COPY") and "requirements.txt" not in line]
    assert any(all(m in line for m in ("app.py", "mint.py", "proxy.py"))
               for line in copy_lines), copy_lines
    compose = (Path(__file__).parents[2] / "docker-compose.yml").read_text(encoding="utf-8")
    assert "SECRETS_LLM_API_KEY" in compose  # provider 真 key（pass-through 注入）
    assert "SECRETS_VT_KEY" in compose  # 工具凭证真值仓（教学假值）
    assert "SOC_LLM_UPSTREAM" in compose  # 参数化的转发上游（ADR 0001「UPSTREAM 参数化」）
