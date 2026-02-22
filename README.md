# Enterprise AI Platform

> Microservice-based AI platform with RAG, Memory Layer, and DevSecOps CI pipeline.

## Architecture

```
┌────────────┐     ┌──────────────────────────────────┐
│  Frontend  │────▶│         API Gateway (:8000)       │
│  Next.js   │     │  Auth · Rate Limit · Proxy        │
│   (:3000)  │     └─────────────┬─────────────────────┘
└────────────┘                   │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
     ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
     │ Auth Service  │  │ File Service │  │ LLM Service  │
     │    (:8001)    │  │   (:8002)    │  │   (:8004)    │
     └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
            │                 │                  │
              ▼                  ▼                  ▼
     ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
     │  Monitoring  │  │  RAG Worker  │  │              │
     │   (:8003)    │  │   (:8005)    │  │              │
     └──────────────┘  └──────────────┘  │              │
                                         ▼              │
                              ┌────────────────┐        │
                              │   PostgreSQL   │◀───────┘
                              │   Redis        │
                              │   Qdrant       │
                              │   MinIO        │
                              └────────────────┘
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15, React 19, TypeScript, Tailwind CSS |
| API Gateway | FastAPI, httpx proxy, JWT + API Key auth |
| Auth | FastAPI, bcrypt, JWT (access + refresh), session management |
| File Management | FastAPI, MinIO (S3-compatible), ClamAV virus scan |
| LLM | FastAPI, OpenAI API (GPT-4o), 3-tier Memory Layer |
| RAG | FastAPI, OpenAI Embeddings, Qdrant vector DB |
| Monitoring | FastAPI, Event/Security/LLM usage logging, SSE alerts |
| Database | PostgreSQL 16, SQLAlchemy async |
| Cache | Redis 7 |
| CI/CD | GitHub Actions, gitleaks, Bandit, pip-audit, Trivy, ZAP, cosign |

## Quick Start (Docker)

```bash
# 1. Clone & configure
cp .env.example .env
# Edit .env — set OPENAI_API_KEY

# 2. Launch all services
docker compose up -d --build

# 3. Access
# Frontend:  http://localhost:3000
# API:       http://localhost:8000
# MinIO:     http://localhost:9001 (admin/minioadmin123)
```

**Default Admin Account:**
- Email: `admin@example.com`
- Password: `Admin@123456`

## Quick Start (Local Development)

```bash
# Backend
python -m venv venv && source venv/bin/activate
pip install -r requirements-runtime.txt

# Start infrastructure
docker compose up -d postgres redis qdrant minio

# Start services (each in separate terminal)
uvicorn gateway.gateway.main:app --port 8000 --reload
uvicorn auth_service.auth_service.main:app --port 8001 --reload
uvicorn file_service.file_service.main:app --port 8002 --reload
uvicorn monitoring_service.monitoring_service.main:app --port 8003 --reload
uvicorn llm_service.llm_service.main:app --port 8004 --reload
uvicorn rag_worker.rag_worker.main:app --port 8005 --reload

# Frontend
cd frontend && npm install && npm run dev
```

## Project Structure

```
AI-Platform/
├── gateway/              # API Gateway — auth, routing, rate limiting
├── auth_service/         # Authentication — login, sessions, API keys
├── file_service/         # File Management — upload, view, delete
├── llm_service/          # LLM Chat — RAG, memory, citations, usage
├── rag_worker/           # RAG Pipeline — chunking, embedding, search
├── monitoring_service/   # Monitoring — event/security/LLM logs, alerts
├── shared/               # Shared models, config, DB, security utils
├── frontend/             # Next.js frontend
├── .github/workflows/    # CI/CD pipeline
├── docker-compose.yml    # Container orchestration
├── .env.example          # Environment template
└── requirements-*.txt    # Python dependencies
```

## Features

### Core
- ✅ JWT authentication with session management
- ✅ Protected routes via API Gateway
- ✅ File upload/view (PDF, DOCX, TXT, CSV, XLSX, images)
- ✅ LLM chat with file Q&A and citations
- ✅ Token usage tracking (per message/daily/weekly/monthly)
- ✅ Event, Security, and LLM usage logging

### Advanced
- ✅ RAG pipeline with Qdrant vector database
- ✅ 3-tier Memory Layer (Working/Episodic/Semantic)
- ✅ API Key rotation (create → rotate → finalize → revoke)
- ✅ Docker deployment (Microservice architecture)
- ✅ DevSecOps CI (SAST/SCA/DAST/Container scan/Image signing)
- ✅ OWASP Top 10 security compliance

## Environment Variables

Copy `.env.example` and configure:

| Variable | Description |
|----------|------------|
| `OPENAI_API_KEY` | OpenAI API key (required) |
| `JWT_SECRET` | JWT signing secret |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `MINIO_ENDPOINT` | MinIO endpoint |
| `QDRANT_URL` | Qdrant vector DB URL |

See `.env.example` for full list.

## API Documentation

With services running, access Swagger docs:
- Gateway: http://localhost:8000/docs
- Auth: http://localhost:8001/docs
- File: http://localhost:8002/docs
- Monitoring: http://localhost:8003/docs
- LLM: http://localhost:8004/docs
- RAG: http://localhost:8005/docs

## License

Proprietary — All rights reserved.
