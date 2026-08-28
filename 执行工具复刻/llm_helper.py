"""二级助手模块:本地语法检查 + LLM 事前审批。

当前阶段(6)注释:request_approval 住进来了——第二道安检的"法官"。
两个关键设计:① OpenAI 客户端懒创建,第一次审批才连,没 key 就抛异常;
② 审批路上任何出错都按"拒"处理(fail-closed)——这也是 demo 离线能跑的原因。
"""
import json

from config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL

_client = None  # 懒创建:不审批就永远不联网


def _ensure_client():
    global _client
    if _client is None:
        if not (LLM_API_KEY and LLM_BASE_URL and LLM_MODEL):
            raise RuntimeError("缺少 LLM_* 环境变量,无法审批")
        from openai import OpenAI
        _client = OpenAI(api_key=LLM_API_KEY, base_url=LLM_BASE_URL)
    return _client


def _parse_json(text: str) -> dict:
    """模型回复常包在 ```json 围栏里:先剥壳,剥不动就截取第一个 { 到最后一个 }。"""
    text = text.strip()
    if "```" in text:
        text = text.split("```")[1].removeprefix("json").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return json.loads(text[text.index("{"):text.rindex("}") + 1])


def request_approval(operation: str, details: dict):
    """把可疑操作交给独立的二级 LLM 裁决,返回 (是否批准, 理由)。

    和干活的 LLM 可以是同一个模型,但必须是独立的一次调用:
    它只看这次操作本身,不看对话历史——防的就是主对话被注入后"自问自答"。
    """
    try:
        resp = _ensure_client().chat.completions.create(
            model=LLM_MODEL, temperature=0.1,  # 低温度:审批要稳定,不要创意
            messages=[
                {"role": "system", "content": "You are a cautious safety reviewer for an AI agent's tool calls. Reply ONLY in JSON."},
                {"role": "user", "content": (
                    "Review the following operation. Approve only if it is safe and reversible.\n"
                    f"Operation: {operation}\nDetails: {json.dumps(details, ensure_ascii=False)}\n"
                    'Reply JSON: {"approved": bool, "reason": str, "risk_level": "low|medium|high"}'
                )},
            ])
        result = _parse_json(resp.choices[0].message.content)
        return bool(result.get("approved")), str(result.get("reason", ""))
    except Exception as e:
        return False, f"审批失败,按拒绝处理: {e}"  # fail-closed:审不了 = 拒


def verify_code_syntax(code: str, language: str = "python"):
    """只问"语法合法吗",不运行代码。返回 (是否通过, 错误描述)。"""
    if language != "python":
        return True, None  # 其他语言本阶段不查,直接跳过(校验是加分项,不挡路)
    try:
        # compile() 是 Python 自带的"语法专家":把源码编译成代码对象,
        # 但不执行。语法有错它会抛 SyntaxError,还附带出错行号。
        compile(code, "<string>", "exec")
        return True, None
    except SyntaxError as e:
        return False, f"第 {e.lineno} 行: {e.msg}"
