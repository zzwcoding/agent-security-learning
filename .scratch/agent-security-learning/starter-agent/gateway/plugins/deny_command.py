"""出口命令过滤插件(阶段 44)——shell 公网出口残余的网关侧核销件。

路线 2 遗留:fetch 有白名单,但 shell 工具里 curl/wget 仍可从 VM 内触网。
本插件挂 tool_pre_invoke:命令含出网动词即拒——出口控制从"工具自觉"上移
到"网关强制",与方案 10"egress 分工:出口域名白名单+凭证策略留守 server,
调用方授权+命令过滤上移网关"对齐。
"""
import logging

from cpex.framework import (
    Plugin,
    ToolPreInvokePayload,
    ToolPreInvokeResult,
)
from cpex.framework.models import PluginViolation

logger = logging.getLogger("deny_command")

# 出网动词:命中即拒(白名单式放行留给生产做完整版,教学取黑名单最小闭环)
NET_VERBS = ("curl", "wget", "nc ", "ssh ", "scp ", "ftp", "telnet", "ping ")


class DenyCommandPlugin(Plugin):
    async def tool_pre_invoke(self, payload: ToolPreInvokePayload, context) -> ToolPreInvokeResult:
        if payload.name != "shell-run-command":
            return ToolPreInvokeResult(continue_processing=True)
        command = str((payload.args or {}).get("command", "")).lower()
        hit = next((v for v in NET_VERBS if v in command), None)
        if hit:
            email = context.user_email or "anonymous"
            logger.info(f"deny_command: {email} -> {command[:60]} (verb={hit.strip()})")
            return ToolPreInvokeResult(
                continue_processing=False,
                violation=PluginViolation(
                    reason=f"命令含出网动词 '{hit.strip()}',已被网关出口策略拒绝",
                    description="shell 出网在网关层强制拦截(缺口:shell 公网出口核销)",
                    code="EGRESS_DENIED",
                    details={"command": command[:120], "verb": hit.strip(), "email": email},
                    mcp_error_code=-32603,
                    http_status_code=403,
                ),
            )
        return ToolPreInvokeResult(continue_processing=True)
