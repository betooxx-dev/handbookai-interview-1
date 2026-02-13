from typing import List

from fastapi import HTTPException
from sqlalchemy.orm import Session

from models import Chat


class ChatService:
    @staticmethod
    def get_user_chats(user_id: int, db: Session) -> List[Chat]:
        return (
            db.query(Chat)
            .filter(Chat.user_id == user_id)
            .order_by(Chat.updated_at.desc())
            .all()
        )

    @staticmethod
    def create_chat(user_id: int, title: str, db: Session) -> Chat:
        new_chat = Chat(user_id=user_id, title=title)
        db.add(new_chat)
        db.commit()
        db.refresh(new_chat)
        return new_chat

    @staticmethod
    def get_chat(chat_id: int, user_id: int, db: Session) -> Chat:
        chat = db.query(Chat).filter(Chat.id == chat_id, Chat.user_id == user_id).first()
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found")
        return chat

    @staticmethod
    def delete_chat(chat_id: int, user_id: int, db: Session) -> dict:
        chat = ChatService.get_chat(chat_id, user_id, db)
        db.delete(chat)
        db.commit()
        return {"message": "Chat deleted successfully"}
