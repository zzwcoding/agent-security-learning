"""票 12 验收②③的 seam 测试：FGA 授权模型 = PRD 附录 A.2 的机读化。

matrix.json（services/gateway/fga/）是 setup-openfga.sh、contextforge 插件
config.yaml 与本测试共用的唯一事实源；PRD 附录 A.1/A.2 若改，先改这里的
期望（测试变红）再改 json（回到绿）——测试把「拍板」钉在机器上。
"""
import json
from pathlib import Path

import yaml

GW = Path(__file__).parent

# FGA 矩阵侧工具全集 = PRD A.1 收编 24 工具中进族的 23 个（含 L2 五件）；
# list_approvals（场景 7）是矩阵外登记例外，见 test_tool_manifest_matches_matrix_families
A1_L2 = {"kb_write", "isolate_host", "block_ip", "deisolate_host", "unblock_ip"}
A1_ALL = {
    "kb_lookup", "search_cases_by_host", "get_alert", "siem_query",
    "related_alerts", "kb_verify", "vt_lookup", "ip_reputation",
    "extract_knowledge",
    "create_case", "merge_alert", "close_alert", "add_timeline_entry",
    "add_task_log", "add_observable", "kb_propose", "case_assign", "case_update",
} | A1_L2


def load_matrix():
    return json.loads((GW / "fga" / "matrix.json").read_text(encoding="utf-8"))


def load_model():
    return json.loads((GW / "fga" / "openfga_model.json").read_text(encoding="utf-8"))


def load_plugin_config():
    return yaml.safe_load((GW / "plugins" / "config.yaml").read_text(encoding="utf-8"))


def fgacfg():
    return load_plugin_config()["plugins"][0]["config"]


def test_exactly_four_roles_from_a2():
    roles = load_matrix()["roles"]
    assert set(roles) == {"soc1", "duty_lead", "admin", "redteam"}


def test_exactly_four_tool_families():
    fams = load_matrix()["families"]
    assert set(fams) == {"readonly_query", "case_write", "kb_write", "incident_response"}
    tiers = {name: fam["tier"] for name, fam in fams.items()}
    assert tiers == {
        "readonly_query": "L0", "case_write": "L1",
        "kb_write": "L2", "incident_response": "L2",
    }


def test_every_a1_tool_in_exactly_one_family():
    fams = load_matrix()["families"]
    seen = [t for fam in fams.values() for t in fam["tools"]]
    assert set(seen) == A1_ALL, "A.1 工具必须全部进族"
    assert len(seen) == len(set(seen)), "一个工具只能属于一个族"


def load_tool_manifest():
    return json.loads((GW.parent.parent / "fixtures" / "tools.manifest.json").read_text(encoding="utf-8"))


def test_tool_manifest_matches_matrix_families():
    """票 48（ADR 0004-2）：fixtures/tools.manifest.json 是工具分级/族的登记单一来源；
    matrix.json 是族→角色的 FGA 授权面。两个机读面的族归属与分级必须逐字一致：
    矩阵里的每个工具在 manifest 同名同族同级；manifest 比矩阵多出的登记必须单独
    点名（当前两个：get_case，票 17 引入的沉淀读案工具；list_approvals，场景 7 的
    审批台账读口——两者都是「登记先行、矩阵暂未收」的点名例外）。"""
    entries = {t["name"]: t for t in load_tool_manifest()["tools"]}
    fams = load_matrix()["families"]
    matrix_tools = {t for fam in fams.values() for t in fam["tools"]}
    for fam, spec in fams.items():
        for tool in spec["tools"]:
            assert tool in entries, f"矩阵工具 {tool} 未在 manifest 登记（先登记后授权）"
            assert entries[tool]["family"] == fam, f"{tool} family 与矩阵漂移"
            assert entries[tool]["tier"] == spec["tier"], f"{tool} tier 与矩阵漂移"
    extra = set(entries) - matrix_tools
    assert extra == {"get_case", "list_approvals"}, f"manifest 比矩阵多出的登记须点名复核：{sorted(extra)}"


def test_no_direct_grant_on_l2_anywhere():
    """A.2 的「需审批/审批回路」= 走审批铸 ApprovalToken，不经 FGA 直接放行——
    所以 4 角色 × L2 两族的直接授权必须为空（D7/INV-3 的 FGA 面）。"""
    roles = load_matrix()["roles"]
    for role, spec in roles.items():
        overlap = set(spec["families"]) & {"kb_write", "incident_response"}
        assert not overlap, f"{role} 拿到了 L2 直接授权 {overlap}"


def test_a2_grants_match_prd_rows():
    roles = load_matrix()["roles"]
    assert roles["soc1"]["families"] == ["readonly_query", "case_write"]
    assert roles["duty_lead"]["families"] == ["readonly_query", "case_write"]
    assert roles["admin"]["families"] == ["readonly_query", "case_write"]
    assert roles["redteam"]["families"] == []


def test_openfga_model_user_family_tool_cascade():
    types = {td["type"]: td for td in load_model()["type_definitions"]}
    assert set(types) == {"user", "family", "tool"}
    assert types["family"]["relations"]["can_execute"] == {"this": {}}
    tool = types["tool"]["relations"]
    assert tool["member_of"] == {"this": {}}
    assert tool["can_execute"] == {
        "tupleToUserset": {
            "tupleset": {"relation": "member_of"},
            "computedUserset": {"relation": "can_execute"},
        }
    }, "工具的 can_execute 必须经 member_of 级联到族——「角色×工具族」就级联在这一跳"


def test_user_map_matches_a2_roles():
    cfg = fgacfg()
    assert cfg["user_map"] == {
        "soc1@soc.local": "user:soc1",
        "duty_lead@soc.local": "user:duty_lead",
        "admin@soc.local": "user:admin",
        "redteam@soc.local": "user:redteam",
    }
    # 认不出的脸按零权限匿名位对待——fail-closed（INV-1），不是最小可读位
    assert cfg["default_user"] == "user:anonymous"
    # 容器里插件走 compose 网络服务名，不走宿主机 127.0.0.1
    assert cfg["fga_api_url"] == "http://openfga:8080"


def test_plugin_registered_on_tool_pre_invoke_enforce():
    entry = load_plugin_config()["plugins"][0]
    assert entry["kind"] == "fga_check.FGACheckPlugin"
    assert entry["hooks"] == ["tool_pre_invoke"]
    assert entry["mode"] == "enforce"
    assert load_plugin_config()["plugin_dirs"] == ["plugins"]
