import os
from dotenv import load_dotenv

load_dotenv()


class Settings:
    DATABASE_URL: str = os.getenv("DATABASE_URL", "")
    SECRET_KEY: str = os.getenv("SECRET_KEY", "")
    ALGORITHM: str = os.getenv("ALGORITHM", "HS256")
    ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "30"))
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "")

    CORS_ORIGINS: list[str] = [
        "http://localhost:3000",
        "http://frontend:3000",
        "https://handbook-frontend-edku2o-23d9de-192-99-145-226.traefik.me",
        "https://handbook-frontend.zifra.mx"
    ]


settings = Settings()
