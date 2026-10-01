import uuid
from typing import Annotated

from fastapi import APIRouter, File, Form, Query, Request, UploadFile, status
from fastapi.responses import JSONResponse

from app.api.deps import CurrentUser, JobQueueDep, SessionDep, SettingsDep, StorageDep
from app.core.errors import PayloadTooLarge, ValidationFailed
from app.schemas.message import MessageOut, MessagePage
from app.services import message_service

router = APIRouter(prefix="/channels/{channel_id}/messages", tags=["messages"])

# Multipart framing overhead allowed on top of the audio payload.
_MULTIPART_OVERHEAD = 64 * 1024
_READ_CHUNK = 64 * 1024


@router.get("", response_model=MessagePage)
async def list_messages(
    channel_id: int,
    user: CurrentUser,
    session: SessionDep,
    after_seq: Annotated[int | None, Query(ge=0, description="Catch-up: messages with seq > after_seq")] = None,
    before_seq: Annotated[int | None, Query(ge=1, description="Older history page")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> MessagePage:
    if after_seq is not None and before_seq is not None:
        raise ValidationFailed("Use either after_seq or before_seq, not both")
    return await message_service.list_messages(
        session, user, channel_id, after_seq=after_seq, before_seq=before_seq, limit=limit
    )


@router.post(
    "",
    response_model=MessageOut,
    status_code=status.HTTP_202_ACCEPTED,
    responses={200: {"description": "Duplicate upload (same client_id); original returned"}},
)
async def upload_message(
    channel_id: int,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
    storage: StorageDep,
    queue: JobQueueDep,
    settings: SettingsDep,
    file: Annotated[UploadFile, File(description="Recorded audio")],
    client_id: Annotated[uuid.UUID, Form(description="Client-generated id for idempotent retries")],
) -> JSONResponse:
    # Reject obviously oversized bodies before reading them.
    content_length = request.headers.get("content-length")
    if content_length and content_length.isdigit():
        if int(content_length) > settings.max_upload_bytes + _MULTIPART_OVERHEAD:
            raise PayloadTooLarge(
                f"Recording exceeds the {settings.max_upload_bytes // (1024 * 1024)} MB limit"
            )

    # Read at most limit+1 bytes: never trust Content-Length alone.
    chunks: list[bytes] = []
    total = 0
    while chunk := await file.read(_READ_CHUNK):
        total += len(chunk)
        if total > settings.max_upload_bytes:
            raise PayloadTooLarge(
                f"Recording exceeds the {settings.max_upload_bytes // (1024 * 1024)} MB limit"
            )
        chunks.append(chunk)

    message, created = await message_service.upload_message(
        session=session,
        storage=storage,
        queue=queue,
        settings=settings,
        user=user,
        channel_id=channel_id,
        client_id=client_id,
        data=b"".join(chunks),
        declared_content_type=file.content_type,
    )
    return JSONResponse(
        message.model_dump(mode="json"),
        status_code=status.HTTP_202_ACCEPTED if created else status.HTTP_200_OK,
    )
