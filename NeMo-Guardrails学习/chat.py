"""最小聊天壳:没有工具、没有 LangGraph,只为了观察 rail 的行为。

数据流(本阶段全程只有这一根链条,无任何护栏):
  用户键盘输入 → messages 列表 → rails.generate() → LLM → 打印回复
LLMRails 的用法和直接调 LLM 几乎一样——区别只在:明天挂上 rail 后,
这个 generate() 内部会多出"自检"环节,而本文件一行都不用改。
"""
from nemoguardrails import LLMRails, RailsConfig

# 从 config/ 目录加载 YAML 配置,组装成运行时对象
config = RailsConfig.from_path("config")
rails = LLMRails(config)

print("✅ 阶段 1 跑通:无 rail 裸跑基线(Ctrl-C 退出)")
while True:
    try:
        user_input = input("\n你> ")
    except EOFError:  # 管道喂消息时 stdin 读完即退出,不刷 traceback
        break
    if not user_input.strip():
        continue
    # generate 的出入参格式与 OpenAI Chat Completions 一致
    response = rails.generate(messages=[{"role": "user", "content": user_input}])
    print(f"bot> {response['content']}")
