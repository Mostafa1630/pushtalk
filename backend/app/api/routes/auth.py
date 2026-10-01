from fastapi import APIRouter, File, UploadFile, status
from typing import Annotated

from app.api.deps import CurrentUser, SessionDep, StorageDep
from app.schemas.auth import Credentials, PasswordChange, TokenOut, UserOut, UserUpdate
from app.services import auth_service

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=TokenOut, status_code=status.HTTP_201_CREATED)
async def register(body: Credentials, session: SessionDep) -> TokenOut:
    return await auth_service.register(session, body)


@router.post("/login", response_model=TokenOut)
async def login(body: Credentials, session: SessionDep) -> TokenOut:
    return await auth_service.login(session, body)


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> UserOut:
    return auth_service.user_out(user)


@router.patch("/me", response_model=UserOut)
async def update_me(body: UserUpdate, user: CurrentUser, session: SessionDep) -> UserOut:
    return await auth_service.update_profile(session, user, body)


@router.patch("/me/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    body: PasswordChange, user: CurrentUser, session: SessionDep
) -> None:
    await auth_service.change_password(session, user, body)


@router.post("/me/avatar", response_model=UserOut)
async def upload_avatar(
    user: CurrentUser,
    session: SessionDep,
    storage: StorageDep,
    file: Annotated[UploadFile, File()],
) -> UserOut:
    data = await file.read()
    return await auth_service.set_avatar(session, storage, user, data)

