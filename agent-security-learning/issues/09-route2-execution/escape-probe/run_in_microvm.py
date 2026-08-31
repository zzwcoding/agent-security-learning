"""阶段 24:把逃逸探针送进一次性 microVM 跑(与加固 Docker 同一份 probe.sh)。

用法(在 starter-agent 目录,用它的 .venv):
  .venv/bin/python ../issues/09-route2-execution/escape-probe/run_in_microvm.py [--public]

默认网络形态 = shell_server 的生产形态(不传 network,全开)——与加固 Docker 的
"网络未限(已知缺口)"对齐,单变量对比文件/权限边界;
--public = 阶段 23 的 PUBLIC profile,展示白名单上线后的网络半边。
"""
import asyncio
import base64
import sys
import uuid
from pathlib import Path

from microsandbox import Sandbox
from microsandbox.types import Network, NetworkProfile

PROBE = Path(__file__).parent / "probe.sh"
CMD = f"echo {base64.b64encode(PROBE.read_bytes()).decode()} | base64 -d > /tmp/probe.sh && sh /tmp/probe.sh"


async def main():
    public = "--public" in sys.argv
    kw = {"network": Network.from_profiles(NetworkProfile.PUBLIC)} if public else {}
    label = "PUBLIC profile" if public else "默认网络(全开,同 shell 工具生产形态)"
    async with await Sandbox.create(
        name=f"escape-{uuid.uuid4().hex[:6]}", image="python:3.12", ephemeral=True, **kw
    ) as sb:
        out = await sb.shell(CMD, timeout=120)
    print(f"\n########## microVM({label}) ##########")
    print((out.stdout_text + out.stderr_text).rstrip())


asyncio.run(main())
