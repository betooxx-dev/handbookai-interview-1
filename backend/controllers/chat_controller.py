from sqlalchemy.orm import Session

from models import User
from schemas import ChatCreate
from services import ChatService


class ChatController:
    @staticmethod
    def get_chats(current_user: User, db: Session):
        return ChatService.get_user_chats(current_user.id, db)

    @staticmethod
    def create_chat(chat: ChatCreate, current_user: User, db: Session):
        return ChatService.create_chat(current_user.id, chat.title, db)

    @staticmethod
    def get_chat(chat_id: int, current_user: User, db: Session):
        return ChatService.get_chat(chat_id, current_user.id, db)

    @staticmethod
    def delete_chat(chat_id: int, current_user: User, db: Session):
        return ChatService.delete_chat(chat_id, current_user.id, db)
