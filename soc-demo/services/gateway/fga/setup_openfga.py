"""OpenFGA 授权世界幂等重建引擎（票 12；被 scripts/setup-openfga.sh 调）。

「幂等重建」三条纪律（ADR 0001：搬 starter-agent setup-openfga.sh 的思路，
模型按 PRD 附录 A.2 重建为 4 角色 × 4 工具族）：
  1. store 按名字找，找到就复用，绝不新建第二个授权世界；
  2. 授权模型逐字节比对（schema_version + type_definitions），一样就复用旧
     model_id（OpenFGA 模型不可变，不比对会每次重跑都涨一个版本）；
  3. 元组差量同步：先读后写，缺的补、多的删，重复跑结果一致。

内存存储口径沿用参考工程：openfga 容器一停授权世界全没，重跑本脚本 30 秒
恢复；store/model id 每次都可能变 → 刷进 fga_ids.json 给插件读，不写死。

FGA 只表达「直接可执行」：L2 两族（kb_write/incident_response）在 A.2 里是
「需审批」，任何角色都没有直接授权（三态裁决的 require_approval 走审批铸
ApprovalToken，不经这个布尔闸），这正是 D7/INV-3 在 FGA 面上的形状。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# ── OpenFGA REST 的最小封装（标准库 urllib，教学版不引 SDK）──────────────


def api(base: str, method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        base + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code} {path}: {e.read().decode()[:400]}") from e


def wait_healthz(base: str, tries: int = 30) -> None:
    for _ in range(tries):
        try:
            with urllib.request.urlopen(base + "/healthz", timeout=2) as r:
                if r.status == 200:
                    return
        except OSError:
            pass
        time.sleep(1)
    raise SystemExit("OpenFGA 未就绪（/healthz 30s 不通）")


# ── 幂等三件：store / model / tuples ─────────────────────────────────────


def find_or_create_store(base: str, name: str) -> tuple[str, str]:
    stores = api(base, "GET", "/stores?pagination.page_size=100").get("stores", [])
    for s in stores:
        if s["name"] == name:
            return s["id"], "reused"
    return api(base, "POST", "/stores", {"name": name})["id"], "created"


def _strip_empty(node):
    """递归剥掉空值键：API 回读会在 tupleToUserset 里补 "object": "" 之类的修饰。"""
    if isinstance(node, dict):
        return {k: _strip_empty(v) for k, v in node.items() if v not in ("", None)}
    if isinstance(node, list):
        return [_strip_empty(x) for x in node]
    return node


def model_shape(model: dict) -> list:
    """归一化模型骨架（类型 + 关系表达式）。API 回读时会补 metadata 修饰字段
    （condition/module/source_info/object:""…），逐字节比对永不相等，这里只留可比的骨架。"""
    return [{"type": td["type"], "relations": _strip_empty(td.get("relations", {}))}
            for td in model["type_definitions"]]


def find_or_create_model(base: str, store: str, model: dict) -> tuple[str, str]:
    shape = model_shape(model)
    models = api(base, "GET", f"/stores/{store}/authorization-models").get(
        "authorization_models", [])
    for m in models:
        if m.get("schema_version") == model["schema_version"] and \
                model_shape(m) == shape:
            return m["id"], "reused"
    return api(base, "POST", f"/stores/{store}/authorization-models", model)[
        "authorization_model_id"], "created"


def desired_tuples(matrix: dict) -> list[dict]:
    """角色×族授权 + 族×工具归属，两组元组就是 A.2 的全部内容。"""
    out = []
    for role, spec in matrix["roles"].items():
        for fam in spec["families"]:
            out.append({"user": f"user:{role}", "relation": "can_execute",
                        "object": f"family:{fam}"})
    for fam, spec in matrix["families"].items():
        for tool in spec["tools"]:
            out.append({"user": f"family:{fam}", "relation": "member_of",
                        "object": f"tool:{tool}"})
    return out


def read_user_tuples(base: str, store: str, user: str, object_type: str,
                     model_id: str) -> set[tuple[str, str, str]]:
    """按 user 轴翻页读元组。read 接口要求 object 必须带类型名（空串都不行，
    用「类型名:」表示该类型下全部 id），且没有全量扫描的免费午餐——本脚本写出的
    世界只有两根轴：user:<角色>→family:* 与 family:<族>→tool:*。"""
    keys, token = set(), ""
    while True:
        body: dict = {"tuple_key": {"user": user, "relation": "",
                                    "object": f"{object_type}:"},
                      "authorization_model_id": model_id}
        if token:
            body["continuation_token"] = token
        page = api(base, "POST", f"/stores/{store}/read", body)
        for t in page.get("tuples", []):
            k = t["key"]
            keys.add((k["user"], k["relation"], k["object"]))
        token = page.get("continuation_token") or ""
        if not token:
            return keys


def read_existing_tuples(base: str, store: str, matrix: dict,
                         model_id: str) -> set[tuple[str, str, str]]:
    keys: set[tuple[str, str, str]] = set()
    for role in matrix["roles"]:
        keys |= read_user_tuples(base, store, f"user:{role}", "family", model_id)
    for fam in matrix["families"]:
        keys |= read_user_tuples(base, store, f"family:{fam}", "tool", model_id)
    return keys


def sync_tuples(base: str, store: str, model_id: str, desired: list[dict],
                matrix: dict) -> tuple[int, int]:
    have = read_existing_tuples(base, store, matrix, model_id)
    want = {(t["user"], t["relation"], t["object"]) for t in desired}
    writes = [t for t in desired if (t["user"], t["relation"], t["object"]) not in have]
    deletes = [{"user": u, "relation": r, "object": o}
               for (u, r, o) in have - want if u.startswith(("user:", "family:"))]
    if writes:
        api(base, "POST", f"/stores/{store}/write",
            {"writes": {"tuple_keys": writes}, "authorization_model_id": model_id})
    if deletes:
        api(base, "POST", f"/stores/{store}/write",
            {"deletes": {"tuple_keys": deletes}, "authorization_model_id": model_id})
    return len(writes), len(deletes)


# ── A.2 矩阵裁决自检（setup 跑完当场对表，不达标非零退出）────────────────


def demo_checks() -> list[tuple[str, str, bool, str]]:
    return [
        ("user:soc1", "tool:kb_lookup", True, "A.2 只读族 ✓"),
        ("user:soc1", "tool:close_alert", True, "A.2 案件写入族 ✓"),
        ("user:soc1", "tool:kb_write", False, "A.2 KB 入库「—」"),
        ("user:soc1", "tool:isolate_host", False, "A.2 高危「—」；m8 eval：soc1 发起 L2 意图 100% deny"),
        ("user:duty_lead", "tool:kb_lookup", True, "A.2 只读族 ✓"),
        ("user:duty_lead", "tool:kb_write", False, "「审批回路✓」= 铸 ApprovalToken 走票通道，不直接过闸"),
        ("user:duty_lead", "tool:isolate_host", False, "「需审批（本人可批）」= 先审批铸票，不直接过闸"),
        ("user:admin", "tool:kb_lookup", True, "A.2 只读族 ✓"),
        ("user:admin", "tool:close_alert", True, "A.2 案件写入族 ✓"),
        ("user:admin", "tool:isolate_host", False, "「需审批」= 先审批铸票，不直接过闸"),
        ("user:redteam", "tool:kb_lookup", False, "红队零授权"),
        ("user:redteam", "tool:isolate_host", False, "红队零授权"),
        ("user:anonymous", "tool:kb_lookup", False, "认不出的脸=零权限匿名位（fail-closed，INV-1）"),
    ]


def run_checks(base: str, store: str, model_id: str) -> None:
    bad = 0
    for user, obj, expect, note in demo_checks():
        r = api(base, "POST", f"/stores/{store}/check",
                {"tuple_key": {"user": user, "relation": "can_execute", "object": obj},
                 "authorization_model_id": model_id})
        ok = r["allowed"] == expect
        bad += 0 if ok else 1
        mark = "✓" if ok else "✗ 意外!"
        print(f"  {mark} check({user}, can_execute, {obj}) = {r['allowed']}(预期 {expect}) —— {note}")
    if bad:
        raise SystemExit(f"A.2 矩阵裁决自检 {bad} 条不符，授权世界与 PRD 不一致")


# ── 入口 ──────────────────────────────────────────────────────────────────


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--api", default="http://127.0.0.1:18080", help="OpenFGA REST（宿主映射口；容器网络内恒为 8080）")
    ap.add_argument("--matrix", default="services/gateway/fga/matrix.json")
    ap.add_argument("--model", default="services/gateway/fga/openfga_model.json")
    ap.add_argument("--ids-out", default="services/gateway/plugins/fga_ids.json")
    args = ap.parse_args()

    matrix = json.loads(Path(args.matrix).read_text(encoding="utf-8"))
    model = json.loads(Path(args.model).read_text(encoding="utf-8"))

    wait_healthz(args.api)
    store, store_how = find_or_create_store(args.api, matrix["store_name"])
    print(f"store     = {store} ({store_how}: {matrix['store_name']})")
    model_id, model_how = find_or_create_model(args.api, store, model)
    print(f"model     = {model_id} ({model_how})")
    written, deleted = sync_tuples(args.api, store, model_id, desired_tuples(matrix), matrix)
    print(f"tuples    = written={written} deleted={deleted}（存量 {len(desired_tuples(matrix))} 条目标态）")
    print("checks(A.2 角色×工具族):")
    run_checks(args.api, store, model_id)

    ids_out = Path(args.ids_out)
    ids_out.parent.mkdir(parents=True, exist_ok=True)
    ids_out.write_text(json.dumps({"store_id": store, "model_id": model_id}), encoding="utf-8")
    print(f"ids file  = {ids_out}（contextforge 经 bind mount 实时可读）")


if __name__ == "__main__":
    sys.exit(main())
