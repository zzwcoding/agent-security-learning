"""票 12 验收①④的 seam 测试：compose 三容器并排 + 自写件不进官方镜像。

只读 docker-compose.yml 与 contextforge.Dockerfile 的静态事实（CI 无 docker
daemon 也能跑）；「真的能起来」由 scripts/gateway-smoke-12.sh 起真容器验证。
"""
import re
from pathlib import Path

import yaml

GW = Path(__file__).parent
ROOT = GW.parents[1]


def load_compose():
    return yaml.safe_load((ROOT / "docker-compose.yml").read_text(encoding="utf-8"))


def test_gateway_is_three_containers_side_by_side():
    svcs = load_compose()["services"]
    for name in ("contextforge", "openfga", "gateway"):
        assert name in svcs, f"缺 {name}——modules.md §2 拍板的三容器并排不齐"


def test_openfga_is_official_image_without_build():
    svc = load_compose()["services"]["openfga"]
    assert "openfga/openfga" in svc.get("image", "")
    assert "build" not in svc, "官方镜像不许重建（ADR 0001：自写件不动镜像内部）"
    assert not svc.get("volumes"), "openfga 不挂任何宿主代码"


def test_contextforge_uses_image_and_mounts_plugins_at_runtime():
    svc = load_compose()["services"]["contextforge"]
    mounts = [v.split(":")[0] if isinstance(v, str) else str(v) for v in svc.get("volumes", [])]
    assert any("./services/gateway/plugins" in m for m in mounts), "插件必须挂载进官方件"
    assert svc["environment"]["PLUGINS_ENABLED"] == "true"
    assert svc.get("depends_on", {}).get("openfga", {}).get("condition") == "service_started"


def test_contextforge_dockerfile_bakes_no_self_written_code():
    dockerfile = (GW / "contextforge.Dockerfile").read_text(encoding="utf-8")
    first_instruction = next(
        line.strip() for line in dockerfile.splitlines()
        if line.strip() and not line.strip().startswith("#"))
    assert first_instruction.startswith("FROM "), "基础镜像必须是官方件"
    copies = re.findall(r"^\s*COPY\s+(.+)$", dockerfile, re.MULTILINE)
    assert not copies, f"contextforge 镜像不许 COPY 自写代码（挂载接入），见到：{copies}"


def test_self_written_gateway_service_unaffected():
    """票 08 形态不被本票破坏：自写三件还是自己的镜像自己装。"""
    build = load_compose()["services"]["gateway"]["build"]
    build_ref = build if isinstance(build, str) else build.get("context", "")
    assert "services/gateway" in str(build_ref)
    dockerfile = (GW / "Dockerfile").read_text(encoding="utf-8")
    assert "COPY app.py mint.py proxy.py ./" in dockerfile
