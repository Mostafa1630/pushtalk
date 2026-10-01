"""Protected audio download. Requires a bearer token AND channel membership."""

import uuid

from fastapi import APIRouter
from fastapi.responses import FileResponse

from app.api.deps import CurrentUser, SessionDep, StorageDep
from app.services import message_service

router = APIRouter(prefix="/messages", tags=["media"])


@router.get("/{message_id}/audio", response_class=FileResponse)
async def get_audio(
    message_id: uuid.UUID, user: CurrentUser, session: SessionDep, storage: StorageDep
) -> FileResponse:
    path = await message_service.resolve_audio_file(session, storage, user, message_id)
    return FileResponse(
        path,
        media_type="audio/ogg",
        headers={
            # Private: never stored by shared caches; the browser may reuse it.
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
        },
    )
