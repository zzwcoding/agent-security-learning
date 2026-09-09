"""m9 guards 防护件（票 04）：注入扫描 + PII 脱敏，无状态微服务 :8001。

两条管线都藏在各自模块里（injection_scan / pii），本文件只是契约装配层：
POST /scan/injection  {"text","channel"} → {"is_injection","score","scanner","action",...}
POST /pii/anonymize   {"text","language"} → {"text","entities":[...]}
POST /pii/reveal      {"placeholder"}     → {"placeholder","originals",[...],"count"}
                        （票 49·ADR 0004-3 受控反查口的存储半边；角色闸在 agent 侧，
                        反查是人的动作不是工具调用——agent 端点白名单 duty_lead/admin
                        把关 + INV-8 审计后才转发到这里）
调用方 fail-closed 纪律（INV-1）：服务不可达/超时 2s → 不可信段不进 prompt，
客户端实现在 TS 侧 services/agent/src/guards-client.ts（票 04 一并交付）。
"""
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from injection_scan import scan
from pii import anonymize
from pii_store import get_store

app = FastAPI()


@app.get("/healthz")
def healthz():
    return {"ok": True, "service": "guards"}


@app.post("/scan/injection")
def scan_injection(body: dict):
    return scan(body["text"], body["channel"])


@app.post("/pii/anonymize")
def pii_anonymize(body: dict):
    return anonymize(body["text"], body.get("language", "zh"))


@app.post("/pii/reveal")
def pii_reveal(body: dict):
    placeholder = body.get("placeholder")
    if not isinstance(placeholder, str) or not placeholder.strip():
        return JSONResponse(status_code=400, content={"error": "placeholder_required"})
    placeholder = placeholder.strip()
    originals = get_store().reveal(placeholder)
    if not originals:
        # 查无此人也不透露「库里有没有别的占位符」——404 一视同仁
        return JSONResponse(status_code=404, content={"error": "placeholder_unknown"})
    return {"placeholder": placeholder, "originals": originals, "count": len(originals)}
