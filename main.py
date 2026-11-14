import threading
import time
from pathlib import Path

import uvicorn
import webview
from fastapi.staticfiles import StaticFiles

from backend.api import app


FRONTEND_DIR = Path(__file__).resolve().parent / "frontend" / "out"
PORT = 8080


def main():
    if not (FRONTEND_DIR / "index.html").is_file():
        raise RuntimeError("Build the desktop frontend with CAFE_ONE_DESKTOP_BUILD=1.")

    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="desktop")
    server = uvicorn.Server(uvicorn.Config(
        app, host="127.0.0.1", port=PORT, log_level="warning",
    ))
    backend = threading.Thread(target=server.run, daemon=True)
    backend.start()

    try:
        deadline = time.monotonic() + 60
        while not server.started and backend.is_alive() and time.monotonic() < deadline:
            time.sleep(0.1)
        if not server.started:
            raise RuntimeError("Cafe One failed to start. Check the startup log and port 8080.")

        webview.create_window(
            title="Cafe One",
            url=f"http://127.0.0.1:{PORT}",
            maximized=True,
            min_size=(1024, 768),
            background_color="#020617",
        )
        webview.start(gui="edgechromium")
    finally:
        server.should_exit = True
        backend.join(timeout=10)


if __name__ == "__main__":
    main()
