from fastapi import APIRouter
from fastapi.responses import FileResponse

from app.api.deps import SessionDep, StorageDep
from app.api.routes.channels import image_file_response
from app.core.errors import NotFound
from app.repositories.users import UserRepository

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/{user_id}/avatar")
async def get_user_avatar(user_id: int, session: SessionDep, storage: StorageDep) -> FileResponse:
    user = await UserRepository(session).get(user_id)
    if user is None or not user.avatar_path:
        raise NotFound("Image not found", code="IMAGE_NOT_FOUND")
    return image_file_response(storage, user.avatar_path)
