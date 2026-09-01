"""自造样本集(阶段 1):模拟 Agent 运行时最容易泄露敏感信息的日志场景。

三类样本从第一天起就并存:
- 密钥类:Agent 日志最高频泄露——工具调用头、连接串、CI 日志、配置转储;
- PII 类:个人信息——客服对话、工具响应、支付日志(与主线 memory_guard 同款场景);
- 负例:看起来像、其实不是。没有它们,规则会"宁滥勿缺"地脱敏过度,
  而日志脱过头就毁了调试价值——所以防误报考题和防漏报样本同天生。

注意:所有密钥/卡号/证件号均为虚构假值,且拆成字符串拼接构造,
避免本仓库被密钥扫描工具误伤(也是"样本文件本身别变成泄露源"的纪律)。
"""

SK_KEY = "sk" + "-proj-ABCD1234efgh5678IJKL9012mnop3456"
JWT_TOKEN = (
    "ey" + "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
    ".eyJzdWIiOiJhZ2VudC0wMDcifQ"
    ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
)
GH_TOKEN = "gh" + "p_16C7e42F292c6912E7710c838347Ae178B4a"
SLACK_TOKEN = "xo" + "xb-24FAKEtoken000000000000000000000001"
AWS_KEY = "AK" + "IAIOSFODNN7EXAMPLE"

# 每条:(样本名, 分类, 日志原文)。分类是复刻自造字段——阶段 1 打印用,
# 阶段 10 campaign 的 gold 标注也按它组织。
SAMPLES = [
    (
        "工具调用日志:请求头带令牌",
        "密钥类",
        f"""[2026-08-31 09:14:22] TOOL_CALL http_request
  url: https://api.example.com/v1/customers/8842
  headers: {{"Authorization": "Bearer {SK_KEY}", "X-Request-Id": "req-42"}}""",
    ),
    (
        "数据库连接报错:连接串与云密钥",
        "密钥类",
        f"""[ERROR] db.connect failed after 3 retries
  dsn: postgres://admin:S3cr3t_P4ssw0rd@db.internal:5432/prod
  fallback_config: {{"aws_access_key_id": "{AWS_KEY}"}}""",
    ),
    (
        "CI/CD 部署日志:平台令牌",
        "密钥类",
        f"""Cloning into 'service-repo'...
  remote: using deploy token {GH_TOKEN}
  Slack notify token: {SLACK_TOKEN}""",
    ),
    (
        "配置转储:JWT 与私钥",
        "密钥类",
        f"""[DEBUG] dumping runtime config
  session_jwt: {JWT_TOKEN}
  service_account_key: -----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA7QwZbq3vX9kLmN0pQrStUvWxYz1234567890abcdef
QIDAQAB
-----END RSA PRIVATE KEY-----""",
    ),
    (
        "客服对话:证件与手机号",
        "PII类",
        """USER: 你好，我要办理报销，身份证号是 11010519491231002X，手机号 13800138000。
ASSISTANT: 好的，已收到您的报销申请，请留意后续短信通知。""",
    ),
    (
        "工具响应:CRM 查询回显",
        "PII类",
        """TOOL_RESULT crm_lookup
  {"name": "王小明", "email": "xiaoming.wang@example.com", "phone": "13698765432"}""",
    ),
    (
        "支付日志:银行卡与社保号",
        "PII类",
        """[PAYMENT] order 20260831-0042 charged
  card: 4111 1111 1111 1111
  holder_ssn: 123-45-6789""",
    ),
    (
        "性能指标:纳秒延迟(手机号陷阱)",
        "负例",
        """[2026-08-31 10:02:11] METRICS tool_call
  latency_ns=13800138000 tokens=842 retry=0""",
    ),
    (
        "校验器告警:口令规范语言(口令陷阱)",
        "负例",
        """[2026-08-31 10:05:40] VALIDATOR config_check
  rule: password field must contain at least 12 characters
  note: never log a user's real password""",
    ),
    (
        "普通业务日志:完全干净(基线)",
        "负例",
        """[2026-08-31 10:08:03] ORDER created
  order_id=20260831-0043 sku=XR-7003 qty=1 warehouse=华北-1
  eta=2026-09-02""",
    ),
]
