# Design decisions

Each decision states what was chosen, why, the alternative, the trade-offs, what can go wrong, and how the
code handles it. File references point to the actual implementation.

---

## 1. Upload audio over HTTP, not over the WebSocket

**Decision.** The recording is sent with `POST /api/channels/{id}/messages` (multipart: `file` + `client_id`).
The WebSocket carries only small JSON events.

**Why / problem solved.** An upload is a request that must succeed or fail with a clear answer (validation errors,
413, 415, 503). HTTP gives that for free: status codes, the error envelope, `Content-Length` checks, nginx
`client_max_body_size`, retries, and auth via the normal `Authorization` header. It also keeps the realtime
socket free of multi-megabyte frames, so events for other messages are never stuck behind an upload.

**Alternative.** Binary frames over the already-open WebSocket (saves one TLS/HTTP round trip).

**Why not.** We would have to re-invent request/response correlation, chunking, backpressure, size limits and error
reporting on top of the socket; a dropped socket would lose an upload in flight; and every API instance would need
upload handling inside the realtime code path.

**Trade-offs.** + simple, testable, standard tooling · − one extra request per message (negligible next to
recording time).

**What could go wrong → mitigation.**
- *Upload interrupted / network error* → the frontend keeps the blob and shows **Not sent · Retry**
  (`ChannelSession.upload`). The retry reuses the same `client_id`; the server treats it idempotently
  (unique `(sender_id, client_id)`, `message_service.upload_message`), returning the original message with `200`.
- *Queue (Redis) down at upload* → the message is recorded as `failed/QUEUE_UNAVAILABLE`, the raw upload is kept,
  the API answers 503 and the UI offers *Retry*; retrying with the same `client_id` re-queues that same message.
- *Two concurrent retries* → the unique constraint decides; the loser returns the winner's row (IntegrityError path).
- *Huge body* → rejected by nginx (JSON 413), by the `Content-Length` pre-check, and by a bounded chunked read.

---

## 2. A message arrives while the user is recording

**Decision.** Half-duplex, like a real walkie-talkie: while you hold the button, incoming messages are **queued,
not played**. If something is playing when you press, it is **interrupted and re-queued at the head**, then replays
from the beginning after you release. A hint shows "N message(s) waiting until you release".

**Why.** Playing audio while recording leaks it into the microphone (echo in your own message) and you would miss
what was said. Pausing keeps both messages intact.

**Alternative.** Keep playing (ducked volume) while recording, or drop incoming messages.

**Why not.** Ducking still leaks into the mic and splits attention; dropping loses messages.

**Trade-offs.** + no echo, nothing lost · − a long recording delays incoming audio (bounded by the 60 s limit).

**Risks → mitigation.** A stale `play()` promise from the interrupted message could "finish" the replay early →
`PlaybackQueue` bumps a generation counter on every stop and ignores stale settlements (unit-tested:
*"a stale play() settling after an interrupt does not complete the replay"*). Implementation: `PauseReason
"recording"` in `frontend/src/playback/PlaybackQueue.ts`, wired in `ChannelPage` → `ChannelSession.setRecording`.

---

## 3. Browser autoplay restrictions on first load

**Decision.** The queue never loses a message because of autoplay policy. Two layers:
1. **Proactive:** if `navigator.userActivation.hasBeenActive` is false on load, the queue starts paused with reason
   `blocked`, a banner says *"Click to enable auto-play (N waiting)"*, and the first click/key anywhere unlocks it.
2. **Reactive:** if `play()` still rejects with `NotAllowedError` (e.g. Safari without the userActivation API),
   `HtmlAudioPlayer` throws `AutoplayBlockedError`; the queue puts the item back at the head, pauses as `blocked`, and
   the same banner appears.

Pressing the push-to-talk button is itself a gesture and also unlocks.

**Alternative.** A mandatory "Join audio" modal before entering a channel; or Web Audio API tricks.

**Why not.** A modal adds friction even when the browser already allows playback (returning users with site
engagement). Web Audio has the same gesture requirement.

**Risks → mitigation.** Silent failure is the real risk (users think nothing arrived) → the banner shows the
number of waiting messages. Verified in the browser E2E test with the policy emulated in-page (headless Chromium
under Playwright always reports an activation, so the real policy could not be triggered there).

---

## 4. Same user in two tabs or on two devices

