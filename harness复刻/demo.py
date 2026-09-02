"""实验 9-7 复刻教学入口:demo 每阶段往前长一步,当前 = 阶段 6 隔离回放引擎。

运行:cd harness复刻 && python3 demo.py(纯标准库,无需装依赖)
"""

import json
from pathlib import Path

import confirmation_gate as gate
from evolution import (
    _load_gate,
    _make_executor,
    _replay_case,
    diagnose,
    generate_candidate,
    validate_candidate,
)
from stable.tool_dispatcher import default_env, dispatch

ROOT = Path(__file__).parent


def load(name):
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def stage1_scene(trajectories):
    """缺陷现场:三类信号计数 + 重演一次未确认删除。"""
    signals: dict[str, list] = {}
    for t in trajectories:
        signals.setdefault(t["signal"], []).append(t["id"])
    print(f"案卷 {len(trajectories)} 条:" + ", ".join(
        f"{s} {len(ids)} 条" for s, ids in signals.items()))
    case = trajectories[0]
    print(f"典型案例 {case['id']}:{case['tool_calls'][0]['tool']} → 用户说:{case['user_feedback']}")
    env = default_env()
    target = "reports/2026-Q1-draft.docx"
    result = dispatch("delete_file", {"path": target}, env=env)
    print(f"现场重演:{result['result']},文件还在吗:{target in env['files']}"
          f" ← 中间没有任何确认环节,这就是缺陷")


def stage2_diagnose(trajectories):
    """把散落的失败聚成失败簇:跨轨迹支持度 ≥2 才立案。"""
    d = diagnose(trajectories)
    print(f"立案:{d['change_required']} → 目标 {d['target']}({d['target_component']})")
    for p in d["patterns"]:
        print(f"  失败簇 {p['cluster_id']}:支持度 {p['cross_trajectory_support']},"
              f"信号 {'/'.join(p['signals'])}")
    print("  正确排除:0723 rm -rf 仅 1 条未达门槛;0725 已确认删除是对照轨迹;"
          "0724 周报措辞点踩属低风险质量反馈")
    print(f"  立案理由:{d['reason'][:36]}……")


def stage3_gate():
    """门禁三岔路口:低风险直行、无票挂起、验票放行、复用票拒绝。"""
    env = default_env()
    calls = []

    def execute(name, args):
        """注入给门禁的执行器:记录调用次数,在内存环境上真执行。"""
        calls.append(name)
        return dispatch(name, args, env=env)

    print(f"⓪ 低风险直行:read_file → {gate.dispatch('read_file', {'path': 'notes/todo.md'}, execute=execute)['status']}")

    target = "notes/todo.md"
    before = len(calls)
    out = gate.dispatch("delete_file", {"path": target}, execute=execute)
    print(f"① 无票删 {target}:→ {out['status']}({out['reason']}),"
          f"执行器调用 {before}→{len(calls)},文件还在:{target in env['files']}")

    token = gate.issue_confirmation("delete_file", {"path": target})
    before = len(calls)
    out = gate.dispatch("delete_file", {"path": target}, execute=execute, confirm_token=token)
    print(f"② 签票后重删:→ {out['status']},执行器调用 {before}→{len(calls)},文件还在:{target in env['files']}")

    before = len(calls)
    out = gate.dispatch("delete_file", {"path": "tmp/cache-0417.tmp"}, execute=execute, confirm_token=token)
    print(f"③ 复用旧票删缓存文件:→ {out['status']}({out['reason']}),"
          f"执行器调用 {before}→{len(calls)},缓存文件还在:{'tmp/cache-0417.tmp' in env['files']}")


def stage4_proposal(trajectories):
    """把手写门禁打包成提案:代码 diff + 接入 diff + SHA 锚定。"""
    stable_source = (ROOT / "stable" / "tool_dispatcher.py").read_text(encoding="utf-8")
    candidate = generate_candidate(stable_source, diagnose(trajectories))
    print(f"提案文件:{candidate['module']} | 源码指纹 {candidate['source_sha256'][:12]}"
          f" | 新增 {candidate['patch_size']['added_lines']} 行 | 生成方式:"
          f"{candidate['generator_metadata']['generator']}(0 次 API 调用)")
    print("证据溯源(每条支撑轨迹一个哈希,改一个字都对不上):")
    for s in diagnose(trajectories)["source_trajectories"][:3]:
        print(f"  - {s['id']}({s['signal']}) {s['trajectory_sha256'][:12]}…  共 9 条")
    print("接入 diff(提案,不落盘——stable/ 在发布前纹丝不动):")
    print("\n".join(f"   {line}" for line in candidate["integration_diff"].splitlines()))


