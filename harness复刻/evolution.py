"""实验 9-7 复刻:诊断与编排层。当前 = 阶段 6:隔离回放引擎。

与实验 9-6 的对照:9-6 改控制层(重试/熔断),信号来自系统内部错误日志;
本实验改安全/验证层(工具调度确认门禁),信号来自用户纠正、点踩与
事后审计三类外部反馈。
"""

import ast
import difflib
import hashlib
import importlib.util
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# 跨轨迹支持门槛:同一故障模式至少出现在几条不同轨迹里,才值得立案改系统
SUPPORT_THRESHOLD = 2

_DESTRUCTIVE_SQL = re.compile(r"\b(DROP\s+TABLE|TRUNCATE)\b", re.IGNORECASE)
_DELETE_FROM = re.compile(r"\bDELETE\s+FROM\b", re.IGNORECASE)
_HAS_WHERE = re.compile(r"\bWHERE\b", re.IGNORECASE)
_DANGEROUS_SHELL = re.compile(r"\brm\s+-[rf]+\b|\bmkfs\b|\bshutdown\b|\bdd\s+if=", re.IGNORECASE)


def sha256_text(source: str) -> str:
    """把任意文本压成 SHA-256 指纹:提案流水线里每份材料都靠它锚定防篡改。"""
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def _short_sha(source: str) -> str:
    return sha256_text(source)[:12]


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
    # 溯源:每条支撑轨迹算一个哈希,证据被改一个字都对不上
    sources = [
        {
            "id": item["id"],
            "signal": item.get("signal"),
            "trajectory_sha256": sha256_text(repr(sorted(item.items(), key=lambda kv: kv[0]))),
        }
        for item in trajectories if item.get("id") in source_ids
    ]
    return {
        "change_required": True,
        "target": "stable/tool_dispatcher.py",
        "target_component": "tool_dispatch_confirmation_gate",
        "source_case_ids": source_ids,
        "source_trajectories": sources,
        "patterns": patterns,
        "reason": (
            "工具调度层缺少高风险调用确认门禁:删除、force push、DROP TABLE 等不可逆操作"
            "未经用户确认即被执行。失败信号来自用户纠正、点踩与事后审计三类外部反馈,"
            "根因在 Harness 流程缺失,不在模型能力。"
        ),
    }


# ---- 阶段 4:提案打包 ----------------------------------------------------
# 对稳定版 dispatch 的最小接入点(只是提案 diff,验证与发布都不依赖它落盘)
OLD_DISPATCH_HEAD = "def dispatch(tool_name, args=None, *, env=None):"
NEW_DISPATCH_HEAD = "def dispatch(tool_name, args=None, *, env=None, confirm_token=None):"
OLD_DISPATCH_RETURN = '    return {"tool": tool_name, "args": args, "result": TOOLS[tool_name](env, **args)}'
NEW_DISPATCH_RETURN = (
    "    from confirmation_gate import dispatch as gated_dispatch  # 最小接入:先过确认门禁\n"
    "    def execute(name, call_args):\n"
    '        return {"tool": name, "args": call_args, "result": TOOLS[name](env, **call_args)}\n'
    "    return gated_dispatch(tool_name, args, execute=execute, confirm_token=confirm_token)"
)


def _integration_diff(stable_source: str) -> str:
    """生成对稳定版调度器的最小接入 diff(仅作提案,不修改 stable/)。"""
    integrated = stable_source.replace(OLD_DISPATCH_HEAD, NEW_DISPATCH_HEAD, 1)
    integrated = integrated.replace(OLD_DISPATCH_RETURN, NEW_DISPATCH_RETURN, 1)
    if integrated == stable_source:
        raise ValueError("稳定版 dispatch 结构与预期不符,无法生成接入 diff")
    return "".join(difflib.unified_diff(
        stable_source.splitlines(keepends=True),
        integrated.splitlines(keepends=True),
        fromfile="stable/tool_dispatcher.py",
        tofile="candidate/tool_dispatcher.py",
    ))


def candidate_from_gate(
    gate_source: str,
    *,
    integration_diff: str = "",
    impact_prediction: dict | None = None,
    generator_metadata: dict | None = None,
) -> dict:
    """把生成的门禁模块与溯源信息打包成可评审候选(一份完整建议书)。"""
    diff = "".join(difflib.unified_diff(
        [],
        gate_source.splitlines(keepends=True),
        fromfile="/dev/null",
        tofile="candidate/confirmation_gate.py",
    ))
    added = sum(line.startswith("+") and not line.startswith("+++") for line in diff.splitlines())
    return {
        "module": "confirmation_gate.py",
        "source": gate_source,
        "diff": diff,
        "integration_diff": integration_diff,
        "changed": bool(gate_source.strip()),
        "impact_prediction": impact_prediction or {},
        "generator_metadata": generator_metadata or {},
        "source_sha256": sha256_text(gate_source),
        "patch_size": {"added_lines": added, "deleted_lines": 0, "changed_lines": added},
    }


