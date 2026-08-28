"""最小聊天壳:没有工具、没有 LangGraph,只为了观察 rail 的行为。

数据流(现在入口、出口各有一道闸机):
  用户键盘输入 → [input 闸机] → LLM 生成回复 → [output 闸机:被拦 → 换成固定拒答] → 打印
两道闸机的判定逻辑全在 config/(config.yml 挂闸、prompts.yml 放清单),本文件只管收发。
"""
from nemoguardrails import LLMRails, RailsConfig

config = RailsConfig.from_path("config")
rails = LLMRails(config)

print("✅ 阶段 3 跑通:input + output 双 rail 已挂上(Ctrl-C 退出)")
while True:
    try:
        user_input = input("\n你> ")
    except EOFError:  # 管道喂消息时 stdin 读完即退出,不刷 traceback
        break
    if not user_input.strip():
        continue
    # 被任一闸机拦下时,返回的都是固定拒答话术 "I'm sorry, I can't respond to that."
    response = rails.generate(messages=[{"role": "user", "content": user_input}])
    print(f"bot> {response['content']}")
