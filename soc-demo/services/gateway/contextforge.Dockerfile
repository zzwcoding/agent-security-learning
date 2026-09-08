# 票 12 引入、票 26（2026-09-09）起为回退路径：compose 的 services.contextforge 已切
# 官方镜像 ghcr.io/ibm/mcp-context-forge@sha256:98dfab27…（arm64 子 manifest digest，
# 对应 revision 13d5493714861a2d0edb9c6a9702bce106f65711，mcpgateway 1.0.10 + cpex 0.1.3）。
# 本文件不再被 compose 引用；仅当官方镜像不可达/需离线自建时，把 compose 的 image:
# 换回 build: { context: ./services/gateway, dockerfile: contextforge.Dockerfile } 即用。
#
# 历史：票 12 时新仓 ghcr.io/ibm/mcp-contextforge-gateway 匿名令牌直接 DENIED（票 26
# 复核仍是 token 端点 {"code":"DENIED"}、各 tag manifest 403，匿名渠道关闭），当时降级
# 为官方 PyPI 包钉版自建——镜像里只有官方包，不含任何自写代码：插件/配置/ids 一律由
# compose 挂载 /app/plugins 接入（ADR 0001：自写件不动镜像内部，升级=改下面 pip 钉版一行）。
FROM python:3.12-slim

# cpex 与 gateway 同钉（1.0.8 配套 cpex 0.1.3，插件 API 以此为准）
RUN pip install --no-cache-dir mcp-contextforge-gateway==1.0.8 cpex==0.1.3

WORKDIR /app
EXPOSE 4444
CMD ["mcpgateway", "--host", "0.0.0.0", "--port", "4444"]
