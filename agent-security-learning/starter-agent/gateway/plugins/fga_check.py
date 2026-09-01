"""FGA 授权闸——路线 3 阶段 38 的核心锚点件。

挂在网关的 tool_pre_invoke 钩子上:每次工具调用真正执行前,
拿「调用者身份 + 工具名」去问 OpenFGA 一句 can_execute,
False(或裁判联系不上)一律拒绝——fail closed,路线 2 的纪律延续。

身份来源:JWT 解析出的 user_email(context 提供),经 config 的
user_map 映射成 FGA 用户;认不出的脸一律按最小权限位(user:bob)对待。
"""
import logging

import httpx
from cpex.framework import (
    Plugin,
    PluginConfig,
    PluginContext,
    ToolPreInvokePayload,
    ToolPreInvokeResult,
)
from cpex.framework.models import PluginViolation


logger = logging.getLogger("fga_check")


class FGACheckPlugin(Plugin):
    """每个工具调用先过 OpenFGA check;False 即 403。"""

    async def tool_pre_invoke(
        self, payload: ToolPreInvokePayload, context: PluginContext
    ) -> ToolPreInvokeResult:
        cfg = self._config.config or {}
        email = context.user_email or "anonymous@example.com"
        fga_user = cfg.get("user_map", {}).get(email, cfg.get("default_user", "user:bob"))
        tool_obj = f"tool:{payload.name}"

        # store/model id 从 fga_ids.json 读(setup-openfga.sh 每次重建世界时刷新,
        # 内存存储的 id 每次都变,写死必踩坑)
        ids = {}
        try:
            import json

            with open(cfg["ids_file"]) as f:
                ids = json.load(f)
        except Exception as exc:
            return self._deny(f"授权数据不可读({exc})", code="FGA_IDS_UNREADABLE", email=email)

        body = {
            "tuple_key": {"user": fga_user, "relation": "can_execute", "object": tool_obj},
            "authorization_model_id": ids["model_id"],
        }
        try:
            async with httpx.AsyncClient(timeout=cfg.get("timeout_s", 3)) as client:
                resp = await client.post(
                    f"{cfg['fga_api_url']}/stores/{ids['store_id']}/check", json=body
                )
                resp.raise_for_status()
                allowed = resp.json().get("allowed", False)
        except Exception as exc:
            # 裁判联系不上 ≠ 放行。宁可误拒,不可误放。
            return self._deny(f"授权裁判不可达:{exc}", code="FGA_UNREACHABLE", email=email)

        if not allowed:
            logger.info(f"FGA deny: {email}({fga_user}) -> {payload.name}")
            return self._deny(
                f"{email}(FGA:{fga_user}) 无权执行 {payload.name}",
                code="FGA_DENIED",
                email=email,
                details={"fga_user": fga_user, "tool": tool_obj},
            )

        # 放行也要留痕:日志 + metadata,审计时能对出"闸门开过、谁过的"
        logger.info(f"FGA allow: {email}({fga_user}) -> {payload.name}")
        return ToolPreInvokeResult(
            continue_processing=True,
            metadata={"fga_user": fga_user, "fga_decision": "allow"},
        )

    @staticmethod
    def _deny(reason: str, code: str, email: str, details: dict | None = None) -> ToolPreInvokeResult:
        return ToolPreInvokeResult(
            continue_processing=False,
            violation=PluginViolation(
                reason=reason,
                description="OpenFGA 细粒度授权拒绝(fail closed)",
                code=code,
                details={"email": email, **(details or {})},
                mcp_error_code=-32603,
                http_status_code=403,
            ),
        )
