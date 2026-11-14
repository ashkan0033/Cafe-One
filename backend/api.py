import os
import json
from hashlib import sha256
from uuid import UUID
from collections import defaultdict
from decimal import Decimal
from math import isfinite
import re
import secrets
from asyncio import to_thread
from time import monotonic

# غیرفعال کردن پروکسی سیستم برای ارتباطات داخلی دیتابیس (جلوگیری از هنگ کردن Prisma)
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
os.environ["no_proxy"] = "127.0.0.1,localhost"

from fastapi import FastAPI, HTTPException, File, Request, UploadFile
import shutil
from fastapi.responses import FileResponse, JSONResponse
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from prisma import Prisma
from prisma.errors import TransactionError
from contextlib import asynccontextmanager
from pydantic import BaseModel, ConfigDict, Field
from typing import List, Literal, Optional
from backend.credentials import PASSWORD_PREFIX, database_path, hash_password, verify_password
from backend.printer import CAFE_TIME_ZONE, dispatch_receipt, generate_receipt_image, receipt_image_path
from datetime import datetime, timezone


def as_utc(value):
    timestamp = datetime.fromisoformat(value) if isinstance(value, str) else value
    return timestamp.astimezone(timezone.utc) if timestamp.tzinfo else timestamp.replace(tzinfo=timezone.utc)


# -----------------
# توابع محاسباتی
# -----------------
def calculate_shift_metrics(check_in: datetime, check_out: datetime, shift_start: str, shift_end: str):
    """محاسبه کل ساعات حضور، اضافه‌کاری و کسر کار بر اساس شیفت موظفی"""
    check_in_utc = as_utc(check_in)
    check_out_utc = as_utc(check_out)

    work_duration = check_out_utc - check_in_utc
    work_hours = max(0.0, work_duration.total_seconds() / 3600.0)

    try:
        start_dt = datetime.strptime(shift_start, "%H:%M")
        end_dt = datetime.strptime(shift_end, "%H:%M")
        shift_duration = (end_dt - start_dt).total_seconds() / 3600.0
        if shift_duration < 0:
            shift_duration += 24
    except Exception:
        shift_duration = 8.0  # پیش‌فرض ۸ ساعت

    overtime = max(0.0, work_hours - shift_duration)
    deficit = max(0.0, shift_duration - work_hours)

    return round(work_hours, 2), round(overtime, 2), round(deficit, 2)


# -----------------
# تنظیمات آپلود
# -----------------
UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# مقداردهی دیتابیس با افزایش زمان تایم‌اوت
db = Prisma(
    datasource={"url": f"file:{database_path()}"},
    http={"timeout": 60},
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.connect()
    await db.query_raw("PRAGMA journal_mode=WAL;")
    await db.execute_raw("PRAGMA synchronous=NORMAL;")
    await db.query_raw("PRAGMA busy_timeout=5000;")
    async with db.tx() as tx:
        columns = await tx.query_raw('PRAGMA table_info("Order")')
        if not any(column["name"] == "settledAt" for column in columns):
            await tx.execute_raw('ALTER TABLE "Order" ADD COLUMN "settledAt" DATETIME')
        await tx.execute_raw("""
            CREATE TABLE IF NOT EXISTS "OrderInventory" (
                "orderId" INTEGER PRIMARY KEY REFERENCES "Order"("id") ON DELETE CASCADE,
                "deductions" TEXT NOT NULL
            )
        """)
        await tx.execute_raw("""
            CREATE TABLE IF NOT EXISTS "OrderReversal" (
                "orderId" INTEGER PRIMARY KEY REFERENCES "Order"("id"),
                "employeeId" INTEGER NOT NULL REFERENCES "Employee"("id"),
                "reason" TEXT NOT NULL,
                "restocked" INTEGER NOT NULL,
                "reversedAt" TEXT NOT NULL
            )
        """)
        await tx.execute_raw("""
            CREATE TABLE IF NOT EXISTS "RegisterClose" (
                "id" INTEGER PRIMARY KEY AUTOINCREMENT,
                "employeeId" INTEGER NOT NULL REFERENCES "Employee"("id"),
                "closedAt" TEXT NOT NULL,
                "expectedCash" INTEGER NOT NULL,
                "expectedCard" INTEGER NOT NULL,
                "countedCash" INTEGER NOT NULL,
                "countedCard" INTEGER NOT NULL
            )
        """)
        await tx.execute_raw("""
            CREATE TABLE IF NOT EXISTS "RegisterShift" (
                "id" INTEGER PRIMARY KEY AUTOINCREMENT,
                "openedBy" INTEGER NOT NULL REFERENCES "Employee"("id"),
                "openedAt" TEXT NOT NULL,
                "openingCash" INTEGER NOT NULL,
                "closeId" INTEGER REFERENCES "RegisterClose"("id")
            )
        """)
        shift_columns = await tx.query_raw('PRAGMA table_info("RegisterShift")')
        if not any(column["name"] == "handedOverAt" for column in shift_columns):
            await tx.execute_raw('ALTER TABLE "RegisterShift" ADD COLUMN "handedOverAt" TEXT')
            await tx.execute_raw('DROP INDEX IF EXISTS "RegisterShift_one_open"')
        await tx.execute_raw("""
            CREATE UNIQUE INDEX IF NOT EXISTS "RegisterShift_one_open"
            ON "RegisterShift" ((1)) WHERE "closeId" IS NULL AND "handedOverAt" IS NULL
        """)
        await tx.execute_raw("""
            CREATE TABLE IF NOT EXISTS "RegisterHandover" (
                "shiftId" INTEGER PRIMARY KEY REFERENCES "RegisterShift"("id"),
                "handedBy" INTEGER NOT NULL REFERENCES "Employee"("id"),
                "netCash" INTEGER NOT NULL,
                "netCard" INTEGER NOT NULL,
                "reviewedBy" INTEGER REFERENCES "Employee"("id"),
                "reviewedAt" TEXT,
                "differenceNote" TEXT
            )
        """)
        await tx.execute_raw("""
            CREATE TABLE IF NOT EXISTS "RegisterEntry" (
                "shiftId" INTEGER NOT NULL REFERENCES "RegisterShift"("id"),
                "orderId" INTEGER NOT NULL REFERENCES "Order"("id"),
                "employeeId" INTEGER NOT NULL REFERENCES "Employee"("id"),
                "kind" TEXT NOT NULL,
                "method" TEXT NOT NULL,
                "amount" INTEGER NOT NULL,
                "recordedAt" TEXT NOT NULL,
                PRIMARY KEY ("orderId", "kind")
            )
        """)
        await tx.execute_raw('CREATE INDEX IF NOT EXISTS "RegisterEntry_shift" ON "RegisterEntry" ("shiftId")')
        await tx.execute_raw("""
            CREATE TABLE IF NOT EXISTS "OrderSubmission" (
                "employeeId" INTEGER NOT NULL REFERENCES "Employee"("id"),
                "key" TEXT NOT NULL,
                "payloadHash" TEXT NOT NULL,
                "orderId" INTEGER REFERENCES "Order"("id"),
                "orderStatus" TEXT,
                PRIMARY KEY ("employeeId", "key")
            )
        """)
        await tx.execute_raw("""
            CREATE TABLE IF NOT EXISTS "InventoryMovement" (
                "id" INTEGER PRIMARY KEY AUTOINCREMENT,
                "materialId" INTEGER NOT NULL REFERENCES "RawMaterial"("id"),
                "employeeId" INTEGER NOT NULL REFERENCES "Employee"("id"),
                "orderId" INTEGER REFERENCES "Order"("id"),
                "kind" TEXT NOT NULL,
                "unit" TEXT NOT NULL,
                "beforeStock" REAL NOT NULL,
                "afterStock" REAL NOT NULL,
                "reason" TEXT NOT NULL,
                "recordedAt" TEXT NOT NULL
            )
        """)
        await tx.execute_raw('CREATE INDEX IF NOT EXISTS "InventoryMovement_material" ON "InventoryMovement" ("materialId", "id")')
        await tx.execute_raw('CREATE INDEX IF NOT EXISTS "Order_status_createdAt" ON "Order" ("status", "createdAt" DESC)')
        await tx.execute_raw('CREATE INDEX IF NOT EXISTS "Order_settledAt" ON "Order" ("settledAt" DESC)')
        await tx.execute_raw('CREATE INDEX IF NOT EXISTS "Order_PendingTable" ON "Order" ("orderType", "status", "tableNumber")')
        await tx.execute_raw('CREATE INDEX IF NOT EXISTS "OrderItem_orderId" ON "OrderItem" ("orderId")')
        await tx.execute_raw('CREATE INDEX IF NOT EXISTS "Attendance_emp_open" ON "Attendance" ("employeeId", "checkOut")')
        await tx.execute_raw('CREATE INDEX IF NOT EXISTS "Attendance_checkIn" ON "Attendance" ("checkIn" DESC)')
        await tx.execute_raw("""
            CREATE TABLE IF NOT EXISTS "PrinterConfig" (
                "id" INTEGER PRIMARY KEY CHECK ("id" = 1),
                "printMode" TEXT NOT NULL DEFAULT 'PREVIEW',
                "printerName" TEXT NOT NULL DEFAULT ''
            )
        """)
        await tx.execute_raw('INSERT OR IGNORE INTO "PrinterConfig" ("id", "printMode", "printerName") VALUES (1, \'PREVIEW\', \'\')')
    for employee in await db.employee.find_many(where={"NOT": {"password": {"startswith": PASSWORD_PREFIX}}}):
        encoded = await to_thread(hash_password, employee.password)
        await db.employee.update_many(
            where={"id": employee.id, "password": employee.password},
            data={"password": encoded},
        )

    # ساخت تنظیمات پیش‌فرض اگر وجود نداشت
    if await db.setting.count() == 0:
        await db.setting.create(data={})

    # ساخت دیتای اولیه با ساختار جدید اسکیما
    if await db.category.count() == 0:
        cat = await db.category.create(data={"name": "نوشیدنی گرم", "icon": "☕"})
        await db.product.create(data={
            "name": "لاته آرت",
            "price": 120000,
            "categoryId": cat.id,
            "is_active": True
        })
    yield
    await db.disconnect()


app = FastAPI(title="Cafe One API", lifespan=lifespan)

SESSION_TTL = 8 * 60 * 60
sessions: dict[str, tuple[int, float]] = {}
POS_ROUTES = {
    ("POST", "/api/logout"),
    ("GET", "/api/products"),
    ("GET", "/api/categories"),
    ("GET", "/api/tables/active"),
    ("POST", "/api/orders"),
    ("GET", "/api/register/status"),
    ("GET", "/api/register/today"),
    ("POST", "/api/register/handover"),
    ("POST", "/api/register/review"),
}


@app.middleware("http")
async def require_session(request: Request, call_next):
    path = request.url.path.rstrip("/")
    method = request.method
    if not path.startswith("/api/") or (method, path) == ("POST", "/api/login"):
        return await call_next(request)

    scheme, _, token = request.headers.get("Authorization", "").partition(" ")
    session = sessions.get(token) if scheme.lower() == "bearer" else None
    if session is None or session[1] <= monotonic():
        if session is not None:
            sessions.pop(token, None)
        return JSONResponse({"detail": "Session expired or missing"}, status_code=401)

    employee = await db.employee.find_unique(where={"id": session[0]})
    if not employee or not employee.isActive:
        sessions.pop(token, None)
        return JSONResponse({"detail": "Employee is inactive"}, status_code=401)

    can_use_pos = (method, path) in POS_ROUTES or (
        method == "POST" and re.fullmatch(r"/api/orders/[0-9]+/checkout", path)
    )
    if employee.role != "ADMIN" and not can_use_pos:
        return JSONResponse({"detail": "Administrator access required"}, status_code=403)

    request.state.employee_id = employee.id
    request.state.employee = employee
    request.state.session_token = token
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# -----------------
# مدل‌های Pydantic (ساختار داده‌ها)
# -----------------
class OrderItemCreate(BaseModel):
    productId: int = Field(gt=0)
    quantity: int = Field(gt=0, le=2_147_483_647)
    price: int = Field(ge=0)


class OrderCreate(BaseModel):
    submissionId: UUID | None = None
    items: List[OrderItemCreate] = Field(min_length=1)
    paymentMethod: Literal["CARD", "CASH"] = "CARD"
    orderType: Literal["TAKEAWAY", "DINE_IN"] = "TAKEAWAY"
    tableNumber: int = Field(default=0, ge=0, le=2_147_483_647)


class RawMaterialCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    unit: str = Field(min_length=1, max_length=40)
    stock: float = Field(ge=0, allow_inf_nan=False)


class RawMaterialUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=120)
    unit: str | None = Field(default=None, min_length=1, max_length=40)


