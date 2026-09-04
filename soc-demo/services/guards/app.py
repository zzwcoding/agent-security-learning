from fastapi import FastAPI

# 阶段 0.2 骨架：本服务是 llm-guard 注入扫描 + Presidio PII 脱敏微服务，
# 现在只有健康检查。两条管线从 M9-S3/S4 开始长出来（复用路线 1-3 的 Python 管线）。
app = FastAPI()


@app.get("/healthz")
def healthz():
    return {"ok": True, "service": "guards"}
