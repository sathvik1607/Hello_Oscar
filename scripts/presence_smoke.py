"""Presence and typing — the two frames that had no listener at all."""
import asyncio, json, urllib.parse, urllib.request, sys
import websockets
BASE="http://127.0.0.1:8000"; WS=BASE.replace("http","ws",1)
def login(e,p):
    r=urllib.request.Request(f"{BASE}/auth/login",
        data=json.dumps({"email":e,"password":p}).encode(),
        headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(r,timeout=20) as f: d=json.load(f)
    return d["token"], d["user"]["id"]

async def main():
    lt,lead=login("webmsg.lead@oscar.test","Oscar@2026")
    mt,mem =login("webmsg.mem@oscar.test","Oscar@2026")
    seen=[]
    async with websockets.connect(f"{WS}/ws?user_id={lead}&t={urllib.parse.quote(lt)}") as watcher:
        await asyncio.wait_for(watcher.recv(),timeout=10)

        async def collect():
            try:
                while True:
                    f=json.loads(await asyncio.wait_for(watcher.recv(),timeout=7))
                    if f.get("type")=="connection.ping":
                        await watcher.send(json.dumps({"type":"connection.pong"})); continue
                    seen.append((f["type"], f.get("payload")))
            except asyncio.TimeoutError: pass

        task=asyncio.create_task(collect())
        await asyncio.sleep(0.8)

        # member connects -> presence.changed(online) to teammates
        async with websockets.connect(f"{WS}/ws?user_id={mem}&t={urllib.parse.quote(mt)}") as peer:
            await asyncio.wait_for(peer.recv(),timeout=10)
            await asyncio.sleep(0.6)
            # member types to the lead -> typing.changed relayed to the lead only
            await peer.send(json.dumps({"type":"typing.changed","to_user_id":lead,"typing":True}))
            await asyncio.sleep(0.6)
            await peer.send(json.dumps({"type":"typing.changed","to_user_id":lead,"typing":False}))
            await asyncio.sleep(0.6)
        # peer socket closed -> presence.changed(offline)
        await asyncio.sleep(1.2)
        await task

    types=[t for t,_ in seen]
    print("  frames:", sorted(set(types)) or "NONE")
    print()
    for want,what in [("presence.changed","live online/offline dots in Team + Messages"),
                      ("typing.changed","the typing bubble in a DM")]:
        hit = want in types
        print(f"  {'ok  ' if hit else 'MISS'} {want:<20} -> {what}")
        for t,p in seen:
            if t==want: print(f"         payload: {p}")
    return 0
sys.exit(asyncio.run(main()))
