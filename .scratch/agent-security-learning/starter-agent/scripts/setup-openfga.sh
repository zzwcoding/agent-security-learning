#!/usr/bin/env bash
# 阶段 37:OpenFGA 一键部署 + 授权建模 + 矩阵 tuples + 演示 check(幂等,重跑即重建)。
# 取舍:内存存储(容器一停全没)——教学够用,重跑本脚本 30 秒恢复整个授权世界;
# Playground 挪到 3001(Langfuse 占着 3000)。
set -euo pipefail
cd "$(dirname "$0")/.."

docker rm -f openfga >/dev/null 2>&1 || true
docker run -d --name openfga -p 8080:8080 -p 3001:3000 openfga/openfga run >/dev/null

for _ in $(seq 1 30); do
  curl -sf http://127.0.0.1:8080/healthz >/dev/null 2>&1 && break
  sleep 1
done
curl -sf http://127.0.0.1:8080/healthz >/dev/null || { echo "OpenFGA 未就绪"; exit 1; }

API=http://127.0.0.1:8080
python3 - "$API" <<'PYEOF'
import json, sys, urllib.request

api = sys.argv[1]

def call(method, path, body=None):
    req = urllib.request.Request(
        api + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code} {path}: {e.read().decode()[:400]}", file=sys.stderr)
        raise

# ── 1. 建 store(一个 store = 一个授权世界)────────────────────────
store = call("POST", "/stores", {"name": "agent-security-route3"})["id"]
print(f"store_id  = {store}")

# ── 2. 授权模型:人×Agent×工具×资源,三元组级联表达四元组 ──────────
# DSL 原文见 issues/11-route3-execution/authz-model.md;这里是与 API 对应的 JSON
model = {
    "schema_version": "1.1",
    "type_definitions": [
        {"type": "user"},
        {"type": "agent",
         "relations": {"admin": {"this": {}}},
         "metadata": {"relations": {"admin": {"directly_related_user_types": [{"type": "user"}]}}}},
        {"type": "tool",
         "relations": {
             "deployed_on": {"this": {}},
             "can_execute": {"union": {"child": [
                 {"this": {}},
                 {"tupleToUserset": {"tupleset": {"relation": "deployed_on"},
                                     "computedUserset": {"relation": "admin"}}}]}}},
         "metadata": {"relations": {
             "deployed_on": {"directly_related_user_types": [{"type": "agent"}]},
             "can_execute": {"directly_related_user_types": [{"type": "user"}]}}}},
        {"type": "resource",
         "relations": {
             "accessible_via": {"this": {}},
             "can_access": {"tupleToUserset": {"tupleset": {"relation": "accessible_via"},
                                               "computedUserset": {"relation": "can_execute"}}}},
         "metadata": {"relations": {
             "accessible_via": {"directly_related_user_types": [{"type": "tool"}]}}}},
    ],
}
model_id = call("POST", f"/stores/{store}/authorization-models", model)["authorization_model_id"]
print(f"model_id  = {model_id}")

# ── 3. 真实 tuples:运维位全量,只读位两个,资源级联一条 ────────────
TOOLS_ALL = ["filesystem-read-file", "filesystem-write-file", "filesystem-list-dir",
             "shell-run-command", "fetch-http-get", "fetch-http-post"]
TOOLS_READONLY = ["filesystem-read-file", "filesystem-list-dir"]
tuples = [{"user": "user:divh", "relation": "admin", "object": "agent:starter-agent"}]
for t in TOOLS_ALL:
    tuples.append({"user": "agent:starter-agent", "relation": "deployed_on", "object": f"tool:{t}"})
for t in TOOLS_READONLY:
    tuples.append({"user": "agent:ts-second-agent", "relation": "deployed_on", "object": f"tool:{t}"})
    tuples.append({"user": "user:bob", "relation": "can_execute", "object": f"tool:{t}"})
tuples.append({"user": "tool:filesystem-read-file", "relation": "accessible_via",
               "object": "resource:workspace-notes"})
call("POST", f"/stores/{store}/write",
     {"writes": {"tuple_keys": tuples}, "authorization_model_id": model_id})
print(f"tuples    = {len(tuples)} 条")

# ── 4. 演示 checks:矩阵的两个角色各查一遍 ─────────────────────────
checks = [
    ("user:divh", "can_execute", "tool:shell-run-command", True),    # 运维位:经 agent#admin 级联放行
    ("user:bob",  "can_execute", "tool:shell-run-command", False),   # 只读位:无此授权
    ("user:bob",  "can_execute", "tool:filesystem-read-file", True), # 只读位:直接授权
    ("user:bob",  "can_execute", "tool:filesystem-write-file", False),
    ("user:divh", "can_access",  "resource:workspace-notes", True),  # 资源级联:能读→能访问
    ("user:bob",  "can_access",  "resource:workspace-notes", True),
]
for u, rel, obj, expect in checks:
    r = call("POST", f"/stores/{store}/check",
             {"tuple_key": {"user": u, "relation": rel, "object": obj},
              "authorization_model_id": model_id})
    ok = "✓" if r["allowed"] == expect else "✗ 意外!"
    print(f"  {ok} check({u}, {rel}, {obj}) = {r['allowed']}(预期 {expect})")

# 刷新网关插件的 id 文件(内存存储每次重建 id 都变,插件从这读,不写死)
import pathlib
ids_path = pathlib.Path("gateway/plugins/fga_ids.json")
ids_path.write_text(json.dumps({"store_id": store, "model_id": model_id}))
print(f"ids file  = {ids_path.resolve()}")
print("playground: http://localhost:3001(store: agent-security-route3)")
PYEOF
