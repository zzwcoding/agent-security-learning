"""FGA 授权闸插件——挂在 contextforge 官方镜像的 tool_pre_invoke 钩子上。

每次工具调用真正执行前，拿「调用者身份 + 工具名」问 OpenFGA 一句 can_execute；
False、裁判联系不上、授权数据不可读，一律 403——fail-closed（INV-1），宁可误拒
不可误放。搬自 starter-agent gateway/plugins/fga_check.py（ADR 0001「直接搬」），
改动两处：① HTTP 查询抽成模块级 query_openfga（seam，单测打桩在这）；
② user_map/default_user 对位 PRD 附录 A.2（soc-demo 的 4 个登录身份）。

身份链：contextforge 的 JWT user_email → user_map 查 FGA 用户 → 认不出的脸按
default_user（user:anonymous，零权限元组，天然全 deny）。
"""
import json
import logging
from pathlib import Path

import httpx
from cpex.framework import (
    Plugin,
    PluginContext,
    ToolPreInvokePayload,
    ToolPreInvokeResult,
)
from cpex.framework.models import PluginViolation

logger = logging.getLogger("fga_check")


async def query_openfga(api_url: str, ids: dict, fga_user: str, tool_obj: str,
                        timeout_s: float) -> bool:
    """问裁判一句 can_execute；连接/超时/非 200 都抛异常，由调用方按 deny 处理。"""
    body = {
        "tuple_key": {"user": fga_user, "relation": "can_execute", "object": tool_obj},
        "authorization_model_id": ids["model_id"],
    }
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        resp = await client.post(f"{api_url}/stores/{ids['store_id']}/check", json=body)
        resp.raise_for_status()
        return resp.json().get("allowed", False)


class FGACheckPlugin(Plugin):
    """每个工具调用先过 OpenFGA check；False 即 403。"""

    async def tool_pre_invoke(
        self, payload: ToolPreInvokePayload, context: PluginContext
    ) -> ToolPreInvokeResult:
        cfg = self._config.config or {}
        email = context.user_email or "anonymous@soc.local"
        fga_user = cfg.get("user_map", {}).get(email, cfg.get("default_user", "user:anonymous"))
        tool_obj = f"tool:{payload.name}"

        # store/model id 从 fga_ids.json 读（setup-openfga.sh 每次重建世界时刷新；
        # 内存存储的 id 每次都变，写死必踩坑）。文件经 bind mount 进容器，实时可见。
        ids = {}
        try:
            ids = json.loads(Path(cfg["ids_file"]).read_text(encoding="utf-8"))
        except (OSError, ValueError, KeyError, TypeError) as exc:
            return self._deny(f"授权数据不可读({exc})", code="FGA_IDS_UNREADABLE", email=email)

        try:
            allowed = await query_openfga(
                cfg["fga_api_url"], ids, fga_user, tool_obj, cfg.get("timeout_s", 3))
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            # 裁判联系不上 ≠ 放行（INV-1）；逃逸的意外异常由 cpex on_error:fail 兜底拦截
            return self._deny(f"授权裁判不可达:{exc}", code="FGA_UNREACHABLE", email=email)

        if not allowed:
            logger.info(f"FGA deny: {email}({fga_user}) -> {payload.name}")
            return self._deny(
                f"{email}(FGA:{fga_user}) 无权执行 {payload.name}",
                code="FGA_DENIED",
                email=email,
                details={"fga_user": fga_user, "tool": tool_obj},
            )

        # 放行也要留痕：日志 + metadata，审计时能对出"闸门开过、谁过的"
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
