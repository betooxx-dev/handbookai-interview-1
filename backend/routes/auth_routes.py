from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database import get_db
from models import User
from schemas import UserCreate, UserLogin, UserResponse, Token
from services import AuthService
from controllers import AuthController

router = APIRouter(prefix="/auth", tags=["Auth"])


@router.post("/register", response_model=UserResponse)
def register(user: UserCreate, db: Session = Depends(get_db)):
    return AuthController.register(user, db)


@router.post("/login", response_model=Token)
def login(user: UserLogin, db: Session = Depends(get_db)):
    return AuthController.login(user, db)


@router.get("/me", response_model=UserResponse)
def get_me(current_user: User = Depends(AuthService.get_current_user)):
    return AuthController.get_me(current_user)
