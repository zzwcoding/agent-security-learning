"""实验 9-7 复刻教学入口:demo 每阶段往前长一步,当前 = 阶段 1 缺陷现场。

运行:cd harness复刻 && python3 demo.py(纯标准库,无需装依赖)
"""

import json
from pathlib import Path

from stable.tool_dispatcher import default_env, dispatch

ROOT = Path(__file__).parent


def main():
    # 1) 案卷:读入 11 条失败轨迹,按三类外部信号分组计数
    trajectories = json.loads((ROOT / "failure_trajectories.json").read_text(encoding="utf-8"))
    signals: dict[str, list] = {}
    for t in trajectories:
        signals.setdefault(t["signal"], []).append(t["id"])

    print("✅ 阶段 1 跑通:缺陷现场 —— 高风险调用未经确认直接执行\n")
    print(f"失败轨迹共 {len(trajectories)} 条,信号来源:")
    for signal, ids in signals.items():
        print(f"  - {signal}: {len(ids)} 条")

    # 2) 抽案卷里第一条用户纠正轨迹,看现场记录长什么样
    case = trajectories[0]
    print(f"\n案例 {case['id']}({case['signal']}):")
    print(f"  用户反馈:{case['user_feedback']}")
    print(f"  涉案调用:{case['tool_calls'][0]['tool']} {case['tool_calls'][0]['args']}")

    # 3) 现场重演:同一条缺陷调用,现在再犯一次——看它是否被拦
    env = default_env()
    target = "reports/2026-Q1-draft.docx"
    print(f"\n用稳定版调度器重演:dispatch('delete_file', path={target!r})")
    result = dispatch("delete_file", {"path": target}, env=env)
    print(f"  调度器返回:{result['result']}")
    print(f"  该文件还在环境里吗:{target in env['files']}")
    print("\n结论:删除与读文件一样被直接执行,中间没有任何确认环节——这就是后续阶段要修的缺陷。")


if __name__ == "__main__":
    main()