class InventoryChange(BaseModel):
    kind: Literal["RECEIVE", "WASTE", "ADJUST"]
    quantity: float = Field(ge=0, allow_inf_nan=False)
    reason: str = Field(min_length=1, max_length=300)


class CategoryCreate(BaseModel):
    name: str
    icon: Optional[str] = "☕"


class CategoryUpdate(BaseModel):
    name: Optional[str] = None
    icon: Optional[str] = None


class RecipeItemCreate(BaseModel):
    materialId: int
    quantity: float = Field(gt=0, allow_inf_nan=False)


class RecipeStandaloneCreate(BaseModel):
    productId: int
    materialId: int
    quantity: float = Field(gt=0, allow_inf_nan=False)


class ProductCreate(BaseModel):
    name: str
    price: int
    categoryId: int
    recipes: List[RecipeItemCreate] = []


class ProductUpdate(BaseModel):
    name: Optional[str] = None
    price: Optional[int] = Field(default=None, ge=0)
    categoryId: Optional[int] = None
    is_active: Optional[bool] = None


class SettingUpdate(BaseModel):
    cafeName: str
    cafeSubtitle: str
    address: str
    phone: str
    footerMessage: str
    socialMedia: str
    showLogo: bool
    printMode: Optional[Literal["PREVIEW", "PRINTER", "BOTH", "NONE"]] = None
    printerName: Optional[str] = None


class TestPrintRequest(BaseModel):
    printMode: Optional[Literal["PREVIEW", "PRINTER", "BOTH", "NONE"]] = None
    printerName: Optional[str] = None


class EmployeeCreate(BaseModel):
    name: str
    role: Literal["ADMIN", "CASHIER", "BARISTA", "WAITER"]
    phone: str | None = None
    password: str = Field(min_length=4, max_length=128)
    baseSalary: float = 0
    hourlyRate: float = 0
    shiftStart: str = "08:00"
    shiftEnd: str = "16:00"


class EmployeeUpdate(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    password: Optional[str] = Field(default=None, min_length=4, max_length=128)
    baseSalary: Optional[float] = Field(default=None, ge=0)
    hourlyRate: Optional[float] = Field(default=None, ge=0)
    shiftStart: Optional[str] = None
    shiftEnd: Optional[str] = None
    isActive: Optional[bool] = None


class EmployeeResponse(BaseModel):
    id: int
    name: str
    role: str
    phone: str | None = None
    baseSalary: float
    hourlyRate: float
    shiftStart: str
    shiftEnd: str
    isActive: bool
    createdAt: datetime


class LoginRequest(BaseModel):
    password: str
    loginMode: Optional[Literal["staff", "admin"]] = None


class CheckInRequest(BaseModel):
    employeeId: int
    shiftType: str = "MORNING"


class CheckOutRequest(BaseModel):
    note: Optional[str] = None


class LeaveCreate(BaseModel):
    employeeId: int
    startDate: str
    endDate: str
    type: str = "PAID"
    reason: str = ""


class LeaveStatusUpdate(BaseModel):
    status: Literal["APPROVED", "REJECTED", "PENDING"]


# -----------------
# API های سیستم
# -----------------

# -- API آپلود عکس لوگو --
@app.post("/api/upload-logo")
async def upload_logo(file: UploadFile = File(...)):
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="فقط فایل‌های تصویری مجاز هستند")

    file_ext = (file.filename or "logo.png").split(".")[-1]
    file_path = os.path.join(UPLOAD_DIR, f"logo.{file_ext}")

    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    setting = await db.setting.find_first()
    if setting:
        await db.setting.update(
            where={"id": setting.id},
            data={"logoPath": file_path}
        )
    else:
        await db.setting.create(data={"logoPath": file_path})

    return {"message": "لوگو با موفقیت آپلود شد", "logoPath": file_path}


async def get_printer_config():
    rows = await db.query_raw('SELECT "printMode", "printerName" FROM "PrinterConfig" WHERE "id" = 1')
    if rows:
        return {
            "printMode": rows[0].get("printMode") or "PREVIEW",
            "printerName": rows[0].get("printerName") or "",
        }
    return {"printMode": "PREVIEW", "printerName": ""}


def resolve_portable_logo_path(stored_path: str | None) -> str | None:
    if not stored_path:
        return None
    if os.path.isfile(stored_path):
        return stored_path
    filename = stored_path.replace("\\", "/").split("/")[-1]
    portable = os.path.join(UPLOAD_DIR, filename)
    return portable if os.path.isfile(portable) else None


