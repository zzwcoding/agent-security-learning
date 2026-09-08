"""m9 gateway 自写件容器（:8002）的薄装配层：端点挂这里，逻辑在各自模块里。

m9 卡公开接口的 gateway 两条：POST /internal/mint（票 06，铸票逻辑在 mint.py）与
/proxy/llm/*（票 08，凭证代理逻辑在 proxy.py）；生产验票闸在 TS 侧 agent（票 07）。
密钥从 env 注入（教学版 HMAC 自签 + SECRETS_* 凭证真值仓，蓝图注释 STS/Keycloak
演进，ADR 0001「搬票型不搬代码」）；env 缺失一律拒绝服务——铸不出签名的票、换不
出真 key 的代理，等于没有这块能力，宁可拒绝也不裸转发（fail-closed，INV-1）。
"""
import os

import mint
from fastapi import FastAPI, HTTPException
from proxy import router as proxy_router

app = FastAPI()
app.include_router(proxy_router, prefix="/proxy/llm")  # 凭证代理：LLM base_url 指这里


@app.get("/healthz")
def healthz():
    return {"ok": True, "service": "gateway"}


@app.post("/internal/mint")
def mint_token(body: dict):
    """签任务票（§5.8）/ ApprovalToken（§5.9）→ {token, payload}。

    internal 端：只该被 agent 服务（审批回路 FR-S2.4 / worker 拉起 FR-M3.4）
    调，不暴露给 Web；票面字段缺失/票型未知 400。
    """
    key = os.environ.get("SOC_HMAC_KEY", "").encode()
    if not key:
        raise HTTPException(500, "SOC_HMAC_KEY not set; refuse to mint (fail-closed)")
    try:
        if body["type"] == "task_ticket":
            token, payload = mint.mint_task_ticket(
                key, jti=body["jti"], sub=body["sub"], case_id=body["case_id"],
                run_id=body["run_id"], scope=body["scope"],
                allowed_tools=body["allowed_tools"])
        elif body["type"] == "approval_token":
            token, payload = mint.mint_approval_token(
                key, jti=body["jti"], approval_id=body["approval_id"],
                approved_by=body["approved_by"], tool=body["tool"],
                params=body["params"], case_id=body["case_id"])
        else:
            raise HTTPException(400, f"unknown mint type: {body['type']!r}")
    except KeyError as miss:
        raise HTTPException(400, f"missing field: {miss.args[0]}") from miss
    return {"token": token, "payload": payload}
