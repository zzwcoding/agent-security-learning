# 0024 Presidio 记忆落库脱敏 —— 知识卡片

### Presidio 脱敏引擎(Microsoft Presidio:Analyzer + Anonymizer)

是什么:Presidio 是微软开源的 PII(Personally Identifiable Information,个人身份信息——手机号、邮箱、身份证号这类能定位到具体个人的数据)识别与匿名化引擎,分两段工作。Analyzer 负责"找":官方定义是"检测文本中 PII 实体的服务"——跑一组识别器(PII Recognizer),各用不同机制认一种或几种 PII,三路:命名实体识别(NER,统计模型认人名)、内建正则(格式固定的邮箱/卡号)、自定义正则。Anonymizer 负责"换":按操作符(operator)把每个命中换成指定值,默认 replace、默认值是 `<EMAIL_ADDRESS>` 这种实体类型占位符,原文换掉就没了。内置操作符有 replace/redact(抹掉)/hash(哈希)/mask(打码)/encrypt(加密)/keep/custom 七类常用项,另有专供 Azure 医疗场景的 surrogate_ahds。官方 Deanonymizer(还原器)内置的 decrypt 操作符,只能还原 Anonymizer 用 encrypt 加密的内容。另有 ContextAwareEnhancer(上下文增强器)用命中词周边的上下文词(如"手机号"三个字)抬高识别置信度。

解决什么问题:Agent 的长期记忆文件(memory.json 这类落盘 JSON)往往是全系统唯一真实持久化的数据资产。密钥撤走之后,用户随口说出的手机号邮箱仍会被 Agent 原样记进对话历史并写上磁盘,下次启动还会回灌进上下文。落盘前过一遍 Analyzer+Anonymizer,PII 就变成了占位符。

我们的办法:记忆写盘前先过一遍 Presidio。实测问"13800138000 加 1 等于几",模型答 `13800138000 + 1 = 13800138001`,退出落盘时 6 处数字被替换成 `<CN_PHONE>`,11 位原文 0 处残留。

### 出口消毒[自造](sanitize at the persistence exit)

是什么:出口消毒(sanitize at the persistence exit,自造词,官方没有对应概念)指脱敏检查只卡在"数据即将被持久化"的出口动作上,不碰对话过程。它对应数据安全的标准区分 data at rest(静态保存的数据)与 data in use(正在被使用的数据):当轮对话里模型该看到的照旧(上下文完整,属 data in use),落盘的才是消毒后的副本(属 data at rest)。管道形状是:进程退出时,记忆导出函数取到全部消息,先经脱敏函数处理,再写入磁盘;下次启动读回的历史是干净的。

解决什么问题:PII 本身不是攻击,拦在对话入口会误伤正常用户——实测输入侧的注入护栏[自造](拦在 Agent 输入/输出路径上的检查点)连"请记住我的联系方式"这句无害请求都会误杀。该拦的不是"说",而是"敏感数据写盘"这个不可逆动作:脏数据落不了盘,就永远不会跨会话存活、跨会话回灌。

我们的对策:脱敏点选出口而不是入口,每条数据在被持久化前必过一道检查——实测一段混合中英文文本进去,邮箱/手机号/卡号/IP 全被换成占位符。入口护栏的误报与出口消毒的兜底各挡一头,两层防线互相补位正是纵深防御(defense in depth)的常态,不是设计失误。NIST 的完整定义是"整合人员、技术与运营能力,在组织多个层级间布设可变屏障的信息安全策略"。

### 中文 PII 自定义识别器(PatternRecognizer)

是什么:PatternRecognizer 是 Presidio 官方提供的自定义接口。官方口径:PatternRecognizer 支持基于正则或 deny-list(拒绝词表)的识别逻辑。一份 patterns(正则)或一份词表加一个实体类型名,就是一个新 PII 识别器。为什么必须自己写:Presidio 的 NER 模型与内建正则默认英文向,中国场景的高频 PII——手机号、身份证号——它认不出来。

解决什么问题:引入框架不等于覆盖需求;识别器清单就是治理清单——登记了哪些 PII 类型,决定了哪些数据会被脱敏,漏登记就漏保护。官方给的登记途径不止一条:一是经 RecognizerRegistry(识别器注册表)add_recognizer 后重建 AnalyzerEngine,或直接挂到现有 registry。二是单次请求临时挂 ad-hoc recognizer(临时识别器)。三是 YAML 文件批量加载(add_recognizers_from_yaml),这是"识别器清单就是治理清单"的官方实现。四是继承 EntityRecognizer 写带 validation(校验逻辑,如银行卡 Luhn 校验位,即模 10 加权校验算法)的子类。例如 11 位手机号配 `1[3-9]\d{9}` 号段正则,18 位身份证配出生日期加校验位的结构,识别后分别替换为 `<CN_PHONE>`、`<CN_ID>`。

我们的办法:给 Analyzer 注册手机号与身份证两个 PatternRecognizer,实测一段混合中英文文本里 `13812345678` 和 `110101199003074258` 都被识别替换;邮箱/卡号/IP 内建已覆盖,没有重复造轮子。

### 令牌化与格式保留加密(tokenization / FPE)

是什么:tokenization(令牌化)与 FPE(format-preserving encryption,格式保留加密)是"脱敏后仍可还原"的两个代表,但按 PCI(支付卡行业安全标准)的严格口径,tokenization 对云端与下游是不可逆的——还原只发生在本地金库、并非数学可逆。tokenization 把真值换成随机令牌(如 `TOK-7f3a`),"令牌→真值"的映射存进 token vault(令牌金库的官方术语),PCI 要求金库隔离部署、密钥独立管理。数据进金库即进信任边界(安全上划定的"数据可信范围",越界即回到不信任区域),金库只放本地信任域。FPE 是 NIST SP 800-38G 标准化的另一条路(FF1/FF3 两种模式,都建在标准对称分组密码上):用密钥直接把真值加密成同格式的密文——令牌长得像手机号,下游系统完全无感。两者还原机制不同:tokenization 靠查金库,FPE 靠密钥解密。

解决什么问题:与 Anonymizer 默认 replace 的不可逆脱敏相对——replace 换掉就没了,适合"落盘存档";生产中还有一类需求是"数据脱敏上云处理、响应再还原",只有这类"对下游不可逆、仅本地可还原"的方案能做。要点:泄露出去的只是令牌/密文,还原手段(金库、密钥)永不出本地;代价是云端推理全程在假数据上进行,依赖任务本身可令牌化。

数据流一例:`13812345678` → tokenize 成 `TOK-7f3a`(映射进本地金库)→ 云端只见 `TOK-7f3a` → 响应引用令牌时本地 detokenize 还原为真值。