@app.get("/api/settings/logo")
async def get_logo():
    setting = await db.setting.find_first()
    resolved = resolve_portable_logo_path(setting.logoPath if setting else None)
    if not resolved:
        raise HTTPException(status_code=404, detail="لوگو یافت نشد")
    return FileResponse(resolved)


# -- API تنظیمات کافه --
@app.get("/api/settings")
async def get_settings():
    setting = await db.setting.find_first()
    if not setting:
        setting = await db.setting.create(data={})
    printer_cfg = await get_printer_config()
    return {**setting.model_dump(), **printer_cfg}


@app.post("/api/settings")
async def update_settings(settings: SettingUpdate):
    base_data = {
        "cafeName": settings.cafeName,
        "cafeSubtitle": settings.cafeSubtitle,
        "address": settings.address,
        "phone": settings.phone,
        "footerMessage": settings.footerMessage,
        "socialMedia": settings.socialMedia,
        "showLogo": settings.showLogo,
    }
    existing = await db.setting.find_first()
    if existing:
        saved = await db.setting.update(where={"id": existing.id}, data=base_data)
    else:
        saved = await db.setting.create(data=base_data)

    current_printer = await get_printer_config()
    next_mode = settings.printMode if settings.printMode is not None else current_printer["printMode"]
    next_name = (settings.printerName or "").strip() if settings.printerName is not None else current_printer["printerName"]
    await db.execute_raw(
        """
        INSERT INTO "PrinterConfig" ("id", "printMode", "printerName")
        VALUES (1, ?, ?)
        ON CONFLICT ("id") DO UPDATE SET "printMode" = excluded."printMode", "printerName" = excluded."printerName"
        """,
        next_mode,
        next_name,
    )
    return {**saved.model_dump(), "printMode": next_mode, "printerName": next_name}


@app.post("/api/settings/test-print")
async def test_print_receipt(req: TestPrintRequest | None = None):
    setting = await db.setting.find_first()
    settings_dict = setting.model_dump() if setting else {}
    printer_cfg = await get_printer_config()
    mode = (req.printMode if req and req.printMode is not None else printer_cfg["printMode"]) or "PREVIEW"
    pname = ((req.printerName if req and req.printerName is not None else printer_cfg["printerName"]) or "").strip()
    sample_items = [
        {"name": "اسپرسو دبل", "quantity": 1, "price": 85000},
        {"name": "لاته کلاسیک", "quantity": 1, "price": 120000},
    ]
    sample_meta = {"orderType": "DINE_IN", "tableNumber": 1, "paymentMethod": "CARD"}
    try:
        path = await to_thread(
            generate_receipt_image, 0, sample_items, 205000, settings_dict, None, sample_meta
        )
        return await to_thread(dispatch_receipt, path, mode, pname)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"خطا در تست چاپگر: {e}")


# -- API دسته‌بندی‌ها --
@app.get("/api/categories")
async def get_categories():
    return await db.category.find_many()


@app.post("/api/categories")
async def create_category(cat: CategoryCreate):
    name = cat.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="نام دسته‌بندی را وارد کنید.")
    return await db.category.create(data={"name": name, "icon": cat.icon or "☕"})


@app.put("/api/categories/{category_id}")
async def update_category(category_id: int, data: CategoryUpdate):
    update_data = data.model_dump(exclude_unset=True)
    if "name" in update_data:
        update_data["name"] = (update_data["name"] or "").strip()
        if not update_data["name"]:
            raise HTTPException(status_code=422, detail="نام دسته‌بندی نمی‌تواند خالی باشد.")
    try:
        return await db.category.update(
            where={"id": category_id},
            data=update_data
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"خطا در ویرایش دسته‌بندی: {e}")


@app.delete("/api/categories/{category_id}")
async def delete_category(category_id: int):
    count = await db.product.count(where={"categoryId": category_id})
    if count > 0:
        raise HTTPException(status_code=409, detail="ابتدا باید محصولات این دسته‌بندی را پاک یا به دسته‌بندی دیگری منتقل کنید.")
    try:
        await db.category.delete(where={"id": category_id})
        return {"success": True}
    except Exception:
        raise HTTPException(status_code=409, detail="ابتدا باید محصولات این دسته‌بندی را پاک کنید.")


# -- API انبار --
@app.get("/api/inventory")
async def get_inventory():
    return await db.rawmaterial.find_many()


