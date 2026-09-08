"""票 12 验收③的 seam 测试：fga_check 插件的裁决行为。

OpenFGA HTTP 调用打桩在 fga_check.query_openfga（seam）——插件逻辑在这里
单测到分支全覆盖；真实的「容器内插件 → openfga 容器」链路由
scripts/gateway-smoke-12.sh 起真容器验证。
"""
import asyncio
import json
import sys
from pathlib import Path

import httpx
from cpex.framework import PluginConfig, PluginContext, ToolPreInvokePayload
from cpex.framework.models import GlobalContext

sys.path.insert(0, str(Path(__file__).parent / "plugins"))
import fga_check  # 插件按 cpex plugin_dirs 形态平铺在 plugins/


def make_plugin(tmp_path, user_map=None, default_user="user:anonymous", ids=None):
    ids_file = tmp_path / "fga_ids.json"
    ids_file.write_text(json.dumps(ids or {"store_id": "S1", "model_id": "M1"}))
    cfg = PluginConfig(
        name="fga_check", kind="fga_check.FGACheckPlugin", version="0.1.0",
        author="soc-demo", hooks=["tool_pre_invoke"], mode="enforce", priority=10,
        config={
            "fga_api_url": "http://openfga:8080", "ids_file": str(ids_file),
            "timeout_s": 1,
            "user_map": user_map if user_map is not None else {
                "soc1@soc.local": "user:soc1",
            },
            "default_user": default_user,
        },
    )
    return fga_check.FGACheckPlugin(cfg)


def ctx(email):
    return PluginContext(global_context=GlobalContext(request_id="req-test", user=email))


def call(plugin, email, tool, allowed=True, boom=None):
    async def fake_query(url, ids, user, obj, timeout):
        if boom:
            raise boom
        return allowed

    orig = fga_check.query_openfga
    fga_check.query_openfga = fake_query
    try:
        payload = ToolPreInvokePayload(name=tool, args={})
        return asyncio.run(plugin.tool_pre_invoke(payload, ctx(email)))
    finally:
        fga_check.query_openfga = orig


def test_allow_continues_and_records_fga_user(tmp_path):
    plugin = make_plugin(tmp_path)
    res = call(plugin, "soc1@soc.local", "kb_lookup", allowed=True)
    assert res.continue_processing is True
    assert res.metadata == {"fga_user": "user:soc1", "fga_decision": "allow"}


def test_deny_is_403_fga_denied(tmp_path):
    plugin = make_plugin(tmp_path)
    res = call(plugin, "soc1@soc.local", "isolate_host", allowed=False)
    assert res.continue_processing is False
    assert res.violation.http_status_code == 403
    assert res.violation.code == "FGA_DENIED"


def test_unmapped_identity_falls_to_anonymous(tmp_path):
    plugin = make_plugin(tmp_path)
    seen = {}

    async def spy(url, ids, user, obj, timeout):
        seen["user"] = user
        return True

    orig = fga_check.query_openfga
    fga_check.query_openfga = spy
    try:
        payload = ToolPreInvokePayload(name="kb_lookup", args={})
        res = asyncio.run(plugin.tool_pre_invoke(payload, ctx("stranger@evil.example")))
    finally:
        fga_check.query_openfga = orig
    assert seen["user"] == "user:anonymous", "认不出的脸按零权限匿名位（fail-closed）"
    assert res.continue_processing is True  # anonymous 本身查库也该是 deny，见冒烟脚本


def test_unreachable_fga_denies_not_permits(tmp_path):
    """INV-1：授权裁判联系不上 ≠ 放行。（真实链路里 query_openfga 抛的是 httpx 异常）"""
    plugin = make_plugin(tmp_path)
    res = call(plugin, "soc1@soc.local", "kb_lookup",
               boom=httpx.ConnectError("openfga down"))
    assert res.continue_processing is False
    assert res.violation.code == "FGA_UNREACHABLE"
    assert res.violation.http_status_code == 403


def test_unreadable_ids_file_denies(tmp_path):
    plugin = make_plugin(tmp_path, ids=None)
    plugin._config.config["ids_file"] = str(tmp_path / "nope.json")
    res = call(plugin, "soc1@soc.local", "kb_lookup", allowed=True)
    assert res.continue_processing is False
    assert res.violation.code == "FGA_IDS_UNREADABLE"
