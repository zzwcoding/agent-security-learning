FROM python:3.12-slim
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 票 24：修复票 08 记录过的隐患——原来只 COPY app.py，漏掉引擎模块
# （injection_scan.py / pii.py），容器一启动就 ModuleNotFoundError
COPY app.py injection_scan.py pii.py .
EXPOSE 8001
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001"]