async def record_inventory_movement(tx, material, employee_id, kind, before, after, reason, order_id=None):
    await tx.execute_raw(
        """
        INSERT INTO "InventoryMovement"
            ("materialId", "employeeId", "orderId", "kind", "unit", "beforeStock", "afterStock", "reason", "recordedAt")
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        material.id, employee_id, order_id, kind, material.unit, before, after, reason, datetime.now(timezone.utc).isoformat(),
    )


async def change_inventory(tx, material_id, employee_id, kind, quantity, reason, order_id=None):
    material = await tx.rawmaterial.find_unique(where={"id": material_id})
    if not material:
        raise HTTPException(status_code=409, detail="ماده اولیه در انبار پیدا نشد.")
    before = material.stock
    if kind == "ADJUST":
        after = quantity
    elif kind in {"SALE", "WASTE"}:
        after = float(Decimal(str(before)) - Decimal(str(quantity)))
    else:
        after = float(Decimal(str(before)) + Decimal(str(quantity)))
    if after < 0:
        raise HTTPException(status_code=409, detail=f"موجودی «{material.name}» کافی نیست.")
    if not isfinite(after):
        raise HTTPException(status_code=422, detail="مقدار موجودی معتبر نیست.")
    if after == before:
        return
    changed = await tx.rawmaterial.update_many(
        where={"id": material_id, "stock": before}, data={"stock": after}
    )
    if changed != 1:
        raise HTTPException(status_code=409, detail="موجودی تغییر کرده است. دوباره بررسی کنید.")
    await record_inventory_movement(tx, material, employee_id, kind, before, after, reason, order_id)


@app.post("/api/inventory")
async def add_raw_material(material: RawMaterialCreate, request: Request):
    name, unit = material.name.strip(), material.unit.strip()
    if not name or not unit:
        raise HTTPException(status_code=422, detail="نام و واحد ماده را وارد کنید.")
    async with db.tx() as tx:
        created = await tx.rawmaterial.create(data={"name": name, "unit": unit, "stock": material.stock})
        if material.stock:
            await record_inventory_movement(
                tx, created, request.state.employee_id, "OPENING", 0, material.stock, "موجودی اولیه هنگام تعریف ماده"
            )
        return created


@app.put("/api/inventory/{material_id}")
async def update_raw_material(material_id: int, data: RawMaterialUpdate):
    changes = {field: value.strip() if value else "" for field, value in data.model_dump(exclude_unset=True).items()}
    if any(not value for value in changes.values()):
        raise HTTPException(status_code=422, detail="نام و واحد ماده را وارد کنید.")
    async with db.tx() as tx:
        material = await tx.rawmaterial.find_unique(where={"id": material_id}, include={"recipes": True})
        if not material:
            raise HTTPException(status_code=404, detail="ماده اولیه پیدا نشد.")
        if not changes:
            return material
        history = await tx.query_raw(
            'SELECT 1 AS "found" FROM "InventoryMovement" WHERE "materialId" = ? LIMIT 1', material_id
        )
        if changes.get("unit", material.unit) != material.unit and (material.stock or material.recipes or history):
            raise HTTPException(status_code=409, detail="واحد ماده‌ای که موجودی، فرمول یا سابقه دارد قابل تغییر نیست.")
        return await tx.rawmaterial.update(where={"id": material_id}, data=changes)


@app.post("/api/inventory/{material_id}/movements")
async def apply_inventory_change(material_id: int, change: InventoryChange, request: Request):
    reason = change.reason.strip()
    if not reason or (change.kind != "ADJUST" and change.quantity == 0):
        raise HTTPException(status_code=422, detail="دلیل و مقدار معتبر وارد کنید.")
    try:
        async with db.tx() as tx:
            await change_inventory(tx, material_id, request.state.employee_id, change.kind, change.quantity, reason)
    except TransactionError as exc:
        raise HTTPException(status_code=503, detail="ثبت گردش کامل نشد. سابقه انبار را بررسی کنید.") from exc
    return {"success": True}


@app.get("/api/inventory/{material_id}/movements")
async def get_inventory_movements(material_id: int, before: int | None = None):
    return await db.query_raw(
        """
        SELECT m.*, e."name" AS "employeeName"
        FROM "InventoryMovement" m JOIN "Employee" e ON e."id" = m."employeeId"
        WHERE m."materialId" = ? AND (? IS NULL OR m."id" < ?)
        ORDER BY m."id" DESC LIMIT 50
        """, material_id, before, before,
    )


@app.delete("/api/inventory/{material_id}")
async def delete_raw_material(material_id: int):
    async with db.tx() as tx:
        material = await tx.rawmaterial.find_unique(where={"id": material_id}, include={"recipes": True})
        if not material:
            raise HTTPException(status_code=404, detail="ماده اولیه پیدا نشد.")
        history = await tx.query_raw(
            'SELECT 1 AS "found" FROM "InventoryMovement" WHERE "materialId" = ? LIMIT 1', material_id
        )
        if material.stock or material.recipes or history:
            raise HTTPException(status_code=409, detail="ماده دارای موجودی، فرمول یا سابقه گردش قابل حذف نیست.")
        await tx.rawmaterial.delete(where={"id": material_id})
    return {"success": True}


# -- API فرمول‌ها (BOM) --
@app.post("/api/recipes")
async def create_recipe(recipe: RecipeStandaloneCreate):
    try:
        existing = await db.recipe.find_first(
            where={"productId": recipe.productId, "materialId": recipe.materialId}
        )
        if existing:
            updated = await db.recipe.update(
                where={"id": existing.id},
                data={"quantity": recipe.quantity}
            )
            return {"success": True, "recipeId": updated.id, "updated": True}
        new_recipe = await db.recipe.create(
            data={
                "productId": recipe.productId,
                "materialId": recipe.materialId,
                "quantity": recipe.quantity
            }
        )
        return {"success": True, "recipeId": new_recipe.id, "updated": False}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"خطا در ثبت فرمول: {e}")


@app.delete("/api/recipes/{recipe_id}")
async def delete_recipe(recipe_id: int):
    try:
        await db.recipe.delete(where={"id": recipe_id})
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"خطا در حذف فرمول: {e}")


# -- API محصولات --
@app.get("/api/products")
async def get_products():
    return await db.product.find_many(
        include={
            "category": True,
            "recipes": True
        }
    )


@app.post("/api/products")
async def create_product(prod: ProductCreate):
    name = prod.name.strip()
    if not name or prod.price < 0:
        raise HTTPException(status_code=422, detail="نام و قیمت معتبر وارد کنید.")
    return await db.product.create(
        data={
            "name": name,
            "price": prod.price,
            "categoryId": prod.categoryId,
            "recipes": {
                "create": [{"materialId": r.materialId, "quantity": r.quantity} for r in prod.recipes]
            }
        },
        include={"recipes": True, "category": True}
    )


@app.put("/api/products/{product_id}")
async def update_product(product_id: int, data: ProductUpdate):
    update_data = data.model_dump(exclude_unset=True)
    if "name" in update_data:
        update_data["name"] = (update_data["name"] or "").strip()
        if not update_data["name"]:
            raise HTTPException(status_code=422, detail="نام محصول نمی‌تواند خالی باشد.")
    try:
        return await db.product.update(
            where={"id": product_id},
            data=update_data,
            include={"category": True, "recipes": True}
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"خطا در ویرایش محصول: {e}")


@app.delete("/api/products/{product_id}")
async def delete_product(product_id: int):
    product = await db.product.find_unique(where={"id": product_id})
    if not product:
        raise HTTPException(status_code=404, detail="محصول پیدا نشد.")
    order_count = await db.orderitem.count(where={"productId": product_id})
    if order_count > 0:
        await db.product.update(where={"id": product_id}, data={"is_active": False})
        return {
            "success": True,
            "archived": True,
            "message": "این محصول در فاکتورهای قبلی ثبت شده است؛ بنابراین برای حفظ سوابق مالی، از منوی فروش غیرفعال (آرشیو) شد."
        }
    try:
        await db.product.delete(where={"id": product_id})
        return {"success": True, "archived": False}
    except Exception as e:
        raise HTTPException(status_code=409, detail=f"خطا در حذف محصول: {e}")


async def issue_receipt(
    order_id: int,
    items: list,
    total_amount: int,
    sold_at: datetime | None = None,
    order_meta: dict | None = None,
):
    """ساخت و ارسال فیش مطابق تنظیمات چاپگر (پیش‌نمایش، چاپ مستقیم یا هر دو)."""
    try:
        setting = await db.setting.find_first()
        settings_dict = setting.model_dump() if setting else {}
        printer_cfg = await get_printer_config()
        path = await to_thread(
            generate_receipt_image, order_id, items, total_amount, settings_dict, sold_at, order_meta
        )
        return await to_thread(dispatch_receipt, path, printer_cfg["printMode"], printer_cfg["printerName"])
    except Exception as e:
        print(f"خطا در تولید یا چاپ فیش: {e}")
        return {"receiptOk": False, "receiptError": str(e)}


# ---------------------------------------------
# ۱. آپدیت روت ثبت سفارش (پشتیبانی از میز باز + کسر اتوماتیک از انبار)
# ---------------------------------------------
REGISTER_OPEN = """
    SELECT s.*, e."name" AS "openedByName"
    FROM "RegisterShift" s JOIN "Employee" e ON e."id" = s."openedBy"
    WHERE s."closeId" IS NULL AND s."handedOverAt" IS NULL
"""


async def get_or_open_shift(tx, employee_id: int):
    await tx.execute_raw(
        """
        INSERT INTO "RegisterShift" ("openedBy", "openedAt", "openingCash")
        SELECT ?, ?, 0 WHERE NOT EXISTS (
            SELECT 1 FROM "RegisterShift" WHERE "closeId" IS NULL AND "handedOverAt" IS NULL
        )
        """,
        employee_id, datetime.now(timezone.utc).isoformat(),
    )
    return (await tx.query_raw(REGISTER_OPEN))[0]


async def shift_totals(tx, shift_id: int):
    rows = await tx.query_raw(
        """
        SELECT "method", SUM("amount") AS "amount" FROM "RegisterEntry"
        WHERE "shiftId" = ? AND "kind" IN ('SALE', 'REFUND') GROUP BY "method"
        """, shift_id,
    )
    amounts = {row["method"]: row["amount"] for row in rows}
    return {"netCash": amounts.get("CASH", 0), "netCard": amounts.get("CARD", 0)}


async def record_register_entry(tx, shift_id, order_id, employee_id, kind, method, amount):
    await tx.execute_raw(
        """
        INSERT INTO "RegisterEntry" ("shiftId", "orderId", "employeeId", "kind", "method", "amount", "recordedAt")
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        shift_id, order_id, employee_id, kind, method, amount, datetime.now(timezone.utc).isoformat(),
    )


