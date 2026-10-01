"""End-to-end smoke test against a RUNNING PushTalk stack (API + worker + DB + Redis).

Usage (from the repo root, with the stack up):
    docker compose exec api python scripts/smoke_test.py
or locally:
    API_URL=http://localhost:8000 python backend/scripts/smoke_test.py

It generates test audio with ffmpeg, so run it where ffmpeg is installed
(the api container has it). Each check prints PASS/FAIL; exit code 1 on failure.
"""

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

import httpx
import websockets

API = os.environ.get("API_URL", "http://localhost:8000").rstrip("/")
WS = API.replace("http://", "ws://").replace("https://", "wss://")
RUN = uuid.uuid4().hex[:6]
failures: list[str] = []


def check(name: str, condition: bool, info: object = "") -> None:
    print(f"[{'PASS' if condition else 'FAIL'}] {name}" + (f"  ({info})" if not condition and info else ""))
    if not condition:
        failures.append(name)


def make_audio(tmp: Path, name: str, seconds: float, freq: int = 440) -> bytes:
    out = tmp / name
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={seconds}",
         "-c:a", "libopus", "-b:a", "24k", "-f", "webm", str(out)],
        check=True,
    )
    return out.read_bytes()


async def register(client: httpx.AsyncClient, name: str) -> tuple[str, int]:
    r = await client.post(f"{API}/api/auth/register", json={"username": name, "password": "password123"})
    r.raise_for_status()
    body = r.json()
    return body["access_token"], body["user"]["id"]


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def upload(client: httpx.AsyncClient, token: str, channel_id: int, data: bytes,
                 mime: str = "audio/webm;codecs=opus") -> httpx.Response:
    return await client.post(
        f"{API}/api/channels/{channel_id}/messages",
        headers=auth(token),
        files={"file": ("rec.webm", data, mime)},
        data={"client_id": str(uuid.uuid4())},
    )


async def ws_connect(channel_id: int, token: str):  # type: ignore[no-untyped-def]
    ws = await websockets.connect(f"{WS}/api/ws/channels/{channel_id}")
    await ws.send(json.dumps({"type": "hello", "token": token}))
    ready = json.loads(await asyncio.wait_for(ws.recv(), 5))
    return ws, ready


async def next_event(ws, wanted: str, timeout: float = 20) -> dict:  # type: ignore[no-untyped-def]
    async def _loop() -> dict:
        while True:
            evt = json.loads(await ws.recv())
            if evt.get("type") == wanted:
                return evt
    return await asyncio.wait_for(_loop(), timeout)


