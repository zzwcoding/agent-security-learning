"""起步 Agent —— CLI 入口。

当前阶段(2):接入 LLM 单轮问答。每轮只发 系统提示+本轮输入 两条消息,
模型看不到之前聊过什么;工具调用是后面阶段的事。
"""
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, WORKSPACE_DIR

BANNER = "✅ 阶段 2 跑通:LLM 单轮问答(输入 /quit 退出)"

SYSTEM_PROMPT = "你是一个简洁的中文助手。"


def main() -> None:
    if not (LLM_BASE_URL and LLM_API_KEY and LLM_MODEL):
        raise SystemExit("缺少 LLM_* 环境变量:请用 scripts/run-with-keychain.sh 启动")
    WORKSPACE_DIR.mkdir(exist_ok=True)
    # OpenAI 兼容客户端:base_url 指向哪家供应商,请求就发给哪家
    llm = ChatOpenAI(base_url=LLM_BASE_URL, api_key=LLM_API_KEY, model=LLM_MODEL)
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
        # 单轮:每条消息列表都是新构造的,不带历史
        reply = llm.invoke([SystemMessage(SYSTEM_PROMPT), HumanMessage(user_input)])
        print(f"Agent > {reply.content}")


if __name__ == "__main__":
    main()
