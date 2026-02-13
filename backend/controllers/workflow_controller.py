from sqlalchemy.orm import Session

from models import User
from schemas import MessageCreate
from services import WorkflowService


class WorkflowController:
    @staticmethod
    def create_message(chat_id: int, message: MessageCreate, current_user: User, db: Session):
        return WorkflowService.create_message_with_ai(chat_id, message.content, current_user.id, db)

    @staticmethod
    def update_workflow(message_id: int, workflow_data: dict, current_user: User, db: Session):
        return WorkflowService.update_workflow(message_id, workflow_data, current_user.id, db)

    @staticmethod
    def get_history(chat_id: int, current_user: User, db: Session):
        return WorkflowService.get_workflow_history(chat_id, current_user.id, db)

    @staticmethod
    def undo(chat_id: int, current_user: User, db: Session):
        return WorkflowService.undo_workflow(chat_id, current_user.id, db)
