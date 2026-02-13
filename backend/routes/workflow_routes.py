from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database import get_db
from models import User
from schemas import MessageCreate, MessageResponse
from services import AuthService
from controllers import WorkflowController

router = APIRouter(tags=["Workflows"])


@router.post("/chats/{chat_id}/messages", response_model=MessageResponse)
async def create_message(
    chat_id: int,
    message: MessageCreate,
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db),
):
    return WorkflowController.create_message(chat_id, message, current_user, db)


@router.patch("/messages/{message_id}/workflow")
def update_workflow(
    message_id: int,
    workflow_data: dict,
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db),
):
    return WorkflowController.update_workflow(message_id, workflow_data, current_user, db)


@router.get("/chats/{chat_id}/workflows/history")
def get_workflow_history(
    chat_id: int,
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db),
):
    return WorkflowController.get_history(chat_id, current_user, db)


@router.post("/chats/{chat_id}/workflows/undo")
def undo_workflow(
    chat_id: int,
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db),
):
    return WorkflowController.undo(chat_id, current_user, db)
