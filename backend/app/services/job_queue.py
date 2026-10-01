"""Background job queue abstraction (arq on Redis).

The API only needs "enqueue processing for message X". Hiding arq behind this
tiny interface keeps routes/services independent of the queue library and
lets tests substitute an in-memory fake.
"""

import uuid
from typing import Protocol

from arq.connections import ArqRedis

PROCESS_MESSAGE_JOB = "process_message"


class JobQueue(Protocol):
    async def enqueue_processing(self, message_id: uuid.UUID) -> None: ...


class ArqJobQueue:
    def __init__(self, pool: ArqRedis) -> None:
        self.pool = pool

    async def enqueue_processing(self, message_id: uuid.UUID) -> None:
        # A deterministic job id makes enqueueing idempotent: arq refuses a
        # second job with the same id while the first one exists.
        await self.pool.enqueue_job(PROCESS_MESSAGE_JOB, str(message_id), _job_id=f"msg:{message_id}")
