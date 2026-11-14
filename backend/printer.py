from PIL import Image, ImageDraw, ImageFont
import arabic_reshaper
from bidi.algorithm import get_display
import base64
import os
import subprocess
import jdatetime
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from backend.credentials import database_path

try:
    CAFE_TIME_ZONE = ZoneInfo("Asia/Tehran")
except ZoneInfoNotFoundError:
    # Current Tehran offset on Windows installations without the IANA time zone database.
    CAFE_TIME_ZONE = timezone(timedelta(hours=3, minutes=30))


def fix_persian(text):
    if not text: return ""
    reshaped = arabic_reshaper.reshape(str(text))
    return get_display(reshaped)


def _load_font(font_path: str, size: int):
    win_tahoma = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "tahoma.ttf")
    for candidate in (font_path, win_tahoma):
        try:
            if candidate and os.path.isfile(candidate):
                return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _resolve_logo_path(logo_path: str) -> str:
    if not logo_path:
        return ""
    if os.path.isfile(logo_path):
        return logo_path
    portable = os.path.join(os.path.dirname(__file__), "uploads", os.path.basename(logo_path))
    return portable if os.path.isfile(portable) else ""


def receipt_image_path(order_id: int) -> str:
    if os.environ.get("CAFE_ONE_DATABASE_PATH"):
        db_path = database_path()
        return str(db_path.with_suffix(".receipts") / f"receipt_{order_id}.png")
    return os.path.join(os.path.dirname(__file__), "receipts", f"receipt_{order_id}.png")