def generate_candidate(stable_source: str, diagnosis: dict) -> dict:
    """确定性对照候选:读取手写门禁(阶段 3)作为提案源码,不触碰 stable/。

    参考项目把同一份源码内嵌成 GATE_TEMPLATE 字符串;复刻改为读文件,
    保证"手写原型"与"管线产物"永远同一份文本(有意改进,收官核对)。
    """
    if not diagnosis.get("change_required"):
        return candidate_from_gate("", generator_metadata={"generator": "deterministic", "api_calls": 0})
    gate_source = (ROOT / "confirmation_gate.py").read_text(encoding="utf-8")
    return candidate_from_gate(
        gate_source,
        integration_diff=_integration_diff(stable_source),
        impact_prediction={
            "unconfirmed_high_risk_executions": {"before": "直接执行", "after": 0},
            "low_risk_calls_suspended": {"before": 0, "after": 0},
        },
        generator_metadata={"generator": "deterministic", "model": None, "api_calls": 0},
    )


# ---- 阶段 5:静态闸(执行前的快速预筛,候选永远碰不到真实环境)--------------
CHECK_NAMES = (
    "static_compile",
    "security_scan",
    "gate_contract",
    "boundary_replay",
    "retention_replay",
    "confirmation_single_use",
)

# 候选只允许纯计算的标准库;AST 扫描是执行前的快速预筛。
ALLOWED_IMPORTS = {"hashlib", "hmac", "json", "re", "secrets", "string"}
FORBIDDEN_CALLS = {"eval", "exec", "compile", "open", "__import__", "input", "breakpoint"}
MAX_SOURCE_BYTES = 64_000


def _safe_ast(source: str) -> bool:
    """只允许白名单导入,禁止危险内建调用;语法树上过不去就别想被执行。"""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return False
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(alias.name.split(".")[0] not in ALLOWED_IMPORTS for alias in node.names):
                return False
        elif isinstance(node, ast.ImportFrom):
            if (node.module or "").split(".")[0] not in ALLOWED_IMPORTS:
                return False
        elif (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in FORBIDDEN_CALLS
        ):
            return False
    return True


def validate_candidate(candidate_source: str) -> dict:
    """模型外发布门槛。当前 = 静态两项 + 契约检查;后三项由阶段 7 接管。"""
    checks = {name: False for name in CHECK_NAMES}
    if len(candidate_source.encode("utf-8")) > MAX_SOURCE_BYTES:
        return checks
    try:
        compile(candidate_source, "candidate/confirmation_gate.py", "exec")
    except (SyntaxError, ValueError, TypeError):
        return checks
    checks["static_compile"] = True
    if not _safe_ast(candidate_source):
        return checks
    checks["security_scan"] = True
    try:
        gate = _load_gate(candidate_source)
    except Exception:
        return checks
    checks["gate_contract"] = _check_contract(gate)
    return checks


# ---- 阶段 6:隔离回放引擎 ----------------------------------------------------

def _load_stable_dispatcher():
    """按路径加载稳定版调度器,避免依赖包结构——stable 是"文件"不是"包"。"""
    spec = importlib.util.spec_from_file_location(
        "stable_tool_dispatcher", ROOT / "stable" / "tool_dispatcher.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STABLE = _load_stable_dispatcher()


def _load_gate(source: str) -> dict:
    """在干净命名空间中加载候选模块(此前必须已通过静态闸)。

    exec 进独立 dict:候选的全局变量、import 都被关在这个命名空间里,
    不污染验证器;每次加载都是全新实例,候选内部的 _pending 互不相通。
    """
    namespace: dict = {"__name__": "candidate_confirmation_gate"}
    exec(compile(source, "candidate/confirmation_gate.py", "exec"), namespace)
    return namespace


def _check_contract(gate: dict) -> bool:
    """契约检查:先验接口形状,缺任何一个约定函数都不进回放。"""
    return all(
        callable(gate.get(name))
        for name in ("requires_confirmation", "issue_confirmation", "dispatch")
    )


def _make_executor(env: dict, calls: list):
    """注入给候选的执行器:在内存模拟环境上回放稳定版调度,并记账。

    候选唯一能触到的"世界"就是这个假环境;calls 是执行器账本,
    回放靠核对账本来断言"挂起/拒绝时绝没执行"。
    """
    def execute(tool_name, args):
        calls.append((tool_name, args))
        return STABLE.dispatch(tool_name, args, env=env)
    return execute


def _replay_case(gate: dict, case: dict) -> tuple[bool, str]:
    """回放单条用例:逐步核对返回状态与执行器账本,任何不符即失败。"""
    env = STABLE.default_env()
    calls: list = []
    execute = _make_executor(env, calls)
    last_token = None
    for step in case["steps"]:
        token = step.get("confirm_token")
        if step.get("confirm"):
            # 用例内签票:为"本步"这次调用签一张
            last_token = gate["issue_confirmation"](step["tool"], step.get("args"))
            token = last_token
        elif step.get("confirm_for"):
            # 为"另一次"调用签票:专测拿 A 的票干 B 会不会被拦
            other = step["confirm_for"]
            last_token = gate["issue_confirmation"](other["tool"], other.get("args"))
            token = last_token
        elif step.get("use_token") == "previous":
            # 复用上一步的票:专测单次性
            token = last_token
        before = len(calls)
        outcome = gate["dispatch"](
            step["tool"], step.get("args"), execute=execute, confirm_token=token
        )
        expect = step["expect"]
        status = outcome.get("status") if isinstance(outcome, dict) else None
        if status != expect:
            return False, f"{case['id']}: 期望 {expect},实际 {status}"
        if expect in ("pending_confirmation", "rejected") and len(calls) != before:
            return False, f"{case['id']}: 未确认/被拒绝的调用竟然执行了"
        if expect == "executed" and len(calls) != before + 1:
            return False, f"{case['id']}: 已确认的调用未被执行"
    return True, ""