**Decision.**
- Each tab has its own WebSocket; **presence counts a user once** (a Redis sorted set holds one entry per
  connection; the user is online while any entry is alive — `realtime/presence.py`).
- **Only one tab per browser auto-plays**, elected with the Web Locks API (`playback/leader.ts`, lock
  `pushtalk-playback-{channelId}`). Other tabs show "open in another tab" and still allow manual play. When the
  leader tab closes, the browser releases the lock and another tab takes over.
- **Across devices**, each device's leader tab auto-plays (two physical radios both ring). As soon as one reports
  `played`, the server broadcasts `message.status {user_id, kind: "played"}` and the user's other devices **drop that
  message from their queue** if it has not started yet (`ChannelSession.onEvent` → `queue.remove`).
- Receipts are idempotent per `(message, user)`, so two tabs acking the same message count once.

**Alternative.** Single session per user (kick older connections), or a server-side "active device".

**Why not.** Kicking breaks legitimate multi-device use; a server-side active device needs heartbeats/leases
across devices for little gain.

**Risks.** Two devices may both start the same message within the same second before either reports `played`
(acceptable: at worst heard twice). Browsers without Web Locks fall back to "every tab is leader" (documented).
Verified by the E2E test *"same user, two tabs: message auto-plays in exactly one tab"*.

---

## 5. Message ordering (including after a reconnect)

**Decision.** Order is defined by the server with a **gap-free, per-channel sequence number** `messages.seq`,
assigned **when a message becomes ready**, never by client clocks.

