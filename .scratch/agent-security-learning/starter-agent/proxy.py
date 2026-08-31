"""凭证代理(阶段 26,LLM 路):Agent 的 base_url 指向这里,真 key 只活在代理进程。

它做的事一句话:收到 Agent 的 OpenAI 兼容请求,把 Authorization 换成真 MiniMax
key,原样转发、原样回传(SSE 流式也透传)。Agent 从头到尾只握着 PLACEHOLDER
占位符——就算被注入劫持、把进程环境整个 dump,也找不到真 key。

纪律:日志只记 方法/路径/上游状态码/耗时,绝不记请求体明文(对话内容和密钥
都不落盘;观测侧的密钥打码由 Langfuse mask 负责,这里是打码之前的第二道)。
"""
import os
import time

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

UPSTREAM = "https://api.minimaxi.com"  # 转发时拼 /v1/...,Agent 侧 base_url 的 /v1 原样保留

app = FastAPI(title="credential-proxy")

# 真 key 只从环境变量来(由 scripts/run-proxy.sh 从 Keychain 注入);没有就拒绝启动——
# 没钥匙的代理空转着,比直接失败更危险(fail fast)
_API_KEY = os.environ.get("MINIMAX_API_KEY", "")
if not _API_KEY:
    raise SystemExit("缺少 MINIMAX_API_KEY:请用 scripts/run-proxy.sh 启动代理")

# 连接池复用:不为每个请求重建 TCP/TLS;超时给足,长对话补全可以很慢
_client = httpx.AsyncClient(base_url=UPSTREAM, timeout=httpx.Timeout(120.0))

# 逐跳头不透传(host/content-length 由 httpx 重算,authorization 由我们注入)
_HOP_HEADERS = {"host", "content-length", "connection", "authorization", "accept-encoding"}


@app.get("/healthz")
async def healthz():
    """就绪探针,给人和启动脚本看;不暴露上游信息。"""
    return {"ok": True}


@app.api_route("/{path:path}", methods=["GET", "POST"])
async def forward(request: Request, path: str):
    started = time.monotonic()
    body = await request.body()
    headers = {k: v for k, v in request.headers.items() if k.lower() not in _HOP_HEADERS}
    headers["authorization"] = f"Bearer {_API_KEY}"  # ★唯一注入点:占位符在这里换真 key

    upstream_req = _client.build_request(
        request.method, f"/{path}", params=request.query_params, content=body, headers=headers
    )
    upstream_resp = await _client.send(upstream_req, stream=True)

    # 流式(SSE)与非流式统一用 aiter_bytes 透传:字节过代理前先解压(阶段 31 攻击
    # 会话实测抓出——aiter_raw 会把上游 gzip 原样转发,而 Content-Encoding 头没跟着
    # 透传,客户端拿着压缩字节当 JSON 解,非流式补全当场 UnicodeDecodeError)。
    # 不解析不缓存,token 级流式体验不变;退出时必须关上游连接
    async def relay():
        size = 0
        try:
            async for chunk in upstream_resp.aiter_bytes():
                size += len(chunk)
                yield chunk
        finally:
            await upstream_resp.aclose()
            took = time.monotonic() - started
            # 只记元数据,不记 body——这行日志永远不包含对话内容
            print(f"→ {request.method} /{path} ← {upstream_resp.status_code} {took:.2f}s {size}B", flush=True)

    return StreamingResponse(
        relay(),
        status_code=upstream_resp.status_code,
        media_type=upstream_resp.headers.get("content-type"),
        background=BackgroundTask(lambda: None),
    )
