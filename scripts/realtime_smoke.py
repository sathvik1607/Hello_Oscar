"""Do the realtime frames the web app now listens to actually arrive?

Opens the app socket as one user, performs real actions as the OTHER user, and
reports which frames landed. Compilation proves none of this.
"""
import asyncio, json, os, sys, urllib.parse, urllib.request, threading, time
import websockets

BASE = "http://127.0.0.1:8000"
WS = BASE.replace("http", "ws", 1)

def login(email, pw):
    r = urllib.request.Request(f"{BASE}/auth/login",
        data=json.dumps({"email": email, "password": pw}).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=20) as f:
        d = json.load(f)
    return d["token"], d["user"]["id"]

def call(method, path, token, body=None):
    r = urllib.request.Request(BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method=method)
    try:
        with urllib.request.urlopen(r, timeout=30) as f:
            return json.load(f)
    except Exception as e:
        return {"error": str(e)}

async def main():
    lead_t, lead = login("webmsg.lead@oscar.test", "Oscar@2026")
    mem_t, mem = login("webmsg.mem@oscar.test", "Oscar@2026")
    print(f"  watching as lead={lead}; acting as member={mem}\n")

    seen = []
    url = f"{WS}/ws?user_id={lead}&t={urllib.parse.quote(lead_t)}"
    async with websockets.connect(url) as ws:
        await asyncio.wait_for(ws.recv(), timeout=10)      # 'connected'

        def act():
            time.sleep(1.0)
            # a task assigned to the lead -> task.created to owner+assignee
            call("POST", "/items", mem_t, {
                "user_id": mem, "item_type": "task", "title": "[rt] frame probe",
                "due_at": time.strftime("%Y-%m-%dT%H:%M:00", time.localtime(time.time()+7200)),
                "priority": "low", "assigned_to_user_id": lead})
            time.sleep(0.8)
            call("POST", f"/users/{mem}/direct/{lead}/messages", mem_t,
                 {"text": "[rt] direct message probe"})
            time.sleep(0.8)
            call("POST", f"/teams/66/messages", mem_t,
                 {"user_id": mem, "text": "[rt] team message probe"})
            time.sleep(0.8)
            call("POST", f"/users/{mem}/direct/{lead}/read", mem_t, {"last_read_id": 999999})

        threading.Thread(target=act, daemon=True).start()

        try:
            while True:
                f = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
                t = f.get("type")
                if t == "connection.ping":
                    await ws.send(json.dumps({"type": "connection.pong"}))
                    continue
                seen.append(t)
        except asyncio.TimeoutError:
            pass

    want = {
        "task.created":          "Today / Tasks / Calendar / Team live update",
        "notification.created": "Activity + nav badge + tab title",
        "direct.message.created": "Messages thread + conversation list",
        "team.message.created": "Team chat thread",
        "direct.message.read":  "the ✓✓ ticks",
    }
    print("  frames received:", sorted(set(seen)) or "NONE")
    print()
    ok = bad = 0
    for frame, what in want.items():
        hit = frame in seen
        ok += hit; bad += not hit
        print(f"  {'ok  ' if hit else 'MISS'} {frame:<24} -> {what}")
    print(f"\n  {ok} arrived, {bad} missing")
    return 1 if bad else 0

sys.exit(asyncio.run(main()))
