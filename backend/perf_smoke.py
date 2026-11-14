"""Seed a high-volume temporary SQLite database and benchmark critical API endpoints."""

import json
import os
import secrets
import socket
import sqlite3
import threading
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener
from uuid import uuid4

import uvicorn

from backend.credentials import database_path, hash_password


def seed_high_volume_db(db_path: Path, admin_password: str, cashier_password: str) -> int:
    """Seed 12 categories, 120 products, 3000 orders (6000 items), and 1000 attendance logs."""
    now = datetime.now(timezone.utc)
    with closing(sqlite3.connect(db_path)) as conn, conn:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO Employee (name, role, password) VALUES (?, ?, ?)",
            ("Perf ADMIN", "ADMIN", hash_password(admin_password)),
        )
        admin_id = cur.lastrowid
        cur.execute(
            "INSERT INTO Employee (name, role, password) VALUES (?, ?, ?)",
            ("Perf CASHIER", "CASHIER", hash_password(cashier_password)),
        )
        cashier_id = cur.lastrowid

        category_ids: list[int] = []
        for c_idx in range(1, 13):
            cur.execute(
                "INSERT INTO Category (name, icon) VALUES (?, ?)",
                (f"دسته آزمایشی {c_idx}", None),
            )
            category_ids.append(cur.lastrowid)

        product_ids: list[int] = []
        for p_idx in range(1, 121):
            cat_id = category_ids[(p_idx - 1) % len(category_ids)]
            cur.execute(
                "INSERT INTO Product (name, price, categoryId, is_active) VALUES (?, ?, ?, 1)",
                (f"محصول تست {p_idx}", 45000 + (p_idx % 10) * 5000, cat_id),
            )
            product_ids.append(cur.lastrowid)

        order_items_batch: list[tuple[int, int, int, int]] = []
        for o_idx in range(3000):
            # Spread orders over the last 90 days, with the most recent batch landing today.
            days_ago = 0 if o_idx >= 2950 else (o_idx % 90) + 1
            order_dt = now - timedelta(days=days_ago, minutes=(o_idx % 600))
            created_ms = int(order_dt.timestamp() * 1000)
            settled_iso = (order_dt + timedelta(minutes=2)).isoformat()
            emp_id = cashier_id if o_idx % 2 == 0 else admin_id
            pay_method = "CARD" if o_idx % 3 != 0 else "CASH"
            order_type = "DINE_IN" if o_idx % 4 == 0 else "TAKEAWAY"
            table_num = (o_idx % 12) + 1 if order_type == "DINE_IN" else 0
            p1 = product_ids[o_idx % len(product_ids)]
            p2 = product_ids[(o_idx + 7) % len(product_ids)]
            total_amount = 100000

            cur.execute(
                """
                INSERT INTO [Order] (
                    employeeId, totalAmount, paymentType, paymentMethod,
                    status, orderType, tableNumber, createdAt, settledAt
                ) VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?)
                """,
                (emp_id, total_amount, pay_method, pay_method, order_type, table_num, created_ms, settled_iso),
            )
            order_id = cur.lastrowid
            order_items_batch.append((order_id, p1, 1, 50000))
            order_items_batch.append((order_id, p2, 1, 50000))

        cur.executemany(
            "INSERT INTO OrderItem (orderId, productId, quantity, price) VALUES (?, ?, ?, ?)",
            order_items_batch,
        )

        attendance_batch: list[tuple[int, int, int, int, str, float, float, float]] = []
        for a_idx in range(1000):
            att_day = now - timedelta(days=(a_idx % 120) + 1, hours=a_idx % 6)
            check_in_ms = int(att_day.timestamp() * 1000)
            check_out_ms = int((att_day + timedelta(hours=8)).timestamp() * 1000)
            emp_id = cashier_id if a_idx % 2 == 0 else admin_id
            attendance_batch.append(
                (emp_id, check_in_ms, check_in_ms, check_out_ms, "MORNING", 8.0, 0.0, 0.0)
            )

        cur.executemany(
            """
            INSERT INTO Attendance (
                employeeId, date, checkIn, checkOut, shiftType, workHours, overtime, deficit
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            attendance_batch,
        )

    return product_ids[0]


def exercise_perf(base_url: str, admin_password: str, cashier_password: str, product_id: int) -> None:
    opener = build_opener(ProxyHandler({}))
    created_receipts: list[Path] = []

    def call(path: str, *, body=None, token=None, expected=200, method=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = Request(
            f"{base_url}/api/{path}",
            data=json.dumps(body).encode() if body is not None else None,
            headers=headers,
            method=method,
        )
        t0 = time.perf_counter()
        try:
            response = opener.open(request, timeout=15)
        except HTTPError as error:
            response = error
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        with response:
            data = json.load(response)
            if response.status != expected:
                raise AssertionError(f"{path}: expected HTTP {expected}, got {response.status}: {data}")
            return data, elapsed_ms

    try:
        # 1. Strict role separation on loginMode
        staff_reject, _ = call("login", body={"password": admin_password, "loginMode": "staff"})
        assert staff_reject.get("success") is False and staff_reject.get("error")
        admin_reject, _ = call("login", body={"password": cashier_password, "loginMode": "admin"})
        assert admin_reject.get("success") is False and admin_reject.get("error")
        admin_login, _ = call("login", body={"password": admin_password, "loginMode": "admin"})
        cashier_login, _ = call("login", body={"password": cashier_password, "loginMode": "staff"})
        admin_token = admin_login["token"]
        cashier_token = cashier_login["token"]
        assert admin_login["employee"]["role"] == "ADMIN"
        assert cashier_login["employee"]["role"] == "CASHIER"
        print("PASS strict loginMode role separation (staff <-> admin rejected)", flush=True)

        # 2. Printer settings & test-print verification
        initial_settings, _ = call("settings", token=admin_token)
        assert "printMode" in initial_settings and "printerName" in initial_settings
        saved, _ = call(
            "settings",
            body={
                "cafeName": initial_settings.get("cafeName", "Cafe One"),
                "cafeSubtitle": initial_settings.get("cafeSubtitle", ""),
                "address": initial_settings.get("address", ""),
                "phone": initial_settings.get("phone", ""),
                "footerMessage": initial_settings.get("footerMessage", ""),
                "socialMedia": initial_settings.get("socialMedia", ""),
                "showLogo": initial_settings.get("showLogo", True),
                "printMode": "BOTH",
                "printerName": "POS-80C",
            },
            token=admin_token,
        )
        assert saved.get("printMode") == "BOTH" and saved.get("printerName") == "POS-80C"
        persisted, _ = call("settings", token=admin_token)
        assert persisted["printMode"] == "BOTH" and persisted["printerName"] == "POS-80C"

        test_print, tp_ms = call("settings/test-print", body={"printMode": "BOTH", "printerName": "POS-80C"}, token=admin_token)
        assert test_print.get("receiptOk") is True
        if test_print.get("receiptPath"):
            receipt_file = Path(test_print["receiptPath"])
            assert receipt_file.is_file(), f"Missing generated test receipt: {receipt_file}"
            created_receipts.append(receipt_file)
        print(f"PASS printer config & test-print ({tp_ms:.1f} ms)", flush=True)

        # 3. High-volume endpoint benchmarks (< 1000 ms budget each)
        products, products_ms = call("products", token=cashier_token)
        assert len(products) >= 120, f"Expected >= 120 products, got {len(products)}"
        assert products_ms < 1000.0, f"GET /api/products took {products_ms:.1f} ms"
        print(f"PASS GET /api/products ({len(products)} items, {products_ms:.1f} ms)", flush=True)

        today_summary, today_ms = call("register/today", token=cashier_token)
        assert "todayOrdersCount" in today_summary and "todayTotal" in today_summary
        assert today_ms < 1000.0, f"GET /api/register/today took {today_ms:.1f} ms"
        print(f"PASS GET /api/register/today (3000+ DB orders, {today_ms:.1f} ms)", flush=True)

        order_res, order_ms = call(
            "orders",
            body={
                "submissionId": str(uuid4()),
                "paymentMethod": "CASH",
                "orderType": "TAKEAWAY",
                "tableNumber": 0,
                "items": [{"productId": product_id, "quantity": 1, "price": 50000}],
            },
            token=cashier_token,
        )
        assert order_res.get("receiptOk") is True
        if order_res.get("receiptPath"):
            created_receipts.append(Path(order_res["receiptPath"]))
        assert order_ms < 1000.0, f"POST /api/orders took {order_ms:.1f} ms"
        print(f"PASS POST /api/orders ({order_ms:.1f} ms)", flush=True)

        orders_page, orders_ms = call("orders?limit=300", token=admin_token)
        assert len(orders_page) == 300, f"Expected 300 orders, got {len(orders_page)}"
        assert orders_ms < 1000.0, f"GET /api/orders?limit=300 took {orders_ms:.1f} ms"
        print(f"PASS GET /api/orders?limit=300 ({len(orders_page)} rows, {orders_ms:.1f} ms)", flush=True)

        att_page, att_ms = call("attendance?limit=300", token=admin_token)
        assert len(att_page) == 300, f"Expected 300 attendance rows, got {len(att_page)}"
        assert att_ms < 1000.0, f"GET /api/attendance?limit=300 took {att_ms:.1f} ms"
        print(f"PASS GET /api/attendance?limit=300 ({len(att_page)} rows, {att_ms:.1f} ms)", flush=True)
    finally:
        for path in created_receipts:
            try:
                if path.is_file():
                    path.unlink()
            except OSError:
                pass


def main() -> None:
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

    with TemporaryDirectory(prefix="cafe-one-perf-") as folder:
        target = Path(folder) / "perf.sqlite"
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as original:
            with closing(sqlite3.connect(target)) as copied:
                original.backup(copied)

        passwords = [secrets.token_urlsafe(18), secrets.token_urlsafe(18)]
        sample_product_id = seed_high_volume_db(target, *passwords)

        os.environ["CAFE_ONE_DATABASE_PATH"] = str(target)
        os.environ["CAFE_ONE_SILENT_RECEIPT"] = "1"

        from backend import api

        api.os.startfile = lambda _path: None
        with closing(socket.socket()) as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
            server = uvicorn.Server(uvicorn.Config(api.app, log_level="warning"))
            worker = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
            worker.start()
            try:
                deadline = time.monotonic() + 25
                while not server.started and worker.is_alive() and time.monotonic() < deadline:
                    time.sleep(0.1)
                if not server.started:
                    raise RuntimeError("The perf-smoke API could not start.")
                exercise_perf(f"http://127.0.0.1:{port}", *passwords, sample_product_id)
            finally:
                server.should_exit = True
                worker.join(timeout=15)
                if worker.is_alive():
                    raise RuntimeError("The perf-smoke API did not shut down cleanly.")


if __name__ == "__main__":
    main()
