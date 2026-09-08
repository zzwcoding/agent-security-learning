FROM python:3.12-slim
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# gateway 自写件三块：薄装配层 + 铸票（票 06 mint.py）+ 凭证代理（票 08 proxy.py）。
# modules.md §2 拍板：三容器并排，自写件不动镜像内部——本镜像只装自己的三份代码
# （contextforge/openfga 官方镜像接入是票 12 的活，与本镜像并排、互不掺和）。
COPY app.py mint.py proxy.py ./
EXPOSE 8002
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8002"]
