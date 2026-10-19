from typing import Annotated

from fastapi import APIRouter, File, UploadFile, status
from fastapi.responses import FileResponse

from app.api.deps import CurrentUser, PresenceDep, RedisDep, SessionDep, StorageDep
from app.core.errors import NotFound
from app.repositories.channels import ChannelRepository
from app.schemas.channel import ChannelCreate, ChannelOut, ChannelUpdate, DirectChannelCreate, MemberOut
from app.services import channel_service
from app.storage.local import LocalStorage

router = APIRouter(prefix="/channels", tags=["channels"])


def image_file_response(storage: LocalStorage, relative_key: str) -> FileResponse:
    path = storage.path_for(relative_key)
    if not path.is_file():
        raise NotFound("Image not found", code="IMAGE_NOT_FOUND")
    ext = path.suffix.lower()
    media = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}.get(
        ext, "application/octet-stream"
    )
    return FileResponse(path, media_type=media, headers={"Cache-Control": "public, max-age=3600"})


@router.get("", response_model=list[ChannelOut])
async def list_channels(user: CurrentUser, session: SessionDep) -> list[ChannelOut]:
    return await channel_service.list_channels(session, user)


@router.post("", response_model=ChannelOut, status_code=status.HTTP_201_CREATED)
async def create_channel(body: ChannelCreate, user: CurrentUser, session: SessionDep) -> ChannelOut:
    return await channel_service.create_channel(session, user, body)


@router.get("/direct", response_model=list[ChannelOut])
async def list_direct_channels(user: CurrentUser, session: SessionDep) -> list[ChannelOut]:
    return await channel_service.list_direct_channels(session, user)


@router.post("/direct", response_model=ChannelOut)
async def create_or_get_dm(
    body: DirectChannelCreate, user: CurrentUser, session: SessionDep
) -> ChannelOut:
    return await channel_service.create_or_get_dm(
        session, user, target_user_id=body.user_id, target_username=body.username
    )


@router.get("/{channel_id}", response_model=ChannelOut)
async def get_channel(channel_id: int, user: CurrentUser, session: SessionDep) -> ChannelOut:
    return await channel_service.get_channel(session, user, channel_id)


@router.patch("/{channel_id}", response_model=ChannelOut)
async def update_channel(
    channel_id: int, body: ChannelUpdate, user: CurrentUser, session: SessionDep
) -> ChannelOut:
    return await channel_service.update_channel(session, user, channel_id, body)


@router.delete("/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_channel(
    channel_id: int, user: CurrentUser, session: SessionDep, storage: StorageDep
) -> None:
    await channel_service.delete_channel(session, storage, user, channel_id)


@router.get("/{channel_id}/image")
async def get_channel_image(channel_id: int, session: SessionDep, storage: StorageDep) -> FileResponse:
    channel = await ChannelRepository(session).get(channel_id)
    if channel is None or not channel.image_path:
        raise NotFound("Image not found", code="IMAGE_NOT_FOUND")
    return image_file_response(storage, channel.image_path)


@router.post("/{channel_id}/image", response_model=ChannelOut)
async def upload_channel_image(
    channel_id: int,
    user: CurrentUser,
    session: SessionDep,
    storage: StorageDep,
    file: Annotated[UploadFile, File()],
) -> ChannelOut:
    data = await file.read()
    return await channel_service.set_channel_image(session, storage, user, channel_id, data)


@router.post("/{channel_id}/join", response_model=ChannelOut)
async def join_channel(
    channel_id: int, user: CurrentUser, session: SessionDep, redis: RedisDep
) -> ChannelOut:
    return await channel_service.join_channel(session, redis, user, channel_id)


@router.get("/{channel_id}/members", response_model=list[MemberOut])
async def list_members(
    channel_id: int, user: CurrentUser, session: SessionDep, presence: PresenceDep
) -> list[MemberOut]:
    return await channel_service.list_members(session, presence, user, channel_id)
