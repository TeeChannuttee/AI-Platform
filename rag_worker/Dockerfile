FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y curl tesseract-ocr && rm -rf /var/lib/apt/lists/*

COPY requirements-runtime.txt .
COPY rag_worker/requirements.txt ./rag_worker/requirements.txt
RUN pip install --no-cache-dir -r rag_worker/requirements.txt

COPY shared/ ./shared/
RUN pip install --no-cache-dir ./shared

COPY rag_worker/ ./rag_worker/

ENV PYTHONPATH=/app/rag_worker
CMD ["uvicorn", "rag_worker.main:app", "--host", "0.0.0.0", "--port", "8003"]
