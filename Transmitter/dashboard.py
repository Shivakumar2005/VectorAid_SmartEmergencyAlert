import asyncio
import threading

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import config
from router import fetch_route, save_route

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

STATE = None
clients = set()


class DestBody(BaseModel):
    lat: float
    lon: float


class TxBody(BaseModel):
    enabled: bool


class SearchBody(BaseModel):
    q: str

@app.get("/")
async def index():
    return FileResponse("static/index.html")


@app.get("/api/route")
async def get_route():
    return {
        "points": STATE.get_route(),
        "confirmed": STATE.route_confirmed,
        "dest": STATE.destination,
    }


@app.post("/api/route")
async def post_route(body: DestBody):
    snap = STATE.snapshot()
    if snap["lat"] is None:
        return {"ok": False, "error": "No GPS fix yet"}
    if not config.ORS_API_KEY:
        return {"ok": False, "error": "ORS_API_KEY missing in .env"}

    STATE.set_status("Fetching route...")
    try:
        pts, summary = await asyncio.to_thread(
            fetch_route,
            config.ORS_API_KEY,
            (snap["lat"], snap["lon"]),
            (body.lat, body.lon),
        )
    except Exception as e:
        STATE.set_status(f"Route failed: {e}")
        return {"ok": False, "error": str(e)}

    save_route(config.ROUTE_CACHE, pts, summary)
    STATE.set_route(pts, summary, [body.lat, body.lon])
    return {
        "ok": True,
        "points": pts,
        "km": round(summary["distance"] / 1000, 2),
        "min": round(summary["duration"] / 60),
    }


@app.delete("/api/route")
async def delete_route():
    STATE.clear_route()
    return {"ok": True}


@app.post("/api/transmit")
async def post_transmit(body: TxBody):
    result = STATE.set_tx(body.enabled)
    return {"ok": True, "enabled": result,
            "reason": None if STATE.route_confirmed else "No route confirmed"}


@app.websocket("/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    clients.add(sock)
    try:
        # send the heavy route data once, on connect
        await sock.send_json({
            "type": "init",
            "route": STATE.get_route(),
            "dest": STATE.destination,
        })
        while True:
            await sock.receive_text()      # keeps the socket open
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(sock)


async def broadcast_loop():
    period = 1.0 / config.DASH_HZ
    while True:
        if clients:
            msg = {"type": "tele", **STATE.snapshot()}
            dead = []
            for c in list(clients):
                try:
                    await c.send_json(msg)
                except Exception:
                    dead.append(c)
            for c in dead:
                clients.discard(c)
        await asyncio.sleep(period)


@app.on_event("startup")
async def startup():
    asyncio.create_task(broadcast_loop())


def start(state):
    """Launch uvicorn in a daemon thread."""
    global STATE
    STATE = state
    cfg = uvicorn.Config(app, host=config.DASH_HOST, port=config.DASH_PORT,
                         log_level="warning")
    server = uvicorn.Server(cfg)
    threading.Thread(target=server.run, daemon=True).start()


@app.post("/api/search")
async def post_search(body: SearchBody):
    from router import geocode
    snap = STATE.snapshot()
    near = (snap["lat"], snap["lon"]) if snap["lat"] is not None else None
    try:
        results = await asyncio.to_thread(geocode, body.q, near)
        return {"ok": True, "results": results}
    except Exception as e:
        return {"ok": False, "error": str(e)}