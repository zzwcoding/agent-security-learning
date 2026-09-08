"""m9 凭证代理（票 08，S1）：LLM base_url 指向 /proxy/llm/*，真凭证只活在网关进程。

参数化搬自路线 3 攻击实测件 starter-agent/proxy.py（74 行，ADR 0001「直接搬」）：
UPSTREAM 与密钥 env 名参数化。三条纪律在代码里的落点：
- FR-S1.1 占位符契约：工具定义/prompt 里凭证位写 ${{ SECRETS.x.KEY }}，模型上下文
  只见占位符原文——白名单字段之外的占位符原样透传，永不替换（inject_credentials）。
- FR-S1.2 执行层注入：验票通过后（闸在 agent TS 侧，票 07），出站前只在白名单字段
  把占位符换成 SECRETS_* env 真值；provider 真 key 注入 Authorization（参考件的
  ★唯一注入点）。
- INV-1/INV-4 fail-closed + 金丝雀：占位符查不到对应 env / env 缺失 / 模型可见字段
  检出真值（泄露检测）→ 一律拒绝转发 + 审计，上游一个字节都不发。真凭证只存在于
  网关 env 与出站注入瞬间，绝不进模型上下文/日志/审计/响应。

转发纪律照参考件：日志只记 方法/路径/上游状态码/耗时/字节数，绝不记请求体明文。
"""
import copy
import json
import os
import re
import time

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

UPSTREAM_ENV = "SOC_LLM_UPSTREAM"  # 转发上游（LLM provider base_url），ADR 0001 参数化
PROXY_KEY_ENV = "SECRETS_LLM_API_KEY"  # provider 真 key 的 env 名（SECRETS_* 真值仓）

# 占位符语法照 PRD FR-S1.1：${{ SECRETS.<ns>.<key> }}；SECRETS 后至少一段点分名
PLACEHOLDER_RE = re.compile(r"\$\{\{\s*SECRETS\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\s*\}\}")

# 白名单字段（PRD S1 实现机制「占位符扫描替换在白名单字段上进行」）：出站请求体里
# 允许被注入真值的位置。替换是发秘钥的特权操作，只发给「声明的收件人」——messages
# 等 LLM 可见字段永不在列（FR-S1.1），这就是白名单存在的理由。
CREDENTIAL_BODY_FIELDS = ("metadata",)

router = APIRouter()

_client: httpx.AsyncClient | None = None


class MissingCredential(Exception):
    """占位符在 SECRETS_* env 里找不到对应真值（异常里只带占位符名，不带值）。"""


def env_name(placeholder_body: str) -> str:
    """${{ SECRETS.vt.KEY }} 的点名 → env 名 SECRETS_VT_KEY（点换下划线全大写）。"""
    return "SECRETS_" + placeholder_body.replace(".", "_").upper()


def _sub_placeholders(text: str) -> str:
    def repl(match):
        env = env_name(match.group(1))
        value = os.environ.get(env)
        if not value:
            raise MissingCredential(match.group(0))
        return value

    return PLACEHOLDER_RE.sub(repl, text)


def _inject_node(node):
    if isinstance(node, str):
        return _sub_placeholders(node)
    if isinstance(node, list):
        return [_inject_node(x) for x in node]
    if isinstance(node, dict):
        return {k: _inject_node(v) for k, v in node.items()}
    return node


def inject_credentials(body: dict, field_whitelist=CREDENTIAL_BODY_FIELDS) -> dict:
    """PRD 接口契约 injectCredentials(outboundRequest, toolManifest) 的教学版。

    深拷贝出站体，只在白名单字段里做 占位符 → SECRETS_* env 真值 替换；
    白名单外一字不动（FR-S1.1）。占位符无对应凭证抛 MissingCredential，
    由端点统一 fail-closed（INV-1），绝不带半替换的体出站。
    """
    out = copy.deepcopy(body)
    for field in field_whitelist:
        if field in out:
            out[field] = _inject_node(out[field])
    return out


def scan_leak(body: dict, field_whitelist=CREDENTIAL_BODY_FIELDS):
    """泄露检测（PRD S1 接口契约「SECRETS_ 值出现即告警」的运行时闸，INV-4）。

    扫白名单外（模型可见）字段：任何 SECRETS_* env 真值出现即返回字段路径。
    白名单字段不算泄露——那是「声明的收件人」，注入进去的真值是合法出站。
    教学版按 ≥8 字符的值参与扫描，防平凡值（如单字符）误报 fail-closed 全体。
    """
    secrets = [v for k, v in os.environ.items()
               if k.startswith("SECRETS_") and len(v) >= 8]
    if not secrets:
        return None

    def walk(node, path):
        if isinstance(node, str):
            for s in secrets:
                if s in node:
                    return path
        elif isinstance(node, list):
            for i, x in enumerate(node):
                hit = walk(x, f"{path}[{i}]")
                if hit:
                    return hit
        elif isinstance(node, dict):
            for k, v in node.items():
                hit = walk(v, f"{path}.{k}")
                if hit:
                    return hit
        return None

    for k, v in body.items():
        if k in field_whitelist:
            continue
        hit = walk(v, k)
        if hit:
            return hit
    return None