def stage5_static():
    """静态闸:不运行候选,只体检文本——超限/编译/导入白名单/禁危险内建。"""
    good = (ROOT / "confirmation_gate.py").read_text(encoding="utf-8")
    checks = validate_candidate(good)
    print(f"我们的门禁:通过 {[k for k, v in checks.items() if v]}")
    for name, src in [
        ("坏提案·语法残废", good.replace('VERSION = "1.1.0-candidate"', 'VERSION = "1.1.0-candidate"\ndef broken(:', 1)),
        ("坏提案·偷带 import os", good + "\nimport os  # 白名单外的模块\n"),
        ("坏提案·藏一个 eval", good + "\npreview = eval('1+1')  # 动态执行\n"),
    ]:
        c = validate_candidate(src)
        where = "静态编译" if not c["static_compile"] else "安全扫描"
        print(f"{name}:通过 {[k for k, v in c.items() if v]} ← 卡在{where}")


def stage6_replay():
    """隔离回放:候选源码加载进干净命名空间,注入记账执行器,在假世界上跑。"""
    good = (ROOT / "confirmation_gate.py").read_text(encoding="utf-8")
    checks = validate_candidate(good)
    print(f"我们的门禁:通过 {[k for k in list(checks)[:3] if checks[k]]}(契约检查 ✓)")

    headless = good.replace("def issue_confirmation(", "def issue_confirmation_gone(", 1)
    c = validate_candidate(headless)
    print(f"缺签票函数的提案:通过 {[k for k, v in c.items() if v]} ← 卡在契约检查")

    # 手工走一步:受检对象是从源码文本加载的命名空间,不是 import 的模块
    ns = _load_gate(good)
    env = default_env()
    calls: list = []
    execute = _make_executor(env, calls)
    token = ns["issue_confirmation"]("delete_file", {"path": "notes/todo.md"})
    before = len(calls)
    out = ns["dispatch"]("delete_file", {"path": "notes/todo.md"}, execute=execute)
    print(f"回放·无票:→ {out['status']},执行器调用 {before}→{len(calls)}")
    before = len(calls)
    out = ns["dispatch"]("delete_file", {"path": "notes/todo.md"}, execute=execute, confirm_token=token)
    print(f"回放·持票:→ {out['status']},执行器调用 {before}→{len(calls)},文件还在:{'notes/todo.md' in env['files']}")

    cases = [
        {"id": "hand-伪造票", "steps": [
            {"tool": "delete_file", "args": {"path": "notes/todo.md"},
             "confirm_token": "forged-token-123", "expect": "rejected"}]},
        {"id": "hand-拿A票干B", "steps": [
            {"tool": "delete_file", "args": {"path": "notes/todo.md"},
             "confirm_for": {"tool": "delete_file", "args": {"path": "tmp/cache-0417.tmp"}},
             "expect": "rejected"}]},
    ]
    for case in cases:
        ok, detail = _replay_case(ns, case)
        print(f"回放·{case['id']}:{'✓' if ok else f'✗ {detail}'}")


def main():
    trajectories = load("failure_trajectories.json")

    print("✅ 阶段 1 跑通:缺陷现场")
    stage1_scene(trajectories)

    print("\n✅ 阶段 2 跑通:诊断聚簇 —— 散落的失败立成案")
    stage2_diagnose(trajectories)

    print("\n✅ 阶段 3 跑通:确认门禁本体 —— 高风险先挂起,一次性 token 验票放行")
    stage3_gate()

    print("\n✅ 阶段 4 跑通:提案打包 —— 门禁源码变成可评审的建议书")
    stage4_proposal(trajectories)

    print("\n✅ 阶段 5 跑通:静态闸 —— 不执行源码的体检")
    stage5_static()

    print("\n✅ 阶段 6 跑通:隔离回放引擎 —— 候选在假世界上跑,执行器有账本")
    stage6_replay()


if __name__ == "__main__":
    main()
