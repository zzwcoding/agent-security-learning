"""规则边界回归(阶段 5):每条测试锁一个"曾经差点写错"的边界。

规则是资产也是负债——18 条正则任何一条被后人"优化"误伤,这里立刻变红。
运行:.venv/bin/python -m pytest tests/ -v(纯离线,不碰网络与模型)
"""
from regex_sanitizer import sanitize

PEM_BEGIN = "-----BEGIN " + "RSA PRIVATE KEY-----\n"
PEM_END = "-----END " + "RSA PRIVATE KEY-----"


def test_truncated_pem_redacts_to_eof():
    """日志被 rotate 切断:BEGIN 有而 END 丢了,私钥也必须脱到文件尾,不能泄。"""
    blob = PEM_BEGIN + "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF6PZGFw7\nmore-material"
    text, hits = sanitize(f"key dump:\n{blob}\n")
    assert "MIIEowIBAAKCAQEA" not in text and "[REDACTED_PRIVATE_KEY]" in text
    assert any(h["category"] == "private_key" for h in hits)


def test_plain_begin_word_untouched():
    """普通英文里出现 BEGIN 一词,与 PEM 无关,原样放行。"""
    prose = "no secrets here, only BEGIN of a story"
    text, hits = sanitize(prose)
    assert text == prose and hits == []


def test_quoted_secret_with_spaces():
    """引号口令含空格也要整值脱掉——.{4,} 的空格不能成为逃逸口。"""
    text, hits = sanitize('password="hunter 2 with spaces"')
    assert "hunter" not in text and "spaces" not in text
    assert any(h["category"] == "secret_assignment" and h["value"] == "hunter 2 with spaces"
               for h in hits)


def test_basic_auth_redacted_prose_and_challenge_not():
    """Authorization: Basic <blob> 要脱;普通英文 Basic 和挑战头 WWW-Authenticate 不脱。"""
    cred = "dXNlcjpwYXNzd29yZA=="
    text, hits = sanitize(f"Authorization: Basic {cred}")
    assert cred not in text and any(h["category"] == "basic_auth" for h in hits)

    prose = "Basic knowledge of Python is required."
    assert sanitize(prose) == (prose, [])

    challenge = 'WWW-Authenticate: Basic realm="api"'
    assert sanitize(challenge) == (challenge, [])  # 挑战头只是声明方案,不带凭据


def test_validators_cut_fake_card_and_id():
    """校验器第二道闸:假卡号/假证件号放行,真格式才脱。"""
    assert sanitize("card: 4111 1111 1111 1112")[1] == []
    assert sanitize("card: 4111 1111 1111 1111")[1][0]["category"] == "credit_card"
    assert sanitize("id 11010119900307721X")[1] == []
    assert sanitize("id 11010519491231002X")[1][0]["category"] == "cn_id_card"


def test_negative_prose_and_clean_log_stay_clean():
    """考卷负例中"必须干净"的两条;纳秒延迟那条是已知误报,归阶段 10 量化,不进这里。"""
    assert sanitize("The password field must contain at least 12 characters")[1] == []
    assert sanitize("order_id=20260831-0043 sku=XR-7003 eta=2026-09-02")[1] == []


def test_lookaround_no_inner_phone():
    """环视断言:长数字串不得从中间截出手机号。"""
    assert sanitize("code=9138001380009")[1] == []
