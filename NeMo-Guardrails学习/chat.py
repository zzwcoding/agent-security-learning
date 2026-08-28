"""最小聊天壳:没有工具、没有 LangGraph,只为了观察 rail 的行为。

数据流(本阶段在入口处多了一道闸机):
  用户键盘输入 → [self check input 闸机:被拦 → 直接拒答,LLM 主流程不启动]
               → 放行 → LLM 生成回复 → 打印
闸机的判定逻辑不在本文件,全在 config/config.yml(rails 段)+ config/prompts.yml(安检清单)里。
"""
from nemoguardrails import LLMRails, RailsConfig

config = RailsConfig.from_path("config")
rails = LLMRails(config)

print("✅ 阶段 2 跑通:self-check input rail 已挂上(Ctrl-C 退出)")
while True:
    try:
        user_input = input("\n你> ")
    except EOFError:  # 管道喂消息时 stdin 读完即退出,不刷 traceback
        break
    if not user_input.strip():
        continue
    # 被 input rail 拦下时,返回的是固定拒答话术 "I'm sorry, I can't respond to that."
    response = rails.generate(messages=[{"role": "user", "content": user_input}])
    print(f"bot> {response['content']}")
