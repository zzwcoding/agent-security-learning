"""起步 Agent —— CLI 入口。

当前阶段(1):骨架 + 回声循环。还没有 LLM、没有工具,
只验证"启动 → 持续读输入 → 干净退出"这条最小链路。
"""
from config import WORKSPACE_DIR

BANNER = "✅ 阶段 1 跑通:项目骨架 + CLI 回声循环(输入 /quit 退出)"


def main() -> None:
    WORKSPACE_DIR.mkdir(exist_ok=True)
    print(BANNER)
    while True:
        try:
            user_input = input("你 > ").strip()
        except (EOFError, KeyboardInterrupt):  # Ctrl+D / Ctrl+C 都干净退出
            print("\n再见")
            break
        if user_input in ("/quit", "/exit"):
            break
        if not user_input:
            continue
        # 还没有 LLM,原样回声,验证 输入→处理→输出 链路是通的
        print(f"Agent > {user_input}")


if __name__ == "__main__":
    main()