@app.post("/api/orders")
async def create_order(order: OrderCreate, request: Request):
    dine_in = order.orderType == "DINE_IN"
    if dine_in and order.tableNumber == 0:
        raise HTTPException(status_code=422, detail="شماره میز را وارد کنید.")

    status = "PENDING" if dine_in else "COMPLETED"
    receipt_items = []
    employee_id = request.state.employee_id
    submission_key = str(order.submissionId) if order.submissionId else None
    try:
        async with db.tx() as tx:
            if submission_key:
                payload_hash = sha256(order.model_dump_json(exclude={"submissionId"}).encode()).hexdigest()
                inserted = await tx.execute_raw(
                    """
                    INSERT INTO "OrderSubmission" ("employeeId", "key", "payloadHash")
                    VALUES (?, ?, ?) ON CONFLICT ("employeeId", "key") DO NOTHING
                    """,
                    employee_id, submission_key, payload_hash,
                )
                if not inserted:
                    prior = (await tx.query_raw(
                        'SELECT * FROM "OrderSubmission" WHERE "employeeId" = ? AND "key" = ?',
                        employee_id, submission_key,
                    ))[0]
                    if prior["payloadHash"] != payload_hash:
                        raise HTTPException(status_code=409, detail="این شناسه قبلاً برای سفارش دیگری استفاده شده است.")
                    return {
                        "status": "success", "orderId": prior["orderId"],
                        "orderStatus": prior["orderStatus"], "replayed": True,
                    }
            shift = await get_or_open_shift(tx, request.state.employee_id)
            products = await tx.product.find_many(
                where={"id": {"in": list({item.productId for item in order.items})}},
                include={"recipes": True},
            )
            products_by_id = {product.id: product for product in products}
            order_items = []
            material_totals = defaultdict(Decimal)
            total = 0
            for item in order.items:
                product = products_by_id.get(item.productId)
                if not product or not product.is_active:
                    raise HTTPException(status_code=409, detail="یکی از محصولات دیگر قابل فروش نیست.")
                if product.price < 0 or item.price != product.price:
                    raise HTTPException(status_code=409, detail=f"قیمت «{product.name}» تغییر کرده است. منو را دوباره بارگیری کنید.")
                line = {"quantity": item.quantity, "price": product.price}
                order_items.append({"productId": product.id, **line})
                receipt_items.append({"name": product.name, **line})
                total += product.price * item.quantity
                for recipe in product.recipes or []:
                    if not isfinite(recipe.quantity) or recipe.quantity <= 0:
                        raise HTTPException(status_code=409, detail=f"مقدار مواد در دستور تهیه «{product.name}» معتبر نیست.")
                    material_totals[recipe.materialId] += Decimal(str(recipe.quantity)) * item.quantity

            deductions = {material_id: float(quantity) for material_id, quantity in material_totals.items()}

            existing = None
            if dine_in:
                existing = await tx.order.find_first(
                    where={"orderType": "DINE_IN", "tableNumber": order.tableNumber, "status": "PENDING"}
                )
            if total + (existing.totalAmount if existing else 0) > 2_147_483_647:
                raise HTTPException(status_code=422, detail="مبلغ سفارش از حد مجاز بیشتر است.")

            if existing:
                saved = await tx.order.update(
                    where={"id": existing.id},
                    data={"totalAmount": {"increment": total}, "items": {"create": order_items}},
                )
            else:
                saved = await tx.order.create(data={
                    "employeeId": request.state.employee_id,
                    "totalAmount": total,
                    "status": status,
                    "orderType": order.orderType,
                    "tableNumber": order.tableNumber if dine_in else 0,
                    "paymentType": order.paymentMethod,
                    "paymentMethod": order.paymentMethod,
                    "items": {"create": order_items},
                })
            for material_id, quantity in deductions.items():
                await change_inventory(tx, material_id, employee_id, "SALE", quantity, "مصرف سفارش", saved.id)
            if existing:
                snapshots = await tx.query_raw(
                    'SELECT "deductions" FROM "OrderInventory" WHERE "orderId" = ?', saved.id
                )
                if snapshots:
                    recorded = json.loads(snapshots[0]["deductions"])
                    for material_id, quantity in deductions.items():
                        key = str(material_id)
                        recorded[key] = float(Decimal(str(recorded.get(key, 0))) + Decimal(str(quantity)))
                    await tx.execute_raw(
                        'UPDATE "OrderInventory" SET "deductions" = ? WHERE "orderId" = ?',
                        json.dumps(recorded, allow_nan=False), saved.id,
                    )
            else:
                await tx.execute_raw(
                    'INSERT INTO "OrderInventory" ("orderId", "deductions") VALUES (?, ?)',
                    saved.id, json.dumps(deductions, allow_nan=False),
                )
            if not dine_in:
                await record_register_entry(
                    tx, shift["id"], saved.id, request.state.employee_id, "SALE", order.paymentMethod, total,
                )
            if submission_key:
                await tx.execute_raw(
                    """
                    UPDATE "OrderSubmission" SET "orderId" = ?, "orderStatus" = ?
                    WHERE "employeeId" = ? AND "key" = ?
                    """,
                    saved.id, status, employee_id, submission_key,
                )
    except TransactionError as exc:
        raise HTTPException(status_code=503, detail="ثبت سفارش کامل نشد. وضعیت سفارش را بررسی کنید.") from exc

    result = {"status": "success", "orderId": saved.id, "orderStatus": status}
    if status == "COMPLETED":
        result.update(
            await issue_receipt(
                saved.id,
                receipt_items,
                total,
                order_meta={"orderType": order.orderType, "tableNumber": order.tableNumber, "paymentMethod": order.paymentMethod},
            )
        )
    return result


@app.get("/api/tables/active")
async def get_active_tables():
    return await db.order.find_many(
        where={"status": "PENDING"},
        include={"items": {"include": {"product": True}}},
        order={"createdAt": "desc"}
    )


@app.post("/api/login")
async def login(req: LoginRequest):
    if await db.employee.count() == 0:
        await db.employee.create(data={
            "name": "مدیر سیستم",
            "role": "ADMIN",
            "password": await to_thread(hash_password, "123"),
        })

    candidates = await db.employee.find_many(where={"isActive": True}, order={"id": "asc"})
    employee = await to_thread(
        lambda: next((candidate for candidate in candidates if verify_password(req.password, candidate.password)), None)
    )
    if not employee:
        return {"success": False, "error": "رمز عبور اشتباه است"}

    if req.loginMode == "staff" and employee.role == "ADMIN":
        return {"success": False, "error": "این رمز متعلق به مدیر سیستم است؛ لطفاً از تب «مدیریت» وارد شوید."}
    if req.loginMode == "admin" and employee.role != "ADMIN":
        return {"success": False, "error": "حساب شما دسترسی مدیریت ندارد؛ لطفاً از تب «پرسنل» وارد شوید."}

    async with db.tx() as tx:
        # Acquire the SQLite write lock before checking for an existing attendance.
        await tx.execute_raw('UPDATE "Employee" SET "id" = "id" WHERE "id" = ?', employee.id)
        attendance = await tx.attendance.find_first(
            where={"employeeId": employee.id, "checkOut": None}, order={"checkIn": "desc"}
        )
        if not attendance:
            attendance = await tx.attendance.create(data={
                "employeeId": employee.id, "checkIn": datetime.now(timezone.utc), "shiftType": employee.role,
            })

    now = monotonic()
    for token, (employee_id, expires_at) in list(sessions.items()):
        if expires_at <= now or employee_id == employee.id:
            sessions.pop(token, None)
    token = secrets.token_urlsafe(32)
    sessions[token] = (employee.id, now + SESSION_TTL)
    return {
        "success": True,
        "token": token,
        "employee": {
            "id": employee.id, "name": employee.name, "role": employee.role,
            "checkedInAt": attendance.checkIn if attendance else None,
        },
    }


@app.post("/api/logout")
async def logout(request: Request):
    employee = request.state.employee
    handed_over = False
    try:
        async with db.tx() as tx:
            if request.state.session_token not in sessions:
                raise HTTPException(status_code=401, detail="نشست ورود معتبر نیست.")
            await tx.execute_raw('UPDATE "Employee" SET "id" = "id" WHERE "id" = ?', employee.id)
            if request.state.session_token not in sessions:
                raise HTTPException(status_code=401, detail="نشست ورود معتبر نیست.")
            now = datetime.now(timezone.utc)
            attendance = await tx.attendance.find_first(
                where={"employeeId": employee.id, "checkOut": None}, order={"checkIn": "desc"}
            )
            if attendance:
                hours, overtime, deficit = calculate_shift_metrics(
                    as_utc(attendance.checkIn), now, employee.shiftStart, employee.shiftEnd,
                )
                await tx.attendance.update_many(
                    where={"id": attendance.id, "checkOut": None},
                    data={"checkOut": now, "workHours": hours, "overtime": overtime, "deficit": deficit},
                )
            if employee.role == "CASHIER":
                other_ids = list({
                    employee_id for employee_id, expires_at in sessions.values()
                    if employee_id != employee.id and expires_at > monotonic()
                })
                other_cashier = other_ids and await tx.employee.count(
                    where={"id": {"in": other_ids}, "role": "CASHIER", "isActive": True}
                )
                if not other_cashier:
                    active = await tx.query_raw(REGISTER_OPEN)
                    if active:
                        await save_register_handover(tx, active[0]["id"], employee.id)
                        handed_over = True
    except TransactionError as exc:
        raise HTTPException(status_code=503, detail="پایان شیفت ثبت نشد. دوباره تلاش کنید.") from exc
    sessions.pop(request.state.session_token, None)
    return {"success": True, "handedOver": handed_over}


# ---------------------------------------------
# ۳. تسویه نهایی میز و چاپ فیش
# ---------------------------------------------
class CheckoutRequest(BaseModel):
    paymentMethod: Literal["CARD", "CASH"]
    expectedAmount: int | None = Field(default=None, ge=0)


@app.post("/api/orders/{order_id}/checkout")
async def checkout_table(order_id: int, checkout: CheckoutRequest, request: Request):
    settled_at = datetime.now(timezone.utc).isoformat()
    method = checkout.paymentMethod
    try:
        async with db.tx() as tx:
            shift = await get_or_open_shift(tx, request.state.employee_id)
            changed = await tx.execute_raw(
                """
                UPDATE "Order"
                SET "status" = 'COMPLETED', "paymentMethod" = ?, "paymentType" = ?, "settledAt" = ?
                WHERE "id" = ? AND "status" = 'PENDING' AND "orderType" = 'DINE_IN'
                  AND (? IS NULL OR "totalAmount" = ?)
                """,
                method, method, settled_at, order_id, checkout.expectedAmount, checkout.expectedAmount,
            )
            if changed != 1:
                raise HTTPException(status_code=409, detail="سفارش میز بسته شده یا مبلغ آن تغییر کرده است. مبلغ را دوباره بررسی کنید.")
            updated_order = await tx.order.find_unique(
                where={"id": order_id},
                include={"items": {"include": {"product": True}}},
            )
            await record_register_entry(
                tx, shift["id"], order_id, request.state.employee_id, "SALE", method, updated_order.totalAmount,
            )
    except TransactionError as exc:
        raise HTTPException(status_code=503, detail="تسویه کامل نشد. وضعیت میز را بررسی کنید.") from exc

    receipt_items = [
        {
            "name": item.product.name if item.product else "نامشخص",
            "quantity": item.quantity,
            "price": item.price,
        }
        for item in updated_order.items
    ]
    result = {"status": "success", "message": "میز تسویه شد"}
    result.update(
        await issue_receipt(
            updated_order.id,
            receipt_items,
            updated_order.totalAmount,
            order_meta={"orderType": "DINE_IN", "tableNumber": updated_order.tableNumber, "paymentMethod": method},
        )
    )
    return result


