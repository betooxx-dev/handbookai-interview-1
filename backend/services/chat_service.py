from typing import List

from fastapi import HTTPException
from sqlalchemy.orm import Session

from models import Chat, ChatMember


class ChatService:
    @staticmethod
    def get_user_chats(user_id: int, db: Session) -> List[dict]:
        """Return all chats where the user is a member, including their role."""
        results = (
            db.query(Chat, ChatMember.role)
            .join(ChatMember, ChatMember.chat_id == Chat.id)
            .filter(ChatMember.user_id == user_id)
            .order_by(Chat.updated_at.desc())
            .all()
        )
        chats = []
        for chat, role in results:
            chats.append({
                "id": chat.id,
                "title": chat.title,
                "created_at": chat.created_at,
                "updated_at": chat.updated_at,
                "role": role,
            })
        return chats

    @staticmethod
    def create_chat(user_id: int, title: str, db: Session) -> dict:
        """Create a chat and add the creator as owner in chat_members."""
        new_chat = Chat(title=title)
        db.add(new_chat)
        db.flush()

        member = ChatMember(chat_id=new_chat.id, user_id=user_id, role="owner")
        db.add(member)
        db.commit()
        db.refresh(new_chat)

        return {
            "id": new_chat.id,
            "title": new_chat.title,
            "created_at": new_chat.created_at,
            "updated_at": new_chat.updated_at,
            "role": "owner",
        }

    @staticmethod
    def get_chat(chat_id: int, user_id: int, db: Session) -> Chat:
        """Get a chat if the user is a member."""
        membership = (
            db.query(ChatMember)
            .filter(ChatMember.chat_id == chat_id, ChatMember.user_id == user_id)
            .first()
        )
        if not membership:
            raise HTTPException(status_code=404, detail="Chat not found")

        chat = db.query(Chat).filter(Chat.id == chat_id).first()
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found")
        return chat

    @staticmethod
    def delete_chat(chat_id: int, user_id: int, db: Session) -> dict:
        """Delete a chat. Only the owner can delete."""
        membership = (
            db.query(ChatMember)
            .filter(
                ChatMember.chat_id == chat_id,
                ChatMember.user_id == user_id,
                ChatMember.role == "owner",
            )
            .first()
        )
        if not membership:
            raise HTTPException(
                status_code=403, detail="Only the owner can delete this chat"
            )

        chat = db.query(Chat).filter(Chat.id == chat_id).first()
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found")

        db.delete(chat)
        db.commit()
        return {"message": "Chat deleted successfully"}

    @staticmethod
    def remove_member(chat_id: int, owner_id: int, target_user_id: int, db: Session) -> dict:
        """Remove a collaborator from a chat. Only the owner can do this."""
        # Verify the requester is the owner
        owner_membership = (
            db.query(ChatMember)
            .filter(
                ChatMember.chat_id == chat_id,
                ChatMember.user_id == owner_id,
                ChatMember.role == "owner",
            )
            .first()
        )
        if not owner_membership:
            raise HTTPException(
                status_code=403, detail="Only the owner can remove members"
            )

        # Cannot remove yourself (the owner)
        if owner_id == target_user_id:
            raise HTTPException(
                status_code=400, detail="Owner cannot remove themselves"
            )

        # Find and remove the target member
        target_membership = (
            db.query(ChatMember)
            .filter(
                ChatMember.chat_id == chat_id,
                ChatMember.user_id == target_user_id,
            )
            .first()
        )
        if not target_membership:
            raise HTTPException(status_code=404, detail="Member not found")

        db.delete(target_membership)
        db.commit()
        return {"message": "Member removed successfully"}