async def main() -> None:
    tmp = Path(tempfile.mkdtemp())
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(f"{API}/api/health")
        check("health endpoint reports db+redis ok", r.status_code == 200, r.text)

        # ---- auth ------------------------------------------------------------
        a_tok, a_id = await register(c, f"alice_{RUN}")
        b_tok, b_id = await register(c, f"bob_{RUN}")
        c_tok, _ = await register(c, f"carol_{RUN}")
        r = await c.post(f"{API}/api/auth/register", json={"username": f"alice_{RUN}", "password": "password123"})
        check("duplicate username -> 409 USERNAME_TAKEN", r.status_code == 409 and r.json()["error"]["code"] == "USERNAME_TAKEN", r.text)
        r = await c.post(f"{API}/api/auth/login", json={"username": f"alice_{RUN}", "password": "wrong-pass"})
        check("wrong password -> 401 INVALID_CREDENTIALS", r.status_code == 401 and r.json()["error"]["code"] == "INVALID_CREDENTIALS", r.text)
        r = await c.get(f"{API}/api/auth/me", headers=auth("garbage"))
        check("invalid token -> 401", r.status_code == 401, r.text)

        # ---- channels --------------------------------------------------------
        r = await c.post(f"{API}/api/channels", headers=auth(a_tok), json={"name": f"general-{RUN}"})
        check("create channel -> 201", r.status_code == 201, r.text)
        ch = r.json()["id"]
        r = await c.post(f"{API}/api/channels/{ch}/join", headers=auth(b_tok))
        check("join channel -> 200", r.status_code == 200, r.text)
        r = await c.post(f"{API}/api/channels/{ch}/join", headers=auth(b_tok))
        check("join again is idempotent -> 200", r.status_code == 200, r.text)
        r = await c.post(f"{API}/api/channels/999999/join", headers=auth(b_tok))
        check("join missing channel -> 404", r.status_code == 404, r.text)

        # ---- realtime + pipeline --------------------------------------------
        b_ws, b_ready = await ws_connect(ch, b_tok)
        check("WS hello -> ready", b_ready.get("type") == "ready", b_ready)
        a_ws, _ = await ws_connect(ch, a_tok)
        pres = await next_event(b_ws, "presence")
        check("presence shows online users", b_id in pres["online"], pres)
        r = await c.get(f"{API}/api/channels/{ch}/members", headers=auth(a_tok))
        online = {m["user_id"]: m["online"] for m in r.json()}
        check("members endpoint marks both online", online.get(a_id) and online.get(b_id), r.text)

        # Three messages uploaded back-to-back; different lengths so they
        # finish processing at different times. Order must still be upload order.
        uploads = []
        for seconds in (3.0, 0.8, 1.5):
            r = await upload(c, a_tok, ch, make_audio(tmp, f"m{seconds}.webm", seconds))
            check(f"upload {seconds}s -> 202 processing", r.status_code == 202 and r.json()["status"] == "processing", r.text)
            uploads.append(r.json()["id"])
        received = [(await next_event(b_ws, "message.new"))["message"] for _ in uploads]
        check("recipient got messages in upload order", [m["id"] for m in received] == uploads,
              [m["id"] for m in received])
        seqs = [m["seq"] for m in received]
        check("seq strictly increasing and gap-free", seqs == list(range(seqs[0], seqs[0] + 3)), seqs)
        check("real duration extracted", abs(received[0]["duration_ms"] - 3000) < 150, received[0]["duration_ms"])
        check("waveform peaks extracted", len(received[0]["waveform"] or []) == 64)

        first = received[0]["id"]
        r = await c.get(f"{API}/api/messages/{first}/audio", headers=auth(b_tok))
        check("member can fetch audio (ogg)", r.status_code == 200 and r.content[:4] == b"OggS", r.status_code)
        r = await c.get(f"{API}/api/messages/{first}/audio", headers=auth(c_tok))
        check("NON-member cannot fetch audio -> 403", r.status_code == 403, r.text)
        r = await c.get(f"{API}/api/messages/{first}/audio")
        check("anonymous cannot fetch audio -> 401", r.status_code == 401, r.text)

        # Receipts: B acks delivery and playback -> A sees status updates.
        await b_ws.send(json.dumps({"type": "ack", "delivered": [first]}))
        st = await next_event(a_ws, "message.status")
        check("sender sees delivered", st["kind"] == "delivered" and st["receipts"]["delivered"] == 1, st)
        await b_ws.send(json.dumps({"type": "played", "message_id": first}))
        st = await next_event(a_ws, "message.status")
        check("sender sees played", st["kind"] == "played" and st["receipts"]["played"] == 1, st)

        # ---- reconnect catch-up ---------------------------------------------
        last_seen = seqs[-1]
        await b_ws.close()
        missed = []
        for seconds in (0.7, 0.9):
            r = await upload(c, a_tok, ch, make_audio(tmp, f"x{seconds}.webm", seconds))
            missed.append(r.json()["id"])
        for _ in missed:
            await next_event(a_ws, "message.new")  # wait until processed
        b_ws, b_ready = await ws_connect(ch, b_tok)
        check("ready.latest_seq reveals missed messages", b_ready["latest_seq"] == last_seen + 2, b_ready)
        r = await c.get(f"{API}/api/channels/{ch}/messages", params={"after_seq": last_seen}, headers=auth(b_tok))
        got = [m["id"] for m in r.json()["messages"]]
        check("catch-up returns exactly the missed messages in order", got == missed, got)
        await b_ws.close()
        await a_ws.close()

        # ---- validation failures --------------------------------------------
        r = await upload(c, a_tok, ch, b"")
        check("empty file -> 422 EMPTY_FILE", r.status_code == 422 and r.json()["error"]["code"] == "EMPTY_FILE", r.text)
        r = await upload(c, a_tok, ch, b"this is not audio at all", "audio/webm")
        check("fake content -> 415", r.status_code == 415, r.text)
        r = await upload(c, a_tok, ch, make_audio(tmp, "ok.webm", 1), "text/plain")
        check("bad declared MIME -> 415", r.status_code == 415, r.text)
        r = await upload(c, a_tok, ch, make_audio(tmp, "short.webm", 0.3))
        check("0.3s -> 422 AUDIO_TOO_SHORT", r.status_code == 422 and r.json()["error"]["code"] == "AUDIO_TOO_SHORT", r.text)
        r = await upload(c, a_tok, ch, make_audio(tmp, "long.webm", 62))
        check("62s -> 422 AUDIO_TOO_LONG", r.status_code == 422 and r.json()["error"]["code"] == "AUDIO_TOO_LONG", r.text)
        good = make_audio(tmp, "trunc.webm", 2)
        r = await upload(c, a_tok, ch, good[:400])
        check("truncated audio rejected (422/415)", r.status_code in (415, 422), r.text)
        r = await upload(c, c_tok, ch, good)
        check("non-member upload -> 403", r.status_code == 403, r.text)

    print(f"\n{len(failures)} failure(s)" if failures else "\nALL CHECKS PASSED")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    asyncio.run(main())