class ReversalRequest(BaseModel):
    reason: str = Field(max_length=300)
    restock: bool = False


@app.post("/api/orders/{order_id}/reverse")
async def reverse_order(order_id: int, reversal: ReversalRequest, request: Request):
    reason = reversal.reason.strip()
    if not reason:
        raise HTTPException(status_code=422, detail="دلیل عملیات را وارد کنید.")

    try:
        async with db.tx() as tx:
            shift = await get_or_open_shift(tx, request.state.employee_id)
            order = await tx.order.find_unique(where={"id": order_id})
            if not order:
                raise HTTPException(status_code=404, detail="سفارش پیدا نشد.")
            if order.status == "COMPLETED":
                status = "REFUNDED"
            elif order.status == "PENDING" and order.orderType == "DINE_IN":
                status = "CANCELLED"
            else:
                raise HTTPException(status_code=409, detail="این سفارش قبلاً ابطال یا مرجوع شده است.")

            changed = await tx.order.update_many(
                where={"id": order_id, "status": order.status}, data={"status": status}
            )
            if changed != 1:
                raise HTTPException(status_code=409, detail="وضعیت سفارش تغییر کرده است.")

            if reversal.restock:
                snapshots = await tx.query_raw(
                    'SELECT "deductions" FROM "OrderInventory" WHERE "orderId" = ?', order_id
                )
                if not snapshots:
                    raise HTTPException(status_code=409, detail="مصرف انبار این سفارش قدیمی ثبت نشده است. عملیات را بدون برگشت خودکار موجودی انجام دهید.")
                for material_id, quantity in json.loads(snapshots[0]["deductions"]).items():
                    await change_inventory(
                        tx, int(material_id), request.state.employee_id, "RETURN", quantity, reason, order_id,
                    )

            await tx.execute_raw(
                """
                INSERT INTO "OrderReversal" ("orderId", "employeeId", "reason", "restocked", "reversedAt")
                VALUES (?, ?, ?, ?, ?)
                """,
                order_id, request.state.employee_id, reason, int(reversal.restock), datetime.now(timezone.utc).isoformat(),
            )
            if status == "REFUNDED":
                sales = await tx.query_raw(
                    'SELECT "method" FROM "RegisterEntry" WHERE "orderId" = ? AND "kind" = ?', order_id, "SALE"
                )
                method = sales[0]["method"] if sales else (
                    "CASH" if "CASH" in (order.paymentType, order.paymentMethod) else "CARD"
                )
                await record_register_entry(
                    tx, shift["id"], order_id, request.state.employee_id, "REFUND", method, -order.totalAmount,
                )
            else:
                await record_register_entry(tx, shift["id"], order_id, request.state.employee_id, "CANCEL", "", 0)
    except TransactionError as exc:
        raise HTTPException(status_code=503, detail="عملیات کامل نشد. وضعیت سفارش را بررسی کنید.") from exc
    return {"status": status}


@app.post("/api/orders/{order_id}/reprint")
async def reprint_order(order_id: int):
    order = await db.order.find_unique(
        where={"id": order_id}, include={"items": {"include": {"product": True}}}
    )
    if not order or order.status not in {"COMPLETED", "REFUNDED"}:
        raise HTTPException(status_code=404, detail="برای این سفارش رسید فروش وجود ندارد.")

    path = receipt_image_path(order.id)
    if os.path.isfile(path):
        printer_cfg = await get_printer_config()
        try:
            return await to_thread(dispatch_receipt, path, printer_cfg["printMode"], printer_cfg["printerName"])
        except Exception as exc:
            raise HTTPException(status_code=500, detail="چاپ یا باز کردن فایل رسید ناموفق بود.") from exc

    items = [
        {"name": item.product.name if item.product else "نامشخص", "quantity": item.quantity, "price": item.price}
        for item in order.items
    ]
    settlements = await db.query_raw(
        'SELECT CAST("settledAt" AS TEXT) AS "settledAt" FROM "Order" WHERE "id" = ?', order.id
    )
    sold_at = as_utc(settlements[0]["settledAt"] or order.createdAt).astimezone()
    order_meta = {
        "orderType": order.orderType,
        "tableNumber": order.tableNumber,
        "paymentMethod": "CASH" if not settlements[0]["settledAt"] and "CASH" in (order.paymentType, order.paymentMethod) else order.paymentMethod,
    }
    result = await issue_receipt(order.id, items, order.totalAmount, sold_at, order_meta)
    return {**result, "recreated": True}


async def read_sales_history(tx, *, include_items: bool, limit: int | None = None):
    orders = await tx.order.find_many(
        where={"status": {"in": ["COMPLETED", "REFUNDED", "CANCELLED"]}},
        include={"items": {"include": {"product": True}}} if include_items else None,
        order={"createdAt": "desc"},
        take=limit if limit and limit > 0 else None,
    )
    if not orders:
        return []

    order_ids = [order.id for order in orders]
    settled_by_id = {}
    reversals_by_id = {}
    for start in range(0, len(order_ids), 500):
        chunk = order_ids[start : start + 500]
        placeholders = ", ".join("?" for _ in chunk)
        settlements = await tx.query_raw(
            f'SELECT "id", CAST("settledAt" AS TEXT) AS "settledAt" FROM "Order" WHERE "settledAt" IS NOT NULL AND "id" IN ({placeholders})',
            *chunk,
        )
        for row in settlements:
            settled_by_id[row["id"]] = row["settledAt"]
        reversals = await tx.query_raw(
            f'SELECT "orderId", "reason", "reversedAt", "restocked" FROM "OrderReversal" WHERE "orderId" IN ({placeholders})',
            *chunk,
        )
        for row in reversals:
            reversals_by_id[row["orderId"]] = row

    result = []
    for order in orders:
        settled_at = settled_by_id.get(order.id)
        row = order.model_dump()
        row["settledAt"] = settled_at
        row["reversal"] = reversals_by_id.get(order.id)
        # Older versions wrote the payment into either field and left the other at CARD.
        if not settled_at and "CASH" in (order.paymentType, order.paymentMethod):
            row["paymentMethod"] = "CASH"
        result.append(row)
    return result


@app.get("/api/orders")
async def get_orders(limit: int = 500):
    bounded_limit = min(limit, 5000) if limit > 0 else 500
    async with db.tx() as tx:
        return await read_sales_history(tx, include_items=True, limit=bounded_limit)


REGISTER_LATEST = """
    SELECT c.*, e."name" AS "closedByName", s."openedAt", s."openingCash", opener."name" AS "openedByName"
    FROM "RegisterClose" c JOIN "Employee" e ON e."id" = c."employeeId"
    LEFT JOIN "RegisterShift" s ON s."closeId" = c."id"
    LEFT JOIN "Employee" opener ON opener."id" = s."openedBy"
    ORDER BY c."id" DESC LIMIT 1
"""


class HandoverRequest(BaseModel):
    shiftId: int = Field(gt=0)


class HandoverReview(HandoverRequest):
    result: Literal["CONFIRMED", "DISCREPANCY"]
    note: str = Field(default="", max_length=300)