1. **Upload order is preserved through processing.** Jobs run concurrently, so a long message uploaded first
   could finish after a short one uploaded second. Before publishing, a job waits while any *older* message of the
   same channel is still `processing` (`worker/tasks._wait_for_older_messages`, polling, bounded by
   `ORDERING_WAIT_SECONDS=20` so a stuck message can't block the channel).
2. **Seq assignment is serialized.** In one transaction the worker locks the channel row
   (`SELECT … FOR UPDATE`), increments `channels.last_seq`, and stores it on the message together with `status=ready`.
   The unique constraint `(channel_id, seq)` and the check `status <> 'ready' OR seq IS NOT NULL` back this up.
   Failed messages never consume a seq, so the sequence has no permanent holes.
3. **Publish after commit.** Anyone who receives `seq = n` can always fetch `n` from the database.
4. **Clients apply strictly in seq order** with `MessageSequencer`: duplicates are dropped, anything after a gap is
   held, and a gap triggers an HTTP catch-up `GET …/messages?after_seq=<last>` after 800 ms.
5. **The playback queue sorts by seq** as a last line of defence.

**Alternative.** Order by `created_at`, or assign seq at upload time.

**Why not.** Timestamps collide and depend on clocks; seq-at-upload would create holes whenever a message fails
(clients would wait for a seq that never comes) and forces clients to wait on slow processing.

**Trade-offs.** + deterministic, gap-free, simple client logic · − a slow message delays later ones in the same
channel by up to its processing time (typically < 1 s), bounded at 20 s.

**Example.** Alice uploads 101 (3 s audio), 102 (0.8 s), 103 (1.5 s). The worker finishes 102 first, but its job waits
until 101 is ready; 101 gets seq n, 102 gets n+1, 103 gets n+2. Bob receives n, n+1, n+2 and plays them in that order.
If Redis delivers n+2 before n+1 (two workers publishing concurrently), Bob's sequencer holds n+2 until n+1 arrives
or the gap fill fetches it. Verified by `test_broadcast_order_follows_upload_order_even_if_older_job_is_slower`, the
smoke test and the browser E2E test.

---

## 6. Reconnect and missed-message recovery

**Decision.** The WebSocket is a *notification* channel; the database is the source of truth.

- `ChannelSocket` reconnects on any non-final close with exponential backoff + full jitter
  (`500 ms · 2^attempt`, capped at 15 s, reset after `ready`), and immediately on the browser `online` event.
- Close codes 4400/4401/4403/4404 (bad frame, bad token, not a member, no channel) are final: no retry loop.
- On connect the server **registers the socket for fan-out first, then reads `latest_seq`** and sends
  `ready {latest_seq}`. Anything published after registration reaches the socket; anything before is committed in
  the database. The client compares `latest_seq` with its own `lastSeq` and pages through
  `GET /messages?after_seq=` (200 per page) — no window where a message can be missed. Overlaps are de-duplicated by seq.
- If an API process loses its Redis subscription, it re-subscribes with backoff and sends `resync` to all its sockets,
  because pub/sub dropped whatever was published meanwhile.
- Receipts produced while offline (`ack`, `played`) are buffered in the socket outbox and flushed after `ready`.
- Messages recovered by catch-up are auto-played if they are younger than 5 minutes and not yet played by the user;
  older ones are marked **new** with a "Play N unheard" button (avoids a 30-minute audio backlog after a laptop sleep).

**Alternative.** Server replays missed events over the socket, or Redis Streams with consumer offsets.

**Why not.** Replaying over the socket duplicates the history query inside the realtime path; Streams add retention
and trimming decisions. A single HTTP catch-up path is used for initial history, reconnects, gap fills and resyncs.

**Risks → mitigation.** Thundering herd after an API restart → jitter. A slow client → per-socket bounded outbox;
on overflow the server closes with 4408 and the client reconnects and catches up.

---

## 7. Delivery and playback status model

**Decision.** Per-recipient rows in `message_receipts (message_id, user_id, delivered_at, played_at)`, shown to the
sender **aggregated** ("Delivered 1/3", "Played 2/3").

| State (sender UI) | Caused by |
|---|---|
| Uploading… | local: HTTP upload in flight |
| Not sent · Retry | local: network error / 5xx on upload (blob kept, same `client_id` on retry) |
| Failed — reason | 4xx validation on upload, or worker `message.failed` event, or stale sweeper |
| Processing… | server accepted (`202`, status `processing`) |
| Sent | worker set `ready` and broadcast (`message.new`) |
| Delivered n/N | a recipient client received it (live or catch-up) and sent `ack` |
| Played n/N | a recipient finished playback and sent `played` |

`delivered` means *the client got it*, not that it was heard. `played` implies delivered (upsert).
Both writes are idempotent (`ON CONFLICT DO NOTHING` / update only while `played_at IS NULL`) and only newly changed
rows trigger a `message.status` broadcast. Recipients never ack their own messages (filtered in SQL).

**Alternative.** A single status column on the message.

**Why not.** A group channel has many recipients; a single column can't express "2 of 3 heard it".

**Trade-offs.** + exact per-recipient data, cheap aggregates · − one row per recipient per message (fine at this scale;
see scaling notes). N is the current member count minus the sender (documented limitation).

---

## 8. Background jobs: arq

**Decision.** arq (async, Redis-backed). Jobs are enqueued with a deterministic id `msg:<uuid>`.

**Why.** The whole backend is asyncio (FastAPI, SQLAlchemy async, redis.asyncio); arq runs async functions natively,
so the worker reuses the same repositories and services. It needs only Redis, which we already run. Built-in
retries (`Retry(defer=…)`), job timeouts, cron jobs (the stale sweeper) and a health-check key (`arq --check`).

**Alternative.** Celery (most features, but sync-first, heavier config) or RQ (sync, simpler).

**Trade-offs.** + small, async-native · − smaller ecosystem, fewer monitoring tools than Celery; the worker process
exits if Redis disappears (Docker restarts it).

**Failure handling.** Permanent errors (undecodable audio, ffmpeg error, ffmpeg timeout, missing upload, disk
error) → message `failed` + `message.failed` event, no retry. Transient errors (database/Redis connection) →
`Retry` with 2/4 s delay; on the 3rd attempt the message is marked failed. Duplicate runs (arq may re-run a job after
a crash) are no-ops because the job only acts on messages still `processing`. Messages stuck in `processing` for
more than 120 s (worker was down, job lost) are marked failed by a cron job every 30 s.

---

## 9. Media storage: local Docker volume

**Decision.** A named volume `media` mounted at `/data/media` in both `api` and `worker`, behind a tiny
`LocalStorage` class; only relative keys (`uploads/<id>.bin`, `audio/<id>.ogg`) are stored in the DB.

**Why.** Satisfies the brief with zero extra services. Atomic writes (temp file + rename) mean readers never see a
half-written file. Raw uploads are deleted after successful processing.

**Alternative.** MinIO (S3 API) with presigned URLs.

**Why not now.** An extra service and credentials for no functional gain on a single host. The interface
(`write_bytes`, `path_for`, `delete`) is what an S3 implementation would replace; the stored keys stay valid.

**Media protection.** Audio is served only by `GET /api/messages/{id}/audio`, which requires a valid token **and**
membership of the message's channel, and only for `ready` messages. The browser fetches it with the bearer token
and plays an object URL, so there is never a public file URL.

---

## 10. How Redis is used

| Use | Keys / channels | Notes |
|---|---|---|
| Job queue | arq keys | enqueue from the API, consume in the worker |
| Event fan-out | `PUBLISH pushtalk:channel:<id>` | worker + API publish; each API process holds **one** `PSUBSCRIBE pushtalk:channel:*` (`realtime/hub.py`) and fans out to its local sockets |
| Presence | `pushtalk:presence:<id>` sorted set | member `userId:connId`, score = expiry; heartbeats every 15 s, TTL 45 s |

One pattern subscription per process (instead of one per socket) keeps Redis connections constant and makes
multiple API instances work without sticky sessions for event delivery.

---

## 11. Database design highlights

- `messages.id` is a UUID (unguessable in media URLs); users/channels use `BIGINT IDENTITY`.
- `messages.seq` + `channels.last_seq` implement ordering (see §5); `UNIQUE(channel_id, seq)`.
- `UNIQUE(sender_id, client_id)` implements idempotent uploads.
- Audio metadata (`duration_ms`, `waveform` JSONB, `audio_path`, detected `upload_mime`, `upload_bytes`) lives on the
  message row: strictly 1:1 with the message, always read together, so a separate table would only add a join.
- `message_receipts` PK `(message_id, user_id)` makes receipts idempotent; index on `user_id`.
- Index `(channel_id, status, created_at)` serves the ordering wait and the stale sweeper.
- Usernames and channel names are lower-cased before storage, so the plain unique constraints are case-insensitive.

---

## 12. Authentication

**Decision.** Stateless JWT (HS256, 12 h) as a bearer token; bcrypt (cost 12) for passwords. The WebSocket
authenticates with a **first `hello` frame** instead of a query-string token.

**Why.** Bearer tokens work identically for fetch, the media endpoint and the socket, and need no server-side session
store. Tokens in URLs end up in proxy/access logs, so the socket token travels in the first frame (5 s timeout).
Login returns the same error and spends the same bcrypt time for unknown users and wrong passwords
(no username enumeration).

**Trade-offs / cut.** No refresh tokens or revocation; the token is kept in `localStorage` (convenient reloads, but
readable by injected script). With more time: short-lived access token + httpOnly refresh cookie.

---

## 13. Validating audio: never trust the client

- Declared MIME must be in an allowlist **and** the magic bytes must identify WebM/Ogg/WAV/MP4/MP3
  (`audio/sniff.py`). The stored MIME is the detected one.
- The **real duration** comes from decoding the stream with ffmpeg to a null sink (`audio/ffmpeg.probe`), not from
  container metadata (Chrome's MediaRecorder WebM often has none, and a crafted file can claim anything). Decoding
  stops at 61 s, bounding CPU for malicious files. `-xerror` makes corrupted streams fail.
- Limits: 0.5 s ≤ duration ≤ 60 s + 0.5 s tolerance; the worker cuts the normalized output to exactly 60 s and
  re-measures the processed file.
- Every ffmpeg/ffprobe call has a hard timeout and is killed on expiry.

---

## What I cut, and why

| Cut | Reason |
|---|---|
| Rate limiting, DMs, transcription, playback speed (stretch goals) | Spent the time on ordering, reconnect and failure handling, which the brief weighs more |
| Refresh tokens / revocation | Not required; documented risk |
| "Load older history" UI | API supports `before_seq`; UI shows the latest 50 |
| Leave/delete channel, profile pages | Not in the user stories |
| MinIO | Local volume satisfies the brief; storage is behind an interface |

## What I would do with twice the time

1. Build and run the Docker images in CI (GitHub Actions: compose up, backend tests, frontend tests, Playwright E2E).
2. MinIO/S3 storage with short-lived presigned URLs (CDN-friendly), and multiple API/worker replicas behind a load balancer.
3. Per-user rate limiting on uploads (Redis token bucket) and stricter upload quotas.
4. httpOnly refresh-token cookie + short-lived access tokens; token revocation list.
5. Metrics (Prometheus: processing latency, queue depth, WebSocket count) and tracing; alerting on stale messages.
6. Cross-browser testing (Firefox, Safari/iOS) and a "load older messages" UI; playback speed control.
7. Replace the polling ordering wait with a per-channel publish lock/notification, and snapshot recipient counts per message.
