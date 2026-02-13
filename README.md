# Workflow AI Assistant

> **Technical Test** — This project is a code challenge based on an [original repository](https://github.com/AIPlaybookHQ/EngineerInterview1) provided as a starting point. The codebase has been refactored and improved as part of the evaluation process.

A full-stack application that helps companies design and visualize process workflows using AI, built with FastAPI, Next.js, MySQL, and OpenAI's API.

## Features

- **User Authentication**: Secure login and registration system with JWT tokens
- **AI-Powered Chatbot**: Interactive chat interface using OpenAI's GPT to help design workflows
- **Workflow Visualization**: Automatically generates and displays workflow flowcharts with zoom and pan capabilities
- **Chat History**: Persistent conversation storage with the ability to create, view, and delete chats across sessions
- **Responsive Layout**: Chat list sidebar, chatbot interface, and workflow visualization panel

## Tech Stack

### Backend

- **FastAPI** — REST API framework
- **SQLAlchemy** — ORM and database toolkit
- **MySQL 8.0** — Relational database
- **OpenAI API** — AI-powered workflow generation
- **JWT** — Secure authentication

### Frontend

- **Next.js 14** — React framework with App Router
- **TypeScript** — Type-safe JavaScript
- **ReactFlow** — Visual workflow rendering
- **Zustand** — State management
- **Axios** — HTTP client

## Project Structure

```
├── backend/
│   ├── main.py                # App factory (~35 lines)
│   ├── config.py              # Centralized settings
│   ├── database.py            # DB engine and session
│   ├── models/                # SQLAlchemy models (User, Chat, Message)
│   ├── schemas/               # Pydantic schemas (auth, chat)
│   ├── services/              # Business logic (AuthService, ChatService, WorkflowService)
│   ├── controllers/           # Request handlers
│   ├── routes/                # API route definitions
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   └── src/
│       ├── types/             # TypeScript interfaces
│       ├── services/          # API client and service modules
│       ├── store/             # Zustand stores
│       ├── components/        # React components (folder-per-component)
│       ├── styles/            # Global styles
│       └── app/               # Next.js App Router pages
├── docker-compose.yml
└── CHANGELOG.md               # Modification tracking
```

## Getting Started

### Prerequisites

- Docker and Docker Compose (recommended)
- OR manually: Python 3.11+, Node.js 18+, MySQL 8.0+

### Docker Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/betooxx-dev/handbookai-interview-1.git
   cd handbookai-interview-1
   ```

2. **Set up environment variables**

   Create `backend/.env`:

   ```env
   DATABASE_URL=mysql+pymysql://root:password@db:3306/handbook_db
   SECRET_KEY=your-secret-key-here
   ALGORITHM=HS256
   ACCESS_TOKEN_EXPIRE_MINUTES=30
   OPENAI_API_KEY=your-openai-api-key
   ```

   Create `frontend/.env`:

   ```env
   NEXT_PUBLIC_API_URL=http://localhost:8000
   ```

3. **Start the application**

   ```bash
   docker compose up --build
   ```

4. **Access the application**
   - Frontend: http://localhost:3000
   - Backend API: http://localhost:8000
   - API Docs (Swagger): http://localhost:8000/docs

## API Endpoints

### Authentication

| Method | Endpoint         | Description                |
| ------ | ---------------- | -------------------------- |
| POST   | `/auth/register` | Register a new user        |
| POST   | `/auth/login`    | Login and get access token |
| GET    | `/auth/me`       | Get current user info      |

### Chats

| Method | Endpoint           | Description            |
| ------ | ------------------ | ---------------------- |
| GET    | `/chats`           | Get all user's chats   |
| POST   | `/chats`           | Create a new chat      |
| GET    | `/chats/{chat_id}` | Get chat with messages |
| DELETE | `/chats/{chat_id}` | Delete a chat          |

### Workflows

| Method | Endpoint                             | Description                      |
| ------ | ------------------------------------ | -------------------------------- |
| POST   | `/chats/{chat_id}/messages`          | Send message and get AI response |
| PATCH  | `/messages/{message_id}/workflow`    | Update workflow positions        |
| GET    | `/chats/{chat_id}/workflows/history` | Get workflow history             |
| POST   | `/chats/{chat_id}/workflows/undo`    | Undo last workflow change        |
