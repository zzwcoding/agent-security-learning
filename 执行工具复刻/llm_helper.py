"""二级助手模块:本阶段只有本地语法检查(纯标准库,不调 LLM)。

当前阶段(3)注释:这个文件是"校验层"的家。阶段 6 的事前审批 LLM 也会住进来,
所以名字先叫 llm_helper——但它现在一行 LLM 代码都没有,这是有意的(不超前)。
"""


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
