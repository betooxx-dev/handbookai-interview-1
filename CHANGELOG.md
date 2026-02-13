# Changelog

All notable modifications to this project are documented here.

## [2026-02-13] — Architecture Refactor

### Backend

Refactored the monolithic `main.py` (517 lines) into a clean, modular architecture (~35 lines):

| Layer          | Files | Purpose                                                          |
| -------------- | ----- | ---------------------------------------------------------------- |
| `config.py`    | 1     | Centralized environment variable loading via `pydantic-settings` |
| `database.py`  | 1     | DB engine, session factory, `get_db()`, `init_db()`              |
| `models/`      | 3     | SQLAlchemy models: `User`, `Chat`, `Message`                     |
| `schemas/`     | 2     | Pydantic request/response schemas (auth, chat)                   |
| `services/`    | 3     | Business logic: `AuthService`, `ChatService`, `WorkflowService`  |
| `controllers/` | 3     | Thin request handlers delegating to services                     |
| `routes/`      | 3     | `APIRouter` definitions with prefixes and tags                   |

**Deleted**: `auth.py`, `schemas.py` (replaced by packages).

### Frontend

Restructured flat component files into a modular architecture:

```
src/
├── types/index.ts                ← All TypeScript interfaces
├── services/
│   ├── api.ts                    ← Axios instance + interceptor
│   ├── auth.service.ts           ← Auth API methods
│   └── chat.service.ts           ← Chat/workflow API methods
├── store/auth.store.ts           ← Zustand auth store
├── components/
│   ├── index.ts                  ← Barrel file re-exporting all components
│   ├── AuthForm/AuthForm.tsx + styles.module.css
│   ├── ChatList/ChatList.tsx + styles.module.css
│   ├── ChatWindow/ChatWindow.tsx + styles.module.css
│   └── WorkflowVisualization/WorkflowVisualization.tsx + styles.module.css
└── app/page.tsx                  ← Updated imports
```

**Deleted**: `lib/` folder, flat component files.

### Docker & Deployment

- Optimized backend and frontend Dockerfiles with multi-stage builds and non-root users.
- Added health checks to both containers.
- Configured `NEXT_PUBLIC_API_URL` as a build argument for Dokploy deployment.
- Added production CORS origins for Dokploy domains.
