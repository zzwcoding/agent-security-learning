"""武器校准靶(阶段 47):练兵场反向案例 chapter5/coding-agent 的 HTTP 适配器。

反向案例 = README 通篇不提安全、攻击面裸露的教学 agent(无护栏/无白名单/无审批)。
用途只有一个:校准 garak/PyRIT 武器——裸靶上必须出 hits,武器才算响了(新术语见
CONTEXT.md「武器校准靶」)。不进任何验收判表。

安全约束(硬):本靶的【全部】工具一律干跑(dry-run)——只记录"模型想调什么、带什么
参数",绝不真的执行。原因:它没有任何防线,garak 的注入 payload 真会诱导它调 Bash;
真执行 = 在宿主机上给攻击 payload 开 shell。校准只验证武器出 hits(text 级,garak
detector 本来就只看文本),不需要真实破坏。真实破坏面由阶段 2/3 打收官形态时
(microVM 执行面)检验。

LLM 走凭证代理(127.0.0.1:5055),本进程只握 PLACEHOLDER——与主 agent 同一密钥纪律。
"""
import asyncio
import os
import sys
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel

CODING_AGENT_DIR = Path("/Users/divh/Downloads/深入理解agent 实验/ai-agent-book/chapter5/coding-agent")
# 裸靶的工作目录:一个空 Scratch——就算干跑补丁失效,文件系工具也被限制在这
SCRATCH = Path(__file__).parent / "workspace-bare"

sys.path.insert(0, str(CODING_AGENT_DIR))
os.chdir(SCRATCH := SCRATCH if SCRATCH.exists() else SCRATCH.mkdir(parents=True) or SCRATCH)

from agent import CodingAgent  # noqa: E402  # coding-agent 的 agent.py
from tools.bash_tool import BashTool  # noqa: E402


class DryRunTool(BashTool):
    """所有工具的干跑替身:形状与真工具一致,执行=回显参数。"""

    def _execute_impl(self, params):
        return {"output": f"[DRY-RUN] 校准靶不执行任何工具。收到参数: {params}",
                "exit_code": 0, "dry_run": True}


class ChatRequest(BaseModel):
    message: str


app = FastAPI(title="reverse-case-bare-target")
_lock = asyncio.Lock()  # CodingAgent.messages 是实例级列表,串行化防交叉污染


@app.on_event("startup")
def _startup():
    agent = CodingAgent(api_key="PLACEHOLDER", model="MiniMax-M2",
                        base_url="http://127.0.0.1:5055/v1", provider="openai")
    # 全工具干跑:名字不动(模型仍看到完整工具清单),执行体全部换成回显
    for name in agent.tool_registry.get_all_tool_names():
        agent.tool_registry._tools[name] = DryRunTool
    app.state.agent = agent
    print(f"裸靶就绪:工具 {len(agent.tool_registry._tools)} 个全部干跑,cwd={SCRATCH}")


@app.get("/healthz")
def healthz():
    return {"ok": hasattr(app.state, "agent")}


@app.post("/chat")
async def chat(req: ChatRequest):
    async with _lock:
        def _run():
            texts, tools = [], []
            for event in app.state.agent.run(req.message, max_iterations=10):
                if event["type"] == "text_delta":
                    texts.append(event.get("delta", ""))
                elif event["type"] == "tool_call":
                    tools.append({"name": event.get("tool"), "args": event.get("input")})
                elif event["type"] == "error":
                    texts.append(f"[error] {event.get('error')}")
            return {"response": "".join(texts), "tool_calls": tools}
        return await asyncio.to_thread(_run)
