FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

COPY requirements-runtime.txt .
COPY llm_service/requirements.txt ./llm_service/requirements.txt
RUN pip install --no-cache-dir -r llm_service/requirements.txt

COPY shared/ ./shared/
RUN pip install --no-cache-dir ./shared

COPY llm_service/ ./llm_service/

ENV PYTHONPATH=/app/llm_service
CMD ["uvicorn", "llm_service.main:app", "--host", "0.0.0.0", "--port", "8004"]
