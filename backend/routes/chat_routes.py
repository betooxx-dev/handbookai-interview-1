from typing import List

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database import get_db
from models import User
from schemas import ChatCreate, ChatResponse, ChatWithMessages
from services import AuthService
from controllers import ChatController

router = APIRouter(prefix="/chats", tags=["Chats"])


@router.get("", response_model=List[ChatResponse])
def get_chats(
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db),
):
    return ChatController.get_chats(current_user, db)


@router.post("", response_model=ChatResponse)
def create_chat(
    chat: ChatCreate,
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db),
):
    return ChatController.create_chat(chat, current_user, db)


@router.get("/{chat_id}", response_model=ChatWithMessages)
def get_chat(
    chat_id: int,
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db),
):
    return ChatController.get_chat(chat_id, current_user, db)


@router.delete("/{chat_id}")
def delete_chat(
    chat_id: int,
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db),
):
    return ChatController.delete_chat(chat_id, current_user, db)
