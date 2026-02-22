FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

COPY requirements-runtime.txt .
RUN pip install --no-cache-dir -r requirements-runtime.txt

COPY shared/ ./shared/
RUN pip install --no-cache-dir ./shared

COPY auth_service/ ./auth_service/

ENV PYTHONPATH=/app/auth_service
CMD ["uvicorn", "auth_service.main:app", "--host", "0.0.0.0", "--port", "8001"]
