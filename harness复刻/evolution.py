"""实验 9-7 复刻:诊断与编排层。当前 = 阶段 2:失败聚簇与立案。

与实验 9-6 的对照:9-6 改控制层(重试/熔断),信号来自系统内部错误日志;
本实验改安全/验证层(工具调度确认门禁),信号来自用户纠正、点踩与
事后审计三类外部反馈。
"""

import re
from collections import defaultdict

# 跨轨迹支持门槛:同一故障模式至少出现在几条不同轨迹里,才值得立案改系统
SUPPORT_THRESHOLD = 2

_DESTRUCTIVE_SQL = re.compile(r"\b(DROP\s+TABLE|TRUNCATE)\b", re.IGNORECASE)
_DELETE_FROM = re.compile(r"\bDELETE\s+FROM\b", re.IGNORECASE)
_HAS_WHERE = re.compile(r"\bWHERE\b", re.IGNORECASE)
_DANGEROUS_SHELL = re.compile(r"\brm\s+-[rf]+\b|\bmkfs\b|\bshutdown\b|\bdd\s+if=", re.IGNORECASE)


def classify_risk(tool_name, args=None):
    """风险分类器:返回 (风险类别, 原因);类别为 None 表示低风险。

    诊断阶段用它给每条调用打标、聚合失败簇;阶段 3 的门禁模块要
    自带等价逻辑并接受回放验证——这里先立好"官方答案"。
    """
    args = args or {}
    if tool_name == "delete_file":
        return "delete_file", "删除文件不可逆,执行前必须经用户确认"
    if tool_name == "git_push" and args.get("force"):
        return "force_push", "force push 会覆盖远端提交历史"
    if tool_name == "sql_query":
        query = str(args.get("query", ""))
        if _DESTRUCTIVE_SQL.search(query):
            return "destructive_sql", "DROP/TRUNCATE 会销毁整张表"
        if _DELETE_FROM.search(query) and not _HAS_WHERE.search(query):
            return "destructive_sql", "无 WHERE 的 DELETE 会清空整表"
    if tool_name == "run_shell" and _DANGEROUS_SHELL.search(str(args.get("command", ""))):
        return "dangerous_shell", "Shell 命令包含不可逆的破坏性模式"
    return None, ""


def diagnose(trajectories):
    """聚合跨轨迹的相同故障模式:达到支持门槛才立案(修改请求)。

    三条过滤各挡一种噪声:正常完成(含用户已确认)不是失败;
    用户已确认的调用不算违规;低风险调用的负反馈不归因到确认门禁。
    """
    clusters = defaultdict(dict)
    for item in trajectories:
        if item.get("outcome", "failure") != "failure":
            continue  # 过滤一:对照轨迹(如用户同意后的删除)
        for call in item.get("tool_calls", []):
            if call.get("user_confirmed", False):
                continue  # 过滤二:已确认的操作不算违规
            kind, _reason = classify_risk(call.get("tool"), call.get("args"))
            if kind is None:
                continue  # 过滤三:低风险负反馈(如周报措辞点踩)与门禁无关
            # 用轨迹 id 做键:同一条轨迹重复出现只计一次,支持度数的是"不同轨迹数"
            clusters[kind][item["id"]] = item

    patterns = []
    for kind in sorted(clusters):
        items = clusters[kind]
        if len(items) < SUPPORT_THRESHOLD:
            continue  # rm -rf 这类单条轨迹:记了案但不立案
        first = next(iter(items.values()))
        call = next(
            c for c in first["tool_calls"]
            if classify_risk(c.get("tool"), c.get("args"))[0] == kind
        )
        patterns.append({
            "cluster_id": f"unconfirmed_{kind}",
            "risk_kind": kind,
            "tool": call.get("tool"),
            "signals": sorted({it["signal"] for it in items.values()}),
            "source_case_ids": sorted(items),
            "cross_trajectory_support": len(items),
        })
    if not patterns:
        return {
            "change_required": False,
            "target": None,
            "patterns": [],
            "reason": "没有任何未确认高风险调用模式达到跨轨迹支持门槛。",
        }
    source_ids = sorted({cid for p in patterns for cid in p["source_case_ids"]})
    return {
        "change_required": True,
        "target": "stable/tool_dispatcher.py",
        "target_component": "tool_dispatch_confirmation_gate",
        "source_case_ids": source_ids,
        "patterns": patterns,
        "reason": (
            "工具调度层缺少高风险调用确认门禁:删除、force push、DROP TABLE 等不可逆操作"
            "未经用户确认即被执行。失败信号来自用户纠正、点踩与事后审计三类外部反馈,"
            "根因在 Harness 流程缺失,不在模型能力。"
        ),
    }
