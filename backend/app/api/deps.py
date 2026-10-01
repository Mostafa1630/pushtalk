"""FastAPI dependencies: DB session, auth, and shared infrastructure objects."""

from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.core.errors import Unauthorized
from app.core.security import decode_access_token
from app.db.session import get_session
from app.models import User
from app.realtime.presence import PresenceStore
from app.repositories.users import UserRepository
from app.services.job_queue import ArqJobQueue, JobQueue
from app.storage.local import LocalStorage

_bearer = HTTPBearer(auto_error=False)

SessionDep = Annotated[AsyncSession, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]


async def get_current_user(
    session: SessionDep,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> User:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise Unauthorized("Authentication required", code="NOT_AUTHENTICATED")
    user_id = decode_access_token(credentials.credentials)
    user = await UserRepository(session).get(user_id)
    if user is None:  # token for a deleted user
        raise Unauthorized("Invalid authentication token", code="INVALID_TOKEN")
    return user


def get_redis(request: Request) -> Redis:
    return request.app.state.redis


def get_storage(request: Request) -> LocalStorage:
    return request.app.state.storage


def get_job_queue(request: Request) -> JobQueue:
    return ArqJobQueue(request.app.state.job_queue)


def get_presence(request: Request, settings: SettingsDep) -> PresenceStore:
    return PresenceStore(request.app.state.redis, settings.presence_ttl_seconds)


CurrentUser = Annotated[User, Depends(get_current_user)]
RedisDep = Annotated[Redis, Depends(get_redis)]
StorageDep = Annotated[LocalStorage, Depends(get_storage)]
JobQueueDep = Annotated[JobQueue, Depends(get_job_queue)]
PresenceDep = Annotated[PresenceStore, Depends(get_presence)]