@app.get("/api/register/today")
async def get_today_register():
    start_of_today = (
        datetime.now(CAFE_TIME_ZONE)
        .replace(hour=0, minute=0, second=0, microsecond=0)
        .astimezone(timezone.utc)
    )
    start_prefix = start_of_today.strftime("%Y-%m-%dT%H:%M:%S")
    async with db.tx() as tx:
        recent_orders = await tx.order.find_many(
            where={"status": {"in": ["COMPLETED", "REFUNDED"]}, "createdAt": {"gte": start_of_today}}
        )
        settled_today_rows = await tx.query_raw(
            """
            SELECT "id", "status", "totalAmount", "paymentType", "paymentMethod", CAST("settledAt" AS TEXT) AS "settledAt"
            FROM "Order"
            WHERE "settledAt" IS NOT NULL AND "settledAt" >= ? AND "status" IN ('COMPLETED', 'REFUNDED')
            """,
            start_prefix,
        )
        today_reversals = await tx.query_raw(
            """
            SELECT r."orderId", r."reversedAt", o."totalAmount", o."paymentType", o."paymentMethod",
                   CAST(o."settledAt" AS TEXT) AS "settledAt"
            FROM "OrderReversal" r
            JOIN "Order" o ON o."id" = r."orderId"
            WHERE r."reversedAt" >= ? AND o."status" = 'REFUNDED'
            """,
            start_prefix,
        )
        recent_settled_by_id = {}
        recent_ids = [o.id for o in recent_orders]
        for start in range(0, len(recent_ids), 500):
            chunk = recent_ids[start : start + 500]
            placeholders = ", ".join("?" for _ in chunk)
            rows = await tx.query_raw(
                f'SELECT "id", CAST("settledAt" AS TEXT) AS "settledAt" FROM "Order" WHERE "settledAt" IS NOT NULL AND "id" IN ({placeholders})',
                *chunk,
            )
            for row in rows:
                recent_settled_by_id[row["id"]] = row["settledAt"]
        open_tables_count = await tx.order.count(where={"status": "PENDING", "orderType": "DINE_IN"})

    sales_by_id = {}
    for order in recent_orders:
        settled_at = recent_settled_by_id.get(order.id)
        sale_time = settled_at or order.createdAt
        method = "CASH" if not settled_at and "CASH" in (order.paymentType, order.paymentMethod) else order.paymentMethod
        sales_by_id[order.id] = {
            "status": order.status,
            "totalAmount": order.totalAmount or 0,
            "paymentMethod": method,
            "saleTime": sale_time,
        }
    for row in settled_today_rows:
        sales_by_id[row["id"]] = {
            "status": row["status"],
            "totalAmount": row["totalAmount"] or 0,
            "paymentMethod": row["paymentMethod"],
            "saleTime": row["settledAt"],
        }

    net_card = 0
    net_cash = 0
    completed_count = 0
    for sale in sales_by_id.values():
        if sale["saleTime"] and as_utc(sale["saleTime"]) >= start_of_today:
            if sale["status"] == "COMPLETED":
                completed_count += 1
            if sale["paymentMethod"] == "CARD":
                net_card += sale["totalAmount"]
            elif sale["paymentMethod"] == "CASH":
                net_cash += sale["totalAmount"]

    for rev in today_reversals:
        if rev.get("reversedAt") and as_utc(rev["reversedAt"]) >= start_of_today:
            settled_at = rev.get("settledAt")
            method = "CASH" if not settled_at and "CASH" in (rev.get("paymentType"), rev.get("paymentMethod")) else rev.get("paymentMethod")
            amount = rev.get("totalAmount") or 0
            if method == "CARD":
                net_card -= amount
            elif method == "CASH":
                net_cash -= amount

    return {
        "todayCard": net_card,
        "todayCash": net_cash,
        "todayTotal": net_card + net_cash,
        "todayOrdersCount": completed_count,
        "openTablesCount": open_tables_count,
    }


@app.get("/api/register/status")
async def get_register_status():
    async with db.tx() as tx:
        current = await tx.query_raw(REGISTER_OPEN)
        active = current[0] if current else None
        if active:
            active.update(await shift_totals(tx, active["id"]))
        handovers = await tx.query_raw("""
            SELECT h.*, s."openedAt", s."handedOverAt", outgoing."name" AS "handedByName",
                   incoming."name" AS "reviewedByName"
            FROM "RegisterHandover" h
            JOIN "RegisterShift" s ON s."id" = h."shiftId"
            JOIN "Employee" outgoing ON outgoing."id" = h."handedBy"
            LEFT JOIN "Employee" incoming ON incoming."id" = h."reviewedBy"
            WHERE h."reviewedAt" IS NULL OR h."shiftId" IN (
                SELECT "shiftId" FROM "RegisterHandover" ORDER BY "shiftId" DESC LIMIT 20
            )
            ORDER BY h."shiftId" DESC
        """)
    return {"active": active, "handovers": handovers}


@app.get("/api/register/last-close")
async def get_last_register_close():
    rows = await db.query_raw(REGISTER_LATEST)
    return rows[0] if rows else None


async def save_register_handover(tx, shift_id: int, employee_id: int):
    changed = await tx.execute_raw(
        """
        UPDATE "RegisterShift" SET "handedOverAt" = ?
        WHERE "id" = ? AND "closeId" IS NULL AND "handedOverAt" IS NULL
        """,
        datetime.now(timezone.utc).isoformat(), shift_id,
    )
    if changed != 1:
        raise HTTPException(status_code=409, detail="این شیفت دیگر فعال نیست. صفحه را به‌روز کنید.")
    totals = await shift_totals(tx, shift_id)
    await tx.execute_raw(
        """
        INSERT INTO "RegisterHandover" ("shiftId", "handedBy", "netCash", "netCard")
        VALUES (?, ?, ?, ?)
        """,
        shift_id, employee_id, totals["netCash"], totals["netCard"],
    )


@app.post("/api/register/handover")
async def hand_over_register(handover: HandoverRequest, request: Request):
    try:
        async with db.tx() as tx:
            await save_register_handover(tx, handover.shiftId, request.state.employee_id)
    except TransactionError as exc:
        raise HTTPException(status_code=503, detail="تحویل کامل نشد. وضعیت شیفت را بررسی کنید.") from exc
    return {"success": True}


@app.post("/api/register/review")
async def review_register_handover(review: HandoverReview, request: Request):
    note = review.note.strip() if review.result == "DISCREPANCY" else None
    if review.result == "DISCREPANCY" and not note:
        raise HTTPException(status_code=422, detail="توضیح مغایرت را وارد کنید.")
    employee_id = request.state.employee_id
    changed = await db.execute_raw(
        """
        UPDATE "RegisterHandover"
        SET "reviewedBy" = ?, "reviewedAt" = ?, "differenceNote" = ?
        WHERE "shiftId" = ? AND "reviewedAt" IS NULL AND "handedBy" <> ?
        """,
        employee_id, datetime.now(timezone.utc).isoformat(), note, review.shiftId, employee_id,
    )
    if changed != 1:
        raise HTTPException(status_code=409, detail="این تحویل قبلاً بررسی شده یا با حساب خودتان ثبت شده است.")
    return {"success": True}


# ==========================================
# API Routes - بخش پرسنل (Employees)
# ==========================================

@app.get("/api/employees", response_model=List[EmployeeResponse])
async def get_employees():
    return await db.employee.find_many(order={"createdAt": "desc"})


@app.post("/api/employees")
async def create_employee(employee: EmployeeCreate):
    name = employee.name.strip()
    if not name or not employee.password.strip():
        raise HTTPException(status_code=422, detail="نام و رمز پرسنل را وارد کنید.")
    encoded = await to_thread(hash_password, employee.password)
    try:
        async with db.tx() as tx:
            await tx.execute_raw('UPDATE "Employee" SET "id" = "id" WHERE 0')
            candidates = await tx.employee.find_many()
            if await to_thread(lambda: any(verify_password(employee.password, row.password) for row in candidates)):
                raise HTTPException(status_code=409, detail="این رمز برای حساب دیگری استفاده شده است.")
            created = await tx.employee.create(data={
                **employee.model_dump(exclude={"password", "name"}),
                "name": name,
                "password": encoded,
            })
    except TransactionError as exc:
        raise HTTPException(status_code=503, detail="ثبت حساب کامل نشد. فهرست پرسنل را بررسی کنید.") from exc
    return {"message": "کارمند با موفقیت ثبت شد", "employee_id": created.id}


