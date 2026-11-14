"""Run the live POS API against a temporary copy of the active SQLite database."""

import json
import os
import secrets
import socket
import sqlite3
import threading
import time
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener
from uuid import uuid4

import uvicorn

from backend.credentials import database_path, hash_password


def exercise(base_url, admin_password, cashier_password):
    opener = build_opener(ProxyHandler({}))

    def call(path, *, body=None, token=None, expected=200, method=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = Request(
            f"{base_url}/api/{path}",
            data=json.dumps(body).encode() if body is not None else None,
            headers=headers,
            method=method,
        )
        try:
            response = opener.open(request, timeout=15)
        except HTTPError as error:
            response = error
        with response:
            data = json.load(response)
            if response.status != expected:
                raise AssertionError(f"{path}: expected HTTP {expected}, got {response.status}: {data}")
            return data

    admin = call("login", body={"password": admin_password})["token"]
    employee = {"name": "Smoke CASHIER", "role": "CASHIER", "password": cashier_password}
    cashier_id = call("employees", body=employee, token=admin)["employee_id"]
    call("employees", body=employee, token=admin, expected=409)
    cashier_login = call("login", body={"password": cashier_password})
    assert cashier_login["employee"]["checkedInAt"]
    cashier = cashier_login["token"]
    cashier = call("login", body={"password": cashier_password})["token"]
    attendance = [row for row in call("attendance", token=admin) if row["employeeId"] == cashier_id]
    assert len(attendance) == 1 and attendance[0]["checkOut"] is None
    call("orders", token=cashier, expected=403)
    call("settings", token=cashier, expected=403)
    call("employees", body=employee, token=cashier, expected=403)
    print("PASS login and cashier permissions", flush=True)

    initial = call("register/status", token=admin)["active"]
    if initial:
        call("register/handover", body={"shiftId": initial["id"]}, token=admin)
    category = call("categories", body={"name": "Smoke Test"}, token=admin)
    material = call("inventory", body={"name": "Smoke Stock", "unit": "unit", "stock": 20}, token=admin)
    product = call("products", body={
        "name": "Smoke Sale", "price": 100, "categoryId": category["id"],
        "recipes": [{"materialId": material["id"], "quantity": 2}],
    }, token=admin)

    def order(method, table=0):
        return {
            "submissionId": str(uuid4()), "paymentMethod": method,
            "orderType": "DINE_IN" if table else "TAKEAWAY", "tableNumber": table,
            "items": [{"productId": product["id"], "quantity": 1, "price": 100}],
        }

    def stock():
        return next(row["stock"] for row in call("inventory", token=admin) if row["id"] == material["id"])

    movement_path = f"inventory/{material['id']}/movements"
    call(movement_path, body={"kind": "RECEIVE", "quantity": 5, "reason": "Delivery"}, token=admin)
    assert stock() == 25
    call(movement_path, body={"kind": "WASTE", "quantity": 2, "reason": "Waste"}, token=admin)
    assert stock() == 23
    call(movement_path, body={"kind": "WASTE", "quantity": 24, "reason": "Too much"}, token=admin, expected=409)
    assert stock() == 23
    call(movement_path, body={"kind": "ADJUST", "quantity": 20, "reason": "Physical count"}, token=admin)
    assert stock() == 20
    rows = call(movement_path, token=admin)
    assert [(r["kind"], r["beforeStock"], r["afterStock"]) for r in rows] == [
        ("ADJUST", 23, 20), ("WASTE", 25, 23), ("RECEIVE", 20, 25), ("OPENING", 0, 20),
    ]
    call(movement_path, token=cashier, expected=403)
    print("PASS stock intake, waste, count adjustment, and audit history", flush=True)

    cash = order("CASH")
    first = call("orders", body=cash, token=cashier)
    assert first["receiptOk"]
    retry = call("orders", body=cash, token=cashier)
    assert retry["replayed"] and retry["orderId"] == first["orderId"] and stock() == 18
    call("orders", body={**cash, "paymentMethod": "CARD"}, token=cashier, expected=409)
    card = call("orders", body=order("CARD"), token=cashier)
    assert card["receiptOk"] and stock() == 16
    print("PASS cash/card sale, lost-response retry, and inventory deduction", flush=True)

    occupied = {row["tableNumber"] for row in call("tables/active", token=cashier)}
    number = next(number for number in range(1, 10000) if number not in occupied)
    dine = order("CARD", table=number)
    table = call("orders", body=dine, token=cashier)
    replay = call("orders", body=dine, token=cashier)
    assert replay["replayed"] and replay["orderId"] == table["orderId"] and stock() == 14
    path = f"orders/{table['orderId']}/checkout"
    call(path, body={"paymentMethod": "CARD", "expectedAmount": 99}, token=cashier, expected=409)
    assert call(path, body={"paymentMethod": "CARD", "expectedAmount": 100}, token=cashier)["receiptOk"]
    call(path, body={"paymentMethod": "CARD"}, token=cashier, expected=409)
    print("PASS dine-in retry and table settlement", flush=True)

    path = f"orders/{first['orderId']}/reverse"
    reversal = {"reason": "Smoke return", "restock": True}
    assert call(path, body=reversal, token=admin)["status"] == "REFUNDED"
    call(path, body=reversal, token=admin, expected=409)
    assert stock() == 16
    rows = call(movement_path, token=admin)
    assert [r["kind"] for r in rows[:4]] == ["RETURN", "SALE", "SALE", "SALE"]
    assert rows[0]["orderId"] == first["orderId"] and rows[0]["employeeName"] == "Smoke ADMIN"
    assert rows[1]["employeeName"] == "Smoke CASHIER"
    state = call("register/status", token=cashier)
    assert (state["active"]["netCash"], state["active"]["netCard"]) == (0, 200)
    print("PASS refund, stock restoration, and shift totals", flush=True)

    shift_id = state["active"]["id"]
    assert call("logout", body={}, token=cashier)["handedOver"]
    call("products", token=cashier, expected=401)
    attendance = [row for row in call("attendance", token=admin) if row["employeeId"] == cashier_id]
    assert len(attendance) == 1 and attendance[0]["checkOut"]
    review = {"shiftId": shift_id, "result": "CONFIRMED"}
    second_login = call("login", body={"password": cashier_password})["token"]
    call("register/review", body=review, token=second_login, expected=409)
    assert not call("logout", body={}, token=second_login)["handedOver"]
    call("register/review", body=review, token=admin)
    call("orders", body=order("CASH"), token=admin)
    state = call("register/status", token=admin)
    assert state["active"]["id"] != shift_id
    assert state["active"]["netCash"] == 100 and stock() == 14
    history = next(item for item in state["handovers"] if item["shiftId"] == shift_id)
    assert history["reviewedAt"] and history["netCard"] == 200
    print("PASS automatic attendance, logout handover, and continued sales", flush=True)
    other_password = secrets.token_urlsafe(18)
    other_id = call("employees", body={"name": "Smoke second cashier", "role": "CASHIER", "password": other_password},
                    token=admin)["employee_id"]
    first_cashier = call("login", body={"password": cashier_password})["token"]
    other_cashier = call("login", body={"password": other_password})["token"]
    active_id = call("register/status", token=other_cashier)["active"]["id"]
    assert not call("logout", body={}, token=first_cashier)["handedOver"]
    assert call("register/status", token=other_cashier)["active"]["id"] == active_id
    assert call("logout", body={}, token=other_cashier)["handedOver"]
    register = call("register/status", token=admin)
    assert register["active"] is None
    assert next(row for row in register["handovers"] if row["shiftId"] == active_id)["handedBy"] == other_id
    print("PASS shared register remains open until the last cashier exits", flush=True)

    role_path = f"employees/{cashier_id}/role"
    call(role_path, body={"role": "BARISTA"}, token=admin, method="PUT")
    login = call("login", body={"password": cashier_password})
    assert login["employee"]["role"] == "BARISTA" and login["employee"]["checkedInAt"] is not None
    call(role_path, body={"role": "ADMIN"}, token=login["token"], method="PUT", expected=403)
    print("PASS manager-only role changes", flush=True)



def main():
    # Fail promptly on hosts that disallow loopback (before Uvicorn starts).
    with closing(socket.socket()) as probe:
        probe.bind(("127.0.0.1", 0))
        probe.listen()
        try:
            with closing(socket.create_connection(probe.getsockname(), timeout=2)):
                pass
        except OSError as error:
            raise SystemExit(f"BLOCKED: cannot connect to localhost. Run the test in Windows PowerShell. {error}") from error

    source = database_path()
    if not source.is_file():
        raise SystemExit(f"Database not found: {source}")

    with TemporaryDirectory(prefix="cafe-one-smoke-") as folder:
        target = Path(folder) / "smoke.sqlite"
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as original:
            with closing(sqlite3.connect(target)) as copied, copied:
                original.backup(copied)
                passwords = [secrets.token_urlsafe(18), secrets.token_urlsafe(18)]
                copied.execute(
                    "INSERT INTO Employee (name, role, password) VALUES (?, ?, ?)",
                    ("Smoke ADMIN", "ADMIN", hash_password(passwords[0])),
                )
        os.environ["CAFE_ONE_DATABASE_PATH"] = str(target)

        from backend import api

        # The smoke test writes receipts to the temporary folder without opening Windows Photos.
        api.os.startfile = lambda _path: None
        with closing(socket.socket()) as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
            server = uvicorn.Server(uvicorn.Config(api.app, log_level="warning"))
            worker = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
            worker.start()
            try:
                deadline = time.monotonic() + 20
                while not server.started and worker.is_alive() and time.monotonic() < deadline:
                    time.sleep(0.1)
                if not server.started:
                    raise RuntimeError("The smoke-test API could not start.")
                exercise(f"http://127.0.0.1:{port}", *passwords)
            finally:
                server.should_exit = True
                worker.join(timeout=15)
                if worker.is_alive():
                    raise RuntimeError("The smoke-test API did not shut down cleanly.")


if __name__ == "__main__":
    main()
