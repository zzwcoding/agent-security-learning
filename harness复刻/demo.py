"""实验 9-7 复刻教学入口:demo 每阶段往前长一步,当前 = 阶段 3 确认门禁本体。

运行:cd harness复刻 && python3 demo.py(纯标准库,无需装依赖)
"""

import json
from pathlib import Path

import confirmation_gate as gate
from evolution import diagnose
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


def main():
    trajectories = load("failure_trajectories.json")

    print("✅ 阶段 1 跑通:缺陷现场")
    stage1_scene(trajectories)

    print("\n✅ 阶段 2 跑通:诊断聚簇 —— 散落的失败立成案")
    stage2_diagnose(trajectories)

    print("\n✅ 阶段 3 跑通:确认门禁本体 —— 高风险先挂起,一次性 token 验票放行")
    stage3_gate()


if __name__ == "__main__":
    main()
