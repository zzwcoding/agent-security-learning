"""m9 guards 防护件（票 04）：注入扫描 + PII 脱敏，无状态微服务 :8001。

两条管线都藏在各自模块里（injection_scan / pii），本文件只是契约装配层：
POST /scan/injection  {"text","channel"} → {"is_injection","score","scanner","action",...}
POST /pii/anonymize   {"text","language"} → {"text","entities":[...]}
调用方 fail-closed 纪律（INV-1）：服务不可达/超时 2s → 不可信段不进 prompt，
客户端实现在 TS 侧 services/agent/src/guards-client.ts（票 04 一并交付）。
"""
from fastapi import FastAPI
from injection_scan import scan
from pii import anonymize

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
