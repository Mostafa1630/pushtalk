from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import CurrentUser, SessionDep
from app.core.errors import NotFound
from app.schemas.notification import MarkedRead, NotificationOut, NotificationPage, UnreadCount
from app.services import notification_service

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("", response_model=NotificationPage)
async def list_notifications(
    user: CurrentUser,
    session: SessionDep,
    before_id: Annotated[int | None, Query(ge=1, description="Older page: notifications with id < before_id")] = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> NotificationPage:
    return await notification_service.list_notifications(session, user.id, before_id=before_id, limit=limit)


@router.get("/unread-count", response_model=UnreadCount)
async def unread_count(user: CurrentUser, session: SessionDep) -> UnreadCount:
    return await notification_service.unread_count(session, user.id)


@router.post("/read-all", response_model=MarkedRead)
async def mark_all_read(user: CurrentUser, session: SessionDep) -> MarkedRead:
    return await notification_service.mark_all_read(session, user.id)


@router.post("/{notification_id}/read", response_model=NotificationOut)
async def mark_read(notification_id: int, user: CurrentUser, session: SessionDep) -> NotificationOut:
    out = await notification_service.mark_read(session, user.id, notification_id)
    if out is None:
        raise NotFound("Notification not found", code="NOTIFICATION_NOT_FOUND")
    return out