def audit(action: str, *, actor: str, request_id: str, result: str, detail: str) -> None:
    """审计缝（INV-8 五要素 + request_id 关联）：凭证代理的每次注入/拒绝都留痕。

    教学版落 stdout JSON 行（compose logs 可查可 grep）；生产接线由调用方落
    M2 AuditEntry（票 10+）。铁律（FR-S1.3/INV-4）：只记占位符名与元数据，
    绝不记请求体、绝不记凭证值。
    """
    print(json.dumps(
        {"action": action, "actor": actor, "object": "gateway/proxy",
         "result": result, "request_id": request_id, "detail": detail,
         "ts": int(time.time())}, ensure_ascii=False), flush=True)


def _get_client() -> httpx.AsyncClient:
    """出站 seam：连接池惰性建一次（不为每个请求重建 TCP/TLS）。测试在缝上换
    httpx.MockTransport 替身（monkeypatch proxy._client），绝不真出网。"""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(base_url=os.environ[UPSTREAM_ENV],
                                    timeout=httpx.Timeout(120.0))
    return _client


# 逐跳头不透传：host/content-length 由 httpx 重算，authorization 由我们注入
_HOP_HEADERS = {"host", "content-length", "connection", "authorization",
                "accept-encoding", "transfer-encoding", "keep-alive"}


@router.api_route("/{path:path}", methods=["GET", "POST"])
async def forward(request: Request, path: str):
    """验票通过后的出站口：白名单注入 → 金丝雀扫描 → 转发 → 原样回传（SSE 透传）。

    INV-1 裁决顺序（fail-closed，与验票闸同精神：最致命的先问）：
    env 缺失 → 占位符无凭证 → 泄露命中 → 上游不可达，任一步不过立即拒绝，
    上游一个字节都不发。
    """
    actor = request.headers.get("x-actor-id", "agent")
    rid = request.headers.get("x-request-id", "-")
    started = time.monotonic()

    key = os.environ.get(PROXY_KEY_ENV, "")
    if not key or not os.environ.get(UPSTREAM_ENV, ""):
        audit("proxy.deny_no_secret", actor=actor, request_id=rid, result="deny",
              detail=f"{PROXY_KEY_ENV}/{UPSTREAM_ENV} unset; refuse to forward")
        return JSONResponse(
            {"error": "credential proxy not configured; refuse to forward (fail-closed)"},
            status_code=503)

    raw = await request.body()
    try:
        body_obj = json.loads(raw)
    except ValueError:
        body_obj = None  # 非 JSON 体（含空体）：没有可扫的占位符，原样转发
    if isinstance(body_obj, dict):
        try:
            outbound = inject_credentials(body_obj)
        except MissingCredential as miss:
            audit("proxy.deny_missing_credential", actor=actor, request_id=rid,
                  result="deny", detail=f"missing={miss.args[0]}; fail-closed")
            return JSONResponse(
                {"error": f"missing credential for {miss.args[0]}; fail-closed"},
                status_code=503)
        leak = scan_leak(outbound)
        if leak:
            audit("proxy.deny_leak_detected", actor=actor, request_id=rid,
                  result="deny", detail=f"secret value at .{leak}; refuse to forward")
            return JSONResponse(
                {"error": f"credential leak detected at .{leak}; refuse (fail-closed)"},
                status_code=503)
        raw = json.dumps(outbound, ensure_ascii=False).encode()

    headers = {k: v for k, v in request.headers.items() if k.lower() not in _HOP_HEADERS}
    headers["authorization"] = f"Bearer {key}"  # ★唯一注入点：占位符在这里换真 key
    req = _get_client().build_request(
        request.method, f"/{path}", params=request.query_params,
        content=raw, headers=headers)
    try:
        upstream_resp = await _get_client().send(req, stream=True)
    except httpx.HTTPError:
        audit("proxy.deny_upstream_error", actor=actor, request_id=rid, result="deny",
              detail=f"{request.method} /{path} unreachable; fail-closed")
        return JSONResponse({"error": "upstream unreachable; fail-closed"},
                            status_code=502)

    # 流式与非流式统一 aiter_bytes 透传（参考件阶段 31 实测：aiter_raw 会把上游
    # gzip 原样转发而 Content-Encoding 头没跟上，客户端拿压缩字节当 JSON 解）；
    # 不解析不缓存，token 级流式体验不变；退出必须关上游连接。
    async def relay():
        size = 0
        try:
            async for chunk in upstream_resp.aiter_bytes():
                size += len(chunk)
                yield chunk
        finally:
            await upstream_resp.aclose()
            # 只记元数据不记 body——这行日志/审计永远不含对话内容与凭证（FR-S1.3）
            audit("proxy.forward", actor=actor, request_id=rid, result="allow",
                  detail=f"{request.method} /{path} upstream={upstream_resp.status_code}"
                         f" bytes={size} took={time.monotonic() - started:.2f}s")

    return StreamingResponse(
        relay(), status_code=upstream_resp.status_code,
        media_type=upstream_resp.headers.get("content-type"))
