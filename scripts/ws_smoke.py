#!/usr/bin/env python3
"""WebSocket + voice-relay checks. curl cannot do these, and they are exactly the
legs the web app depends on most: the app socket carries every streamed chat reply
and every notification, and the Sarvam relays carry all of voice.

Run against a backend started with WEB_AUTH_ENFORCE=1:
    BASE=http://127.0.0.1:8099 EMAIL=… PASSWORD=… ./scripts/ws_smoke.py
"""
import asyncio, json, os, sys, urllib.parse, urllib.request

BASE = os.environ.get("BASE", "http://127.0.0.1:8099").rstrip("/")
WS = BASE.replace("http", "ws", 1)
EMAIL = os.environ["EMAIL"]
PASSWORD = os.environ["PASSWORD"]

try:
    import websockets
except ImportError:
    sys.exit("needs `websockets` (already a backend dependency — run with its venv)")

PASS = FAIL = 0
def ok(m):
    global PASS; PASS += 1; print(f"  \033[32mok\033[0m   {m}")
def bad(m):
    global FAIL; FAIL += 1; print(f"  \033[31mFAIL\033[0m {m}")
def section(m): print(f"\n\033[1m{m}\033[0m")


def login():
    req = urllib.request.Request(
        f"{BASE}/auth/login",
        data=json.dumps({"email": EMAIL, "password": PASSWORD}).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.load(r)
    return d["token"], d["user"]["id"]


async def main():
    token, uid = login()
    ok(f"signed in as user {uid}")

    # ── the app socket ───────────────────────────────────────────────────────
    section("1 · app socket /ws")

    async with websockets.connect(f"{WS}/ws?user_id={uid}&t={urllib.parse.quote(token)}") as ws:
        first = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
        if first.get("type") == "connected":
            ok("connected with a valid token")
        else:
            bad(f"expected a `connected` frame, got {first}")

        # The reply must actually arrive over THIS socket. /chat/stream refuses to
        # generate at all without one, so this is the single most load-bearing
        # behaviour in the app.
        section("2 · streamed reply arrives as frames")
        req = urllib.request.Request(
            f"{BASE}/chat/stream",
            data=json.dumps({"user_id": uid, "message": "hi"}).encode(),
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=30) as r:
            started = json.load(r)
        if started.get("streaming"):
            ok("POST /chat/stream accepted (streaming:true — it saw the socket)")
        else:
            bad(f"declined even with a live socket: {started}")

        seen, complete_text = [], None
        try:
            while True:
                f = json.loads(await asyncio.wait_for(ws.recv(), timeout=45))
                t = f.get("type", "")
                if t == "connection.ping":
                    await ws.send(json.dumps({"type": "connection.pong"}))
                    ok("answered the server's ping (no pong → close 4002)")
                    continue
                if t.startswith("chat."):
                    seen.append(t)
                if t == "chat.complete":
                    complete_text = (f.get("payload") or {}).get("text")
                    break
        except asyncio.TimeoutError:
            bad(f"no chat.complete within 45s; saw {seen}")

        if complete_text is not None:
            ok(f"chat.complete carried the authoritative text ({len(complete_text)} chars)")
            # A greeting is answered by the fast path, which emits ZERO deltas — a
            # client that only renders deltas is silent for exactly this case.
            if "chat.delta" not in seen:
                ok("zero deltas (fast path) — the client must render chat.complete")
            else:
                ok(f"streamed {seen.count('chat.delta')} deltas")

    # ── authorization on the socket ──────────────────────────────────────────
    section("3 · socket authorization")

    async def refused(url, label):
        """Refused must mean the HANDSHAKE was rejected.

        An earlier version treated ANY exception as a refusal, which made a socket
        that connected fine and closed a moment later (the TTS relay does exactly
        that if no config frame arrives) look like a passing security check. It hid
        a real hole on the sibling route. So: opening at all is a failure, and only
        a handshake-level rejection counts."""
        try:
            async with websockets.connect(url, open_timeout=10):
                pass
            bad(f"{label} — the handshake was ACCEPTED")
        except websockets.exceptions.InvalidStatus as e:
            ok(f"{label} — refused at the handshake ({e.response.status_code})")
        except websockets.exceptions.ConnectionClosed as e:
            ok(f"{label} — closed immediately (code {e.code})")
        except Exception as e:
            ok(f"{label} — refused ({type(e).__name__})")

    await refused(f"{WS}/ws?user_id={uid}", "no token")
    await refused(f"{WS}/ws?user_id={uid}&t=forged", "forged token")
    await refused(f"{WS}/ws?user_id={uid + 1}&t={urllib.parse.quote(token)}",
                  "my token, someone else's user_id")

    # ── the Sarvam relays ────────────────────────────────────────────────────
    section("4 · Sarvam speech relays")

    stt = (f"{WS}/voice/sarvam/stt?language_code=en-IN&model=saaras:v3-realtime"
           f"&stream_type=fast&encoding=linear16&sample_rate=16000"
           f"&endpointing=vad&silence_duration_ms=800")
    tts = f"{WS}/voice/sarvam/tts?model=bulbul:v3"

    await refused(f"{stt}&t=forged&user_id={uid}", "STT relay, forged token")
    await refused(f"{tts}&t=forged&user_id={uid}", "TTS relay, forged token")
    await refused(f"{stt}&t={urllib.parse.quote(token)}&user_id={uid + 1}",
                  "STT relay, token/user mismatch")

    for url, name in ((f"{stt}&t={urllib.parse.quote(token)}&user_id={uid}", "STT"),
                      (f"{tts}&t={urllib.parse.quote(token)}&user_id={uid}", "TTS")):
        try:
            async with websockets.connect(url) as w:
                ok(f"{name} relay accepted a valid token and reached Sarvam")
                if name == "TTS":
                    # Config then one sentence: the round trip proves the relay is
                    # pumping frames both ways, not merely accepting the socket.
                    await w.send(json.dumps({"type": "config", "data": {
                        "target_language_code": "en-IN", "speaker": "dev",
                        "output_audio_codec": "mp3", "speech_sample_rate": 22050,
                        "min_buffer_size": 50, "max_chunk_length": 150}}))
                    await w.send(json.dumps({"type": "text",
                                             "data": {"text": "Relay check, one two three."}}))
                    await w.send(json.dumps({"type": "flush"}))
                    got_audio = False
                    try:
                        while not got_audio:
                            f = json.loads(await asyncio.wait_for(w.recv(), timeout=25))
                            if ((f.get("data") or {}).get("audio")):
                                got_audio = True
                    except asyncio.TimeoutError:
                        pass
                    if got_audio:
                        ok("TTS returned real audio through the relay")
                    else:
                        bad("TTS relay opened but produced no audio in 25s")
        except Exception as e:
            bad(f"{name} relay valid token rejected: {type(e).__name__} {e}")

    print(f"\n\033[1m{PASS} passed, {FAIL} failed\033[0m")
    return 1 if FAIL else 0

sys.exit(asyncio.run(main()))