def generate_receipt_image(
    order_id: int,
    items: list,
    total_amount: int,
    settings: dict,
    sold_at=None,
    order_meta: dict | None = None,
):
    WIDTH = 576  
    MARGIN = 15  
    RIGHT = WIDTH - MARGIN
    LEFT = MARGIN
    
    current_dir = os.path.dirname(__file__)
    font_path = os.path.join(current_dir, "Vazirmatn-Regular.ttf")
    font_title = _load_font(font_path, 34)
    font_bold = _load_font(font_path, 26)
    font_normal = _load_font(font_path, 24)
    font_small = _load_font(font_path, 20)

    # --- محاسبات ارتفاع ---
    row_h = 50
    header_h = 240
    info_h = 95
    table_header_h = 50
    table_rows_h = len(items) * row_h
    summary_h = 140
    footer_h = 180
    
    total_height = header_h + info_h + table_header_h + table_rows_h + summary_h + footer_h
    
    img = Image.new('RGB', (WIDTH, total_height), color='white')
    draw = ImageDraw.Draw(img)
    
    # کادر دور کل فیش
    draw.rectangle([LEFT, LEFT, RIGHT, total_height - LEFT], outline="black", width=4)
    y = LEFT + 10
    
    # --- بخش هدر و لوگو (با عکس واقعی) ---
    show_logo = settings.get("showLogo", True)
    logo_path = _resolve_logo_path(settings.get("logoPath", ""))
    logo_r = 45
    logo_size = logo_r * 2
    logo_x = WIDTH // 2
    
    if show_logo:
        has_pasted_logo = False
        if logo_path:
            try:
                logo_img = Image.open(logo_path).convert("RGBA")
                logo_img = logo_img.resize((logo_size, logo_size))
                img.paste(logo_img, (logo_x - logo_r, y), logo_img)
                has_pasted_logo = True
            except Exception as e:
                print("خطا در لود عکس لوگو:", e)
        
        if not has_pasted_logo:
            draw.ellipse([logo_x - logo_r, y, logo_x + logo_r, y + logo_r*2], outline="black", width=3)
            
        y += logo_r*2 + 25
    else:
        y += 20
        
    draw.text((WIDTH//2, y), fix_persian(settings.get("cafeName", "کافه")), font=font_bold, fill='black', anchor="mm")
    y += 40
    
    draw.text((WIDTH//2, y), fix_persian(settings.get("cafeSubtitle", "آبیاران")), font=font_title, fill='black', anchor="mm")
    y += 40
    draw.text((WIDTH//2, y), fix_persian("فاکتور فروش داخلی"), font=font_small, fill='black', anchor="mm")
    y += 35
    draw.line([LEFT, y, RIGHT, y], fill="black", width=3) 
    
    # --- تاریخ شمسی و اطلاعات مشتری ---
    y += 10
    instant = sold_at or datetime.now(timezone.utc)
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    now = jdatetime.datetime.fromgregorian(datetime=instant.astimezone(CAFE_TIME_ZONE))
    date_str = now.strftime("%Y/%m/%d")
    time_str = now.strftime("%H:%M")

    invoice_label = "فیش آزمایشی" if order_id == 0 else str(order_id)
    if order_meta:
        otype = order_meta.get("orderType")
        tnum = order_meta.get("tableNumber") or 0
        pmethod = order_meta.get("paymentMethod")
        service_txt = f"سالن (میز {tnum})" if otype == "DINE_IN" and tnum else "بیرون‌بر"
        pay_txt = "کارت‌خوان" if pmethod == "CARD" else ("نقدی" if pmethod == "CASH" else "")
        customer_line = f"{service_txt} · {pay_txt}" if pay_txt else service_txt
    else:
        customer_line = "نام مشتری:  عمومی"
    
    draw.text((RIGHT - 15, y), fix_persian(f"شماره فاکتور:  {invoice_label}"), font=font_normal, fill='black', anchor="ra")
    draw.text((LEFT + 15, y), fix_persian(f"تاریخ:  {date_str}"), font=font_normal, fill='black', anchor="la")
    y += 35  
    draw.text((RIGHT - 15, y), fix_persian(customer_line), font=font_normal, fill='black', anchor="ra")
    draw.text((LEFT + 15, y), fix_persian(f"ساعت:  {time_str}"), font=font_normal, fill='black', anchor="la")
    y += 50
    
    # --- بخش جدول ---
    draw.line([LEFT, y, RIGHT, y], fill="black", width=3)
    table_start_y = y
    y += table_header_h // 2
    
    col_x = {
        'name': (RIGHT + 330) // 2,     
        'qty': (330 + 260) // 2,        
        'price': (260 + 130) // 2,      
        'total': (130 + LEFT) // 2      
    }
    
    draw.text((col_x['name'], y), fix_persian("نام کالا"), font=font_bold, fill='black', anchor="mm")
    draw.text((col_x['qty'], y), fix_persian("تعداد"), font=font_bold, fill='black', anchor="mm")
    draw.text((col_x['price'], y), fix_persian("قیمت"), font=font_bold, fill='black', anchor="mm")
    draw.text((col_x['total'], y), fix_persian("جمع کل"), font=font_bold, fill='black', anchor="mm")
    
    y += table_header_h // 2
    draw.line([LEFT, y, RIGHT, y], fill="black", width=3)
    
    total_qty = 0
    for item in items:
        item_total = item['price'] * item['quantity']
        total_qty += item['quantity']
        
        y += row_h // 2
        draw.text((col_x['name'], y), fix_persian(item['name']), font=font_normal, fill='black', anchor="mm")
        draw.text((col_x['qty'], y), fix_persian(str(item['quantity'])), font=font_normal, fill='black', anchor="mm")
        draw.text((col_x['price'], y), fix_persian(f"{item['price']:,}"), font=font_normal, fill='black', anchor="mm")
        draw.text((col_x['total'], y), fix_persian(f"{item_total:,}"), font=font_normal, fill='black', anchor="mm")
        
        y += row_h // 2
        draw.line([LEFT, y, RIGHT, y], fill="black", width=1) 
        
    y += row_h // 2
    draw.text((col_x['name'], y), fix_persian("جمع اقلام:"), font=font_bold, fill='black', anchor="mm")
    draw.text((col_x['qty'], y), fix_persian(str(total_qty)), font=font_bold, fill='black', anchor="mm")
    y += row_h // 2
    table_end_y = y
    
    draw.line([330, table_start_y, 330, table_end_y], fill="black", width=3)
    draw.line([260, table_start_y, 260, table_end_y], fill="black", width=3)
    draw.line([130, table_start_y, 130, table_end_y], fill="black", width=3)
    draw.line([LEFT, table_end_y, RIGHT, table_end_y], fill="black", width=3)
    
    # --- قابل پرداخت ---
    payable_h = 55
    draw.rectangle([LEFT, y, RIGHT, y + payable_h], fill="black")
    draw.text((RIGHT - 15, y + payable_h//2), fix_persian("قابل پرداخت:"), font=font_title, fill='white', anchor="rm")
    draw.text((LEFT + 15, y + payable_h//2), fix_persian(f"{total_amount:,} تومان"), font=font_title, fill='white', anchor="lm")
    y += payable_h
    draw.line([LEFT, y, RIGHT, y], fill="black", width=3)
    
    # --- فوتر داینامیک ---
    y += 35
    draw.text((WIDTH//2, y), fix_persian(f"آدرس: {settings.get('address', '')}"), font=font_small, fill='black', anchor="mm")
    y += 30
    draw.text((WIDTH//2, y), fix_persian(f"تلفن: {settings.get('phone', '')}"), font=font_small, fill='black', anchor="mm")
    y += 35
    
    draw.line([LEFT+60, y, RIGHT-60, y], fill="black", width=2)
    y += 30
    draw.text((WIDTH//2, y), fix_persian(settings.get('footerMessage', '')), font=font_bold, fill='black', anchor="mm")
    y += 35
    draw.text((WIDTH//2, y), fix_persian(settings.get('socialMedia', '')), font=font_small, fill='black', anchor="mm")
    
    output_filename = receipt_image_path(order_id)
    os.makedirs(os.path.dirname(output_filename), exist_ok=True)
    img.save(output_filename)
    return output_filename


def _print_via_windows(image_path: str, printer_name: str = "") -> None:
    """چاپ مستقیم تصویر فیش روی فیش‌پرینتر ویندوز (یا چاپگر پیش‌فرض) بدون باز کردن پنجره."""
    b64_path = base64.b64encode(os.path.abspath(image_path).encode("utf-8")).decode("ascii")
    b64_printer = base64.b64encode((printer_name or "").strip().encode("utf-8")).decode("ascii")
    ps_script = f"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$imgPath = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{b64_path}'))
$printerName = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{b64_printer}'))
$doc = New-Object System.Drawing.Printing.PrintDocument
if ($printerName) {{
    $doc.PrinterSettings.PrinterName = $printerName
}}
if (-not $doc.PrinterSettings.IsValid) {{
    throw "Printer is not valid or not installed."
}}
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
$img = [System.Drawing.Image]::FromFile($imgPath)
try {{
    $doc.add_PrintPage({{
        param($sender, $e)
        $w = $e.PageBounds.Width
        if ($w -le 0) {{ $w = 280 }}
        $h = [int]([Math]::Round($img.Height * ($w / [double]$img.Width)))
        $e.Graphics.DrawImage($img, 0, 0, $w, $h)
        $e.HasMorePages = $false
    }})
    $doc.Print()
}} finally {{
    $img.Dispose()
    $doc.Dispose()
}}
"""
    encoded_cmd = base64.b64encode(ps_script.encode("utf-16le")).decode("ascii")
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded_cmd],
            check=True,
            timeout=25,
            capture_output=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        if (printer_name or "").strip():
            raise
        os.startfile(image_path, "print")


def dispatch_receipt(image_path: str, print_mode: str = "PREVIEW", printer_name: str = "") -> dict:
    """اعمال روش چاپ فیش: پیش‌نمایش روی صفحه، چاپگر حرارتی مستقیم، هر دو، یا بدون نمایش."""
    if os.environ.get("CAFE_ONE_SILENT_RECEIPT") == "1" or print_mode == "NONE":
        return {"receiptOk": True, "receiptPath": image_path, "printMode": "NONE"}

    mode = (print_mode or "PREVIEW").upper()
    if mode not in {"PREVIEW", "PRINTER", "BOTH", "NONE"}:
        mode = "PREVIEW"

    if mode in {"PRINTER", "BOTH"}:
        _print_via_windows(image_path, printer_name)
    if mode in {"PREVIEW", "BOTH"}:
        os.startfile(image_path)

    return {"receiptOk": True, "receiptPath": image_path, "printMode": mode}