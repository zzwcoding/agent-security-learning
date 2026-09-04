from fastapi import FastAPI

# 阶段 0.2 骨架：本服务是 RBAC 工具可见性 + FGA 裁决 + 铸币（票签）的网关。
# 注意：这是占位实现——最终形态（ContextForge 镜像复用 vs 自写薄层）等
# docs/adr/0001-c5-reuse.md（阶段 0.4 spike）拍板后替换。
app = FastAPI()


@app.get("/healthz")
def healthz():
    return {"ok": True, "service": "gateway"}