@app.put("/api/employees/{employee_id}")
async def update_employee(employee_id: int, data: EmployeeUpdate, request: Request):
    changes = data.model_dump(exclude_unset=True)
    if "name" in changes:
        changes["name"] = (changes["name"] or "").strip()
        if not changes["name"]:
            raise HTTPException(status_code=422, detail="نام پرسنل نمی‌تواند خالی باشد.")
    if employee_id == request.state.employee_id and changes.get("isActive") is False:
        raise HTTPException(status_code=409, detail="نمی‌توانید حساب فعال خودتان را غیرفعال کنید.")

    new_password = changes.pop("password", None)
    encoded_password = None
    if new_password is not None:
        if not new_password.strip():
            raise HTTPException(status_code=422, detail="رمز عبور معتبر وارد کنید.")
        encoded_password = await to_thread(hash_password, new_password)

    try:
        async with db.tx() as tx:
            await tx.execute_raw('UPDATE "Employee" SET "id" = "id" WHERE "id" = ?', employee_id)
            employee = await tx.employee.find_unique(where={"id": employee_id})
            if not employee:
                raise HTTPException(status_code=404, detail="کارمند پیدا نشد.")
            if new_password is not None:
                others = await tx.employee.find_many(where={"NOT": {"id": employee_id}})
                if await to_thread(lambda: any(verify_password(new_password, row.password) for row in others)):
                    raise HTTPException(status_code=409, detail="این رمز برای حساب دیگری استفاده شده است.")
                changes["password"] = encoded_password
            if changes:
                await tx.employee.update(where={"id": employee_id}, data=changes)
    except TransactionError as exc:
        raise HTTPException(status_code=503, detail="ویرایش پرسنل کامل نشد.") from exc

    if changes.get("isActive") is False or new_password is not None:
        for token, (session_employee_id, _) in list(sessions.items()):
            if session_employee_id == employee_id and employee_id != request.state.employee_id:
                sessions.pop(token, None)
    return {"success": True}


@app.delete("/api/employees/{employee_id}")
async def delete_employee(employee_id: int, request: Request):
    if employee_id == request.state.employee_id:
        raise HTTPException(status_code=409, detail="نمی‌توانید حساب فعال خودتان را حذف کنید.")
    employee = await db.employee.find_unique(where={"id": employee_id})
    if not employee:
        raise HTTPException(status_code=404, detail="کارمند پیدا نشد.")

    has_orders = await db.order.count(where={"employeeId": employee_id}) > 0
    has_attendance = await db.attendance.count(where={"employeeId": employee_id}) > 0
    has_leaves = await db.leave.count(where={"employeeId": employee_id}) > 0
    raw_refs = await db.query_raw(
        """
        SELECT 1 AS "found" FROM (
            SELECT "employeeId" FROM "OrderReversal" WHERE "employeeId" = ?
            UNION ALL
            SELECT "employeeId" FROM "RegisterClose" WHERE "employeeId" = ?
            UNION ALL
            SELECT "openedBy" AS "employeeId" FROM "RegisterShift" WHERE "openedBy" = ?
            UNION ALL
            SELECT "handedBy" AS "employeeId" FROM "RegisterHandover" WHERE "handedBy" = ? OR "reviewedBy" = ?
            UNION ALL
            SELECT "employeeId" FROM "RegisterEntry" WHERE "employeeId" = ?
            UNION ALL
            SELECT "employeeId" FROM "OrderSubmission" WHERE "employeeId" = ?
            UNION ALL
            SELECT "employeeId" FROM "InventoryMovement" WHERE "employeeId" = ?
        ) LIMIT 1
        """,
        employee_id, employee_id, employee_id, employee_id, employee_id, employee_id, employee_id, employee_id,
    )

    for token, (session_employee_id, _) in list(sessions.items()):
        if session_employee_id == employee_id:
            sessions.pop(token, None)

    if has_orders or has_attendance or has_leaves or raw_refs:
        await db.employee.update(where={"id": employee_id}, data={"isActive": False})
        return {
            "success": True,
            "archived": True,
            "message": "این پرسنل دارای سابقه تردد یا فروش است؛ بنابراین برای حفظ سوابق، حساب او غیرفعال (آرشیو) شد.",
        }

    await db.employee.delete(where={"id": employee_id})
    return {"success": True, "archived": False, "message": "پرسنل با موفقیت حذف شد."}


class EmployeeRoleChange(BaseModel):
    role: Literal["ADMIN", "CASHIER", "BARISTA", "WAITER"]


@app.put("/api/employees/{employee_id}/role")
async def change_employee_role(employee_id: int, data: EmployeeRoleChange, request: Request):
    if employee_id == request.state.employee_id:
        raise HTTPException(status_code=409, detail="نقش حسابی را که با آن وارد شده‌اید نمی‌توانید تغییر دهید.")
    try:
        async with db.tx() as tx:
            await tx.execute_raw('UPDATE "Employee" SET "id" = "id" WHERE "id" = ?', employee_id)
            employee = await tx.employee.find_unique(where={"id": employee_id})
            if not employee:
                raise HTTPException(status_code=404, detail="کارمند پیدا نشد.")
            if employee.role == data.role:
                return {"success": True}
            if await tx.attendance.count(where={"employeeId": employee_id, "checkOut": None}):
                raise HTTPException(status_code=409, detail="قبل از تغییر نقش، شیفت این پرسنل را پایان دهید.")
            await tx.employee.update(where={"id": employee_id}, data={"role": data.role})
    except TransactionError as exc:
        raise HTTPException(status_code=503, detail="تغییر نقش کامل نشد. وضعیت حساب را بررسی کنید.") from exc
    for token, (session_employee_id, _) in list(sessions.items()):
        if session_employee_id == employee_id:
            sessions.pop(token, None)
    return {"success": True}


# ==========================================
# Pydantic Models & API Routes - حضور و غیاب (Attendance)
# ==========================================

@app.post("/api/attendance/check-in")
async def check_in(data: CheckInRequest):
    existing = await db.attendance.find_first(
        where={
            "employeeId": data.employeeId,
            "checkOut": None
        }
    )
    if existing:
        raise HTTPException(status_code=400, detail="این کارمند یک شیفت باز دارد. ابتدا باید خروج ثبت شود.")

    new_attendance = await db.attendance.create(
        data={
            "employeeId": data.employeeId,
            "checkIn": datetime.now(timezone.utc),
            "shiftType": data.shiftType
        }
    )
    return {"message": "ورود با موفقیت ثبت شد", "attendance_id": new_attendance.id, "check_in_time": new_attendance.checkIn}


@app.put("/api/attendance/check-out/{attendance_id}")
async def check_out(attendance_id: int, data: CheckOutRequest):
    attendance = await db.attendance.find_unique(
        where={"id": attendance_id},
        include={"employee": True}
    )
    if not attendance:
        raise HTTPException(status_code=404, detail="رکورد تردد یافت نشد")

    if attendance.checkOut:
        raise HTTPException(status_code=400, detail="خروج این شیفت قبلاً ثبت شده است")

    now = datetime.now(timezone.utc)

    # انجام محاسبات هوشمند شیفت
    work_hours, overtime, deficit = calculate_shift_metrics(
        attendance.checkIn,
        now,
        attendance.employee.shiftStart,
        attendance.employee.shiftEnd
    )

    updated = await db.attendance.update(
        where={"id": attendance_id},
        data={
            "checkOut": now,
            "note": data.note,
            "workHours": work_hours,
            "overtime": overtime,
            "deficit": deficit
        }
    )
    return {
        "message": "خروج با موفقیت ثبت شد",
        "check_out_time": updated.checkOut,
        "metrics": {"workHours": work_hours, "overtime": overtime, "deficit": deficit}
    }


@app.get("/api/attendance")
async def get_attendances(limit: int = 500):
    bounded_limit = min(limit, 5000) if limit > 0 else None
    attendances = await db.attendance.find_many(
        include={"employee": True},
        order={"checkIn": "desc"},
        take=bounded_limit,
    )
    return jsonable_encoder(attendances, exclude={"employee": {"password"}})


@app.delete("/api/attendance/{attendance_id}")
async def delete_attendance(attendance_id: int):
    attendance = await db.attendance.find_unique(where={"id": attendance_id})
    if not attendance:
        raise HTTPException(status_code=404, detail="رکورد تردد یافت نشد.")
    await db.attendance.delete(where={"id": attendance_id})
    return {"success": True}


# ==========================================
# API Routes - مرخصی (Leaves)
# ==========================================

@app.post("/api/leaves")
async def request_leave(data: LeaveCreate):
    try:
        start_dt = datetime.fromisoformat(data.startDate.replace("Z", "+00:00"))
        end_dt = datetime.fromisoformat(data.endDate.replace("Z", "+00:00"))

        await db.leave.create(
            data={
                "employeeId": data.employeeId,
                "startDate": start_dt,
                "endDate": end_dt,
                "type": data.type,
                "reason": data.reason,
                "status": "PENDING"
            }
        )
        return {"message": "درخواست مرخصی با موفقیت ثبت شد"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.put("/api/leaves/{leave_id}")
async def update_leave_status(leave_id: int, data: LeaveStatusUpdate):
    try:
        updated = await db.leave.update(
            where={"id": leave_id},
            data={"status": data.status}
        )
        return {"success": True, "status": updated.status}
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"خطا در تغییر وضعیت مرخصی: {e}")


@app.get("/api/leaves")
async def get_leaves():
    leaves = await db.leave.find_many(
        include={"employee": True},
        order={"createdAt": "desc"}
    )
    return jsonable_encoder(leaves, exclude={"employee": {"password"}})
