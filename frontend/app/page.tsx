"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  daysInPersianMonth,
  formatCafeDateTime,
  formatPersianYearMonth,
  persianDate,
  persianDateKey,
  persianMonths,
  persianYearMonthKey,
  previousPersianMonth,
  startOfCafeWeek,
  toPersianDigits,
  type PersianDate,
} from "./calendar";

const API_BASE = process.env.NEXT_PUBLIC_CAFE_ONE_API_BASE ?? "http://localhost:8080";
const shiftMoney = new Intl.NumberFormat("fa-IR");

type ApiFetch = (url: string, init?: RequestInit) => Promise<Response>;

interface Category {
  id: number;
  name: string;
  icon: string | null;
}

interface Recipe {
  id: number;
  productId: number;
  materialId: number;
  quantity: number;
}

interface Product {
  id: number;
  name: string;
  price: number;
  categoryId: number;
  is_active?: boolean;
  category?: { id?: number; name: string; icon: string | null } | null;
  recipes?: Recipe[];
}

interface RawMaterial {
  id: number;
  name: string;
  unit: string;
  stock: number;
}

interface InventoryMovementRow {
  id: number;
  kind: string;
  beforeStock: number;
  afterStock: number;
  unit: string;
  reason: string;
  employeeName: string;
  orderId: number | null;
  recordedAt: string;
}

interface CartItem {
  product: Product;
  quantity: number;
}

interface CurrentUser {
  id: number;
  name: string;
  role: string;
  checkedInAt?: string | null;
}

interface ActiveTableOrder {
  id: number;
  tableNumber: number;
  totalAmount: number;
  createdAt: string;
  items: { id: number; quantity: number; price: number; product?: { name: string } | null }[];
}

interface OrderHistoryRow {
  id: number;
  totalAmount: number;
  status: string;
  orderType: string;
  paymentMethod: string;
  tableNumber: number;
  createdAt: string;
  settledAt?: string | null;
  reversal?: { orderId: number; reason: string; reversedAt: string; restocked: number } | null;
  items: { id?: number; quantity: number; price: number; product?: { name: string } | null }[];
}

interface EmployeeRow {
  id: number;
  name: string;
  role: string;
  phone?: string | null;
  baseSalary: number;
  hourlyRate: number;
  shiftStart: string;
  shiftEnd: string;
  isActive: boolean;
  createdAt: string;
}

interface AttendanceRow {
  id: number;
  employeeId: number;
  checkIn: string;
  checkOut?: string | null;
  workHours?: number;
  overtime?: number;
  deficit?: number;
  employee?: { name: string } | null;
}

interface TodayRegisterSummary {
  todayCard: number;
  todayCash: number;
  todayTotal: number;
  todayOrdersCount: number;
  openTablesCount: number;
}

type ReversalTarget = {
  orderId: number;
  action: "ابطال" | "مرجوعی";
  onSuccess: () => Promise<void> | void;
};

const ROLE_LABELS: Record<string, string> = {
  ADMIN: "مدیر سیستم",
  CASHIER: "صندوق‌دار",
  BARISTA: "باریستا",
  WAITER: "سالن‌دار",
};

const pendingOrderKey = (employeeId: number) => `cafe-one:pending-order:${employeeId}`;

function extractDetail(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "detail" in data && typeof (data as { detail: unknown }).detail === "string") {
    return (data as { detail: string }).detail;
  }
  if (data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string") {
    return (data as { error: string }).error;
  }
  return fallback;
}

function computeShiftDurationHours(shiftStart: string, shiftEnd: string): number {
  const parse = (val: string) => {
    const [h, m] = val.split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
  };
  const start = parse(shiftStart);
  const end = parse(shiftEnd);
  if (start === null || end === null) return 8;
  let diff = (end - start) / 60;
  if (diff <= 0) diff += 24;
  return diff;
}

function suggestHourlyRate(baseSalary: number, shiftStart: string, shiftEnd: string): number {
  if (baseSalary <= 0) return 0;
  const dailyHours = computeShiftDurationHours(shiftStart, shiftEnd);
  if (dailyHours <= 0) return 0;
  return Math.round(baseSalary / (dailyHours * 30));
}

// ==========================================
// آیکون‌های برداری یکپارچه (Corporate SVG Icons)
// ==========================================
function SvgIcon({
  children,
  className = "h-5 w-5",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

const IconBrandMark = ({ className = "h-7 w-7" }: { className?: string }) => (
  <SvgIcon className={className}>
    <rect x="3" y="3" width="8" height="8" rx="2" />
    <rect x="13" y="3" width="8" height="8" rx="2" />
    <rect x="3" y="13" width="8" height="8" rx="2" />
    <path d="M13 17h8M17 13v8" />
  </SvgIcon>
);

const IconPos = ({ className }: { className?: string }) => (
  <SvgIcon className={className}>
    <rect x="3" y="4" width="18" height="14" rx="2" />
    <path d="M7 21h10M12 18v3M7 9h4M7 13h10" />
  </SvgIcon>
);

const IconTables = ({ className }: { className?: string }) => (
  <SvgIcon className={className}>
    <path d="M4 10h16M6 10v8M18 10v8M8 6h8" />
    <rect x="3" y="10" width="18" height="3" rx="1" />
  </SvgIcon>
);

const IconInventory = ({ className }: { className?: string }) => (
  <SvgIcon className={className}>
    <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
    <path d="M3.3 8.2L12 13l8.7-4.8M12 13v9" />
  </SvgIcon>
);

const IconReports = ({ className }: { className?: string }) => (
  <SvgIcon className={className}>
    <path d="M4 20h16M7 16v-5M12 16V7M17 16v-8" />
  </SvgIcon>
);

const IconUsers = ({ className }: { className?: string }) => (
  <SvgIcon className={className}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M3 19c0-3 2.7-5 6-5s6 2 6 5" />
    <circle cx="17" cy="9" r="2.5" />
    <path d="M16 14.5c2.5.4 4.5 2 4.5 4.5" />
  </SvgIcon>
);

const IconSettings = ({ className }: { className?: string }) => (
  <SvgIcon className={className}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 110 4h-.09c-.66 0-1.25.4-1.51 1z" />
  </SvgIcon>
);

const IconLogout = ({ className }: { className?: string }) => (
  <SvgIcon className={className}>
    <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
  </SvgIcon>
);

const IconSearch = ({ className = "h-4 w-4" }: { className?: string }) => (
  <SvgIcon className={className}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.35-4.35" />
  </SvgIcon>
);

const IconRefresh = ({ className = "h-4 w-4" }: { className?: string }) => (
  <SvgIcon className={className}>
    <path d="M3 12a9 9 0 0115-6.7L21 8M21 3v5h-5M21 12a9 9 0 01-15 6.7L3 16M3 21v-5h5" />
  </SvgIcon>
);

const IconCard = ({ className = "h-4 w-4" }: { className?: string }) => (
  <SvgIcon className={className}>
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M2 10h20M6 15h4" />
  </SvgIcon>
);

const IconCash = ({ className = "h-4 w-4" }: { className?: string }) => (
  <SvgIcon className={className}>
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M6 12h.01M18 12h.01" />
  </SvgIcon>
);

const IconClock = ({ className = "h-4 w-4" }: { className?: string }) => (
  <SvgIcon className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </SvgIcon>
);

const IconPrint = ({ className = "h-4 w-4" }: { className?: string }) => (
  <SvgIcon className={className}>
    <path d="M6 9V3h12v6M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2" />
    <rect x="6" y="14" width="12" height="7" rx="1" />
  </SvgIcon>
);

const IconEdit = ({ className = "h-4 w-4" }: { className?: string }) => (
  <SvgIcon className={className}>
    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
    <path d="M18.5 2.5a2.12 2.12 0 113 3L12 15l-4 1 1-4 9.5-9.5z" />
  </SvgIcon>
);

const IconTrash = ({ className = "h-4 w-4" }: { className?: string }) => (
  <SvgIcon className={className}>
    <path d="M3 6h18M8 6V4h8v2M6 6l1 14a2 2 0 002 2h6a2 2 0 002-2l1-14" />
    <path d="M10 11v6M14 11v6" />
  </SvgIcon>
);

const IconTakeaway = ({ className = "h-4 w-4" }: { className?: string }) => (
  <SvgIcon className={className}>
    <path d="M6 8h12l-1.2 12a2 2 0 01-2 1.8H9.2a2 2 0 01-2-1.8L6 8z" />
    <path d="M9 8V6a3 3 0 016 0v2" />
  </SvgIcon>
);

const IconCoffeeBeans = ({ className = "h-8 w-8" }: { className?: string }) => (
  <svg viewBox="0 0 36 32" fill="none" aria-hidden="true" className={className}>
    <g transform="rotate(-24 11 16)">
      <ellipse cx="11" cy="16" rx="7.2" ry="10.2" fill="#3B1F14" />
      <path d="M11 6.5c-1.8 3.2-1.8 6.4 0 9.5s1.8 6.3 0 9.5" stroke="#FAF3EB" strokeWidth="1.9" strokeLinecap="round" />
    </g>
    <g transform="rotate(18 24 14)">
      <ellipse cx="24" cy="14" rx="6.6" ry="9.4" fill="#C87D3B" />
      <path d="M24 5.2c-1.6 3-1.6 5.9 0 8.8s1.6 5.8 0 8.8" stroke="#FFFDF9" strokeWidth="1.8" strokeLinecap="round" />
    </g>
  </svg>
);

const IconLock = ({ className = "h-5 w-5" }: { className?: string }) => (
  <SvgIcon className={className}>
    <rect x="4" y="11" width="16" height="10" rx="2.5" />
    <path d="M8 11V7a4 4 0 018 0v4" />
    <circle cx="12" cy="16" r="1" />
  </SvgIcon>
);

const IconEye = ({ open, className = "h-5 w-5" }: { open: boolean; className?: string }) => (
  <SvgIcon className={className}>
    <path d="M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12z" />
    <circle cx="12" cy="12" r="2.8" />
    {open && <path d="M4 20L20 4" />}
  </SvgIcon>
);

// ==========================================
// کامپوننت‌های مشترک UI
// ==========================================
function CafePageHeading({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="mb-5 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-white md:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-400">{description}</p>}
      </div>
      {children}
    </header>
  );
}

/**
 * انتخابگر ساعت ۲۴ ساعته فارسی (بدون AM/PM و کاملاً هماهنگ با تقویم شمسی)
 */
function Time24Picker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const [rawH, rawM] = value.split(":");
  const hour = /^\d{2}$/.test(rawH ?? "") ? rawH : "08";
  const minute = /^\d{2}$/.test(rawM ?? "") ? rawM : "00";

  const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
  const baseMinutes = ["00", "15", "30", "45"];
  const minutes = baseMinutes.includes(minute) ? baseMinutes : [...baseMinutes, minute].sort();

  return (
    <div>
      <span className="mb-1 block text-xs text-slate-400">{label} (۲۴ ساعته)</span>
      <div className="flex items-center gap-1.5" dir="ltr">
        <select
          aria-label={`ساعت ${label}`}
          value={hour}
          onChange={e => onChange(`${e.target.value}:${minute}`)}
          className="cafe-input flex-1 px-2.5 py-2 text-center font-semibold tabular-nums"
        >
          {hours.map(h => (
            <option key={h} value={h}>
              {toPersianDigits(h)}
            </option>
          ))}
        </select>
        <span className="font-bold text-slate-500">:</span>
        <select
          aria-label={`دقیقه ${label}`}
          value={minute}
          onChange={e => onChange(`${hour}:${e.target.value}`)}
          className="cafe-input flex-1 px-2.5 py-2 text-center font-semibold tabular-nums"
        >
          {minutes.map(m => (
            <option key={m} value={m}>
              {toPersianDigits(m)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function PersianDatePicker({
  label,
  value,
  onChange,
  today,
  firstYear,
}: {
  label: string;
  value: PersianDate | null;
  onChange: (date: PersianDate | null) => void;
  today: PersianDate;
  firstYear: number;
}) {
  const inputClass = "rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-sm text-white";
  if (!value) {
    return (
      <button type="button" className={inputClass} onClick={() => onChange(today)}>
        {label}
      </button>
    );
  }

  const setPart = (part: keyof PersianDate, number: number) => {
    const next = { ...value, [part]: number };
    next.day = Math.min(next.day, daysInPersianMonth(next.year, next.month));
    onChange(next);
  };
  const years = Array.from({ length: today.year - firstYear + 1 }, (_, i) => today.year - i);
  const days = Array.from({ length: daysInPersianMonth(value.year, value.month) }, (_, i) => i + 1);

  return (
    <fieldset className="flex flex-wrap items-center gap-1.5">
      <legend className="mb-1 text-xs text-slate-400">{label}</legend>
      <select
        aria-label={`روز ${label}`}
        className={inputClass}
        value={value.day}
        onChange={e => setPart("day", Number(e.target.value))}
      >
        {days.map(day => (
          <option key={day} value={day}>
            {shiftMoney.format(day)}
          </option>
        ))}
      </select>
      <select
        aria-label={`ماه ${label}`}
        className={inputClass}
        value={value.month}
        onChange={e => setPart("month", Number(e.target.value))}
      >
        {persianMonths.map((month, i) => (
          <option key={month} value={i + 1}>
            {month}
          </option>
        ))}
      </select>
      <select
        aria-label={`سال ${label}`}
        className={inputClass}
        value={value.year}
        onChange={e => setPart("year", Number(e.target.value))}
      >
        {years.map(year => (
          <option key={year} value={year}>
            {year.toLocaleString("fa-IR", { useGrouping: false })}
          </option>
        ))}
      </select>
      <button type="button" className="px-2 text-xs text-slate-300 hover:text-white" onClick={() => onChange(null)}>
        پاک کردن
      </button>
    </fieldset>
  );
}

function TodayRegisterStrip({
  summary,
  onRefresh,
}: {
  summary: TodayRegisterSummary | null;
  onRefresh: () => void;
}) {
  return (
    <section
      aria-label="وضعیت صندوق امروز"
      className="grid shrink-0 grid-cols-2 gap-2.5 lg:grid-cols-4"
    >
      <div className="flex items-center justify-between rounded-2xl border border-indigo-500/20 bg-gradient-to-br from-indigo-950/50 to-slate-900/90 px-4 py-3">
        <div>
          <p className="text-xs text-slate-400">دریافتی کارت‌خوان امروز</p>
          <p className="mt-1 text-lg font-black text-indigo-300 tabular-nums">
            {shiftMoney.format(summary?.todayCard ?? 0)}{" "}
            <span className="text-xs font-normal text-slate-400">تومان</span>
          </p>
        </div>
        <span className="grid h-9 w-9 place-items-center rounded-xl border border-indigo-500/20 bg-indigo-500/10 text-indigo-300">
          <IconCard />
        </span>
      </div>

      <div className="flex items-center justify-between rounded-2xl border border-teal-500/20 bg-gradient-to-br from-teal-950/50 to-slate-900/90 px-4 py-3">
        <div>
          <p className="text-xs text-slate-400">دریافتی نقدی امروز</p>
          <p className="mt-1 text-lg font-black text-teal-300 tabular-nums">
            {shiftMoney.format(summary?.todayCash ?? 0)}{" "}
            <span className="text-xs font-normal text-slate-400">تومان</span>
          </p>
        </div>
        <span className="grid h-9 w-9 place-items-center rounded-xl border border-teal-500/20 bg-teal-500/10 text-teal-300">
          <IconCash />
        </span>
      </div>

      <div className="flex items-center justify-between rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-emerald-950/45 to-slate-900/90 px-4 py-3">
        <div>
          <p className="text-xs text-slate-400">جمع کل صندوق امروز</p>
          <p className="mt-1 text-lg font-black text-white tabular-nums">
            {shiftMoney.format(summary?.todayTotal ?? 0)}{" "}
            <span className="text-xs font-normal text-slate-400">تومان</span>
          </p>
        </div>
        <span className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-200 tabular-nums">
          {shiftMoney.format(summary?.todayOrdersCount ?? 0)} فیش
        </span>
      </div>

      <div className="flex items-center justify-between rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-950/35 to-slate-900/90 px-4 py-3">
        <div>
          <p className="text-xs text-slate-400">میزهای باز سالن</p>
          <p className="mt-1 text-lg font-black text-amber-300 tabular-nums">
            {shiftMoney.format(summary?.openTablesCount ?? 0)}{" "}
            <span className="text-xs font-normal text-slate-400">میز فعال</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          title="به‌روزرسانی وضعیت صندوق"
          aria-label="به‌روزرسانی وضعیت صندوق"
          className="grid h-9 w-9 place-items-center rounded-xl border border-amber-500/25 bg-slate-950 text-amber-200 transition hover:border-amber-400/50 hover:text-white"
        >
          <IconRefresh />
        </button>
      </div>
    </section>
  );
}

function ReversalModal({
  target,
  apiFetch,
  onClose,
}: {
  target: ReversalTarget;
  apiFetch: ApiFetch;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [restock, setRestock] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = reason.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await apiFetch(`${API_BASE}/api/orders/${target.orderId}/reverse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: trimmed, restock }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        setError(extractDetail(data, "ثبت عملیات ناموفق بود."));
        return;
      }
      await target.onSuccess();
      onClose();
    } catch {
      setError("خطا در ارتباط با سرور");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reversal-modal-title"
      className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4 backdrop-blur-sm"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md space-y-4 rounded-2xl border border-slate-700 bg-slate-900 p-6 text-white shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-slate-800 pb-3">
          <h2 id="reversal-modal-title" className="text-lg font-bold">
            ثبت {target.action} سفارش #{shiftMoney.format(target.orderId)}
          </h2>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            aria-label="بستن پنجره"
            className="rounded-lg px-2.5 py-1 text-sm text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            بستن
          </button>
        </header>

        <label className="block space-y-1.5 text-sm text-slate-300">
          <span>دلیل {target.action} کامل سفارش</span>
          <textarea
            required
            autoFocus
            rows={3}
            maxLength={300}
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="مثلاً: انصراف مشتری، خطای ثبت..."
            className="cafe-input w-full"
          />
        </label>

        <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-200">
          <input
            type="checkbox"
            checked={restock}
            onChange={e => setRestock(e.target.checked)}
            className="h-4 w-4 accent-blue-600"
          />
          <span>برگشت خودکار مواد مصرفی به انبار</span>
        </label>

        {error && (
          <p role="alert" className="rounded-xl border border-rose-500/30 bg-rose-950/80 p-3 text-sm text-rose-200">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" disabled={busy} onClick={onClose} className="cafe-secondary">
            انصراف
          </button>
          <button
            type="submit"
            disabled={busy || !reason.trim()}
            className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-rose-500 disabled:opacity-50"
          >
            {busy ? "در حال ثبت…" : `تأیید ${target.action}`}
          </button>
        </div>
      </form>
    </div>
  );
}

// ==========================================
// سایدبار شرکتی (Corporate Sidebar)
// ==========================================
function Sidebar({
  currentUser,
  activeTab,
  setActiveTab,
  apiStatus,
  leaving,
  handleLogout,
}: {
  currentUser: CurrentUser;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  apiStatus: string;
  leaving: boolean;
  handleLogout: () => void;
}) {
  const admin = currentUser.role === "ADMIN";
  const entries = [
    { id: "pos", label: "صندوق فروش", icon: <IconPos /> },
    { id: "tables", label: "سالن و میزها", icon: <IconTables /> },
    ...(admin
      ? [
          { id: "inventory", label: "انبار و منو", icon: <IconInventory /> },
          { id: "reports", label: "گزارشات مالی", icon: <IconReports /> },
          { id: "employees", label: "پرسنل و شیفت", icon: <IconUsers /> },
          { id: "settings", label: "تنظیمات سیستم", icon: <IconSettings /> },
        ]
      : []),
  ];

  const initialChar = currentUser.name.trim().charAt(0) || "ک";

  return (
    <aside className="no-print flex w-64 shrink-0 flex-col border-l border-slate-800/90 bg-slate-950/90 backdrop-blur-xl xl:w-72">
      <div className="border-b border-slate-800/90 p-4 xl:p-5">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 text-slate-950 shadow-md shadow-amber-950/50">
            <IconBrandMark className="h-5 w-5" />
          </div>
          <div>
            <p className="text-lg font-black tracking-tight text-white">کافه وان</p>
            <p className="text-[11px] font-medium text-slate-400">سیستم یکپارچه مدیریت کافه</p>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-slate-800/90 bg-slate-900/75 px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-amber-500/30 bg-amber-500/15 text-sm font-bold text-amber-300">
                {initialChar}
              </span>
              <p className="truncate text-sm font-bold text-slate-100">{currentUser.name}</p>
            </div>
            <span className="shrink-0 rounded-md border border-slate-700/80 bg-slate-950/80 px-2 py-0.5 text-[10px] font-semibold text-slate-300">
              {ROLE_LABELS[currentUser.role] ?? "پرسنل"}
            </span>
          </div>
          {currentUser.checkedInAt && (
            <div className="mt-2.5 flex items-center justify-between gap-1.5 whitespace-nowrap border-t border-slate-800/90 pt-2 text-[11px] tabular-nums">
              <span className="inline-flex shrink-0 items-center gap-1 text-slate-400">
                <IconClock className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                <span>شروع شیفت:</span>
              </span>
              <span className="rounded-md border border-emerald-500/25 bg-emerald-950/60 px-2 py-0.5 font-bold text-emerald-300">
                {formatCafeDateTime(currentUser.checkedInAt)}
              </span>
            </div>
          )}
        </div>
      </div>

      <nav aria-label="منوی اصلی" className="custom-scrollbar flex-1 space-y-1.5 overflow-auto p-3.5">
        {entries.map(entry => {
          const active = activeTab === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => setActiveTab(entry.id)}
              className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-right text-sm transition-all ${
                active
                  ? "border border-amber-500/40 bg-gradient-to-l from-amber-500/20 via-amber-500/10 to-slate-900/90 font-bold text-amber-200 shadow-md shadow-amber-950/30"
                  : "border border-transparent text-slate-300 hover:border-slate-800 hover:bg-slate-900 hover:text-white"
              }`}
            >
              <span className={active ? "text-amber-400" : "text-slate-400"}>{entry.icon}</span>
              <span>{entry.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="border-t border-slate-800/90 p-4">
        <p className="mb-3 flex items-center gap-2 text-xs text-slate-400">
          <span
            aria-hidden="true"
            className={`inline-block h-2 w-2 rounded-full ${
              apiStatus === "متصل" ? "bg-emerald-400" : "bg-amber-400 animate-pulse"
            }`}
          />
          <span>وضعیت سرور: {apiStatus}</span>
        </p>
        <button
          type="button"
          disabled={leaving}
          onClick={handleLogout}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm font-semibold text-slate-200 transition hover:border-rose-500/40 hover:bg-rose-950/40 hover:text-rose-200 disabled:opacity-50"
        >
          <IconLogout className="h-4 w-4" />
          <span>{leaving ? "در حال ثبت…" : "پایان شیفت و خروج"}</span>
        </button>
      </div>
    </aside>
  );
}

// ==========================================
// صندوق فروش (POSView)
// ==========================================
function POSView({
  products,
  categories,
  activeTables,
  todaySummary,
  refreshTodaySummary,
  selectedPosCategory,
  setSelectedPosCategory,
  cart,
  pendingOrder,
  isSubmitting,
  orderType,
  setOrderType,
  tableNumber,
  setTableNumber,
  paymentMethod,
  setPaymentMethod,
  orderMessage,
  totalAmount,
  addToCart,
  removeFromCart,
  clearCart,
  submitOrder,
}: {
  products: Product[];
  categories: Category[];
  activeTables: ActiveTableOrder[];
  todaySummary: TodayRegisterSummary | null;
  refreshTodaySummary: () => void;
  selectedPosCategory: number | "all";
  setSelectedPosCategory: (cat: number | "all") => void;
  cart: CartItem[];
  pendingOrder: string | null;
  isSubmitting: boolean;
  orderType: string;
  setOrderType: (t: string) => void;
  tableNumber: string;
  setTableNumber: (v: string) => void;
  paymentMethod: string;
  setPaymentMethod: (m: string) => void;
  orderMessage: { kind: "success" | "error"; text: string } | null;
  totalAmount: number;
  addToCart: (p: Product) => void;
  removeFromCart: (id: number) => void;
  clearCart: () => void;
  submitOrder: () => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [compactPosView, setCompactPosView] = useState(false);
  const [showAllProducts, setShowAllProducts] = useState(false);
  const normalizedQuery = searchQuery.trim().toLowerCase();

  const activeProducts = useMemo(
    () => products.filter(product => product.is_active !== false),
    [products]
  );

  const categoryCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const product of activeProducts) {
      counts.set(product.categoryId, (counts.get(product.categoryId) ?? 0) + 1);
    }
    return counts;
  }, [activeProducts]);

  const visibleProducts = useMemo(
    () =>
      activeProducts.filter(
        product =>
          (selectedPosCategory === "all" || product.categoryId === selectedPosCategory) &&
          (!normalizedQuery ||
            product.name.toLowerCase().includes(normalizedQuery) ||
            (product.category?.name || "").toLowerCase().includes(normalizedQuery))
      ),
    [activeProducts, selectedPosCategory, normalizedQuery]
  );

  const displayedProducts = useMemo(
    () => (showAllProducts || normalizedQuery ? visibleProducts : visibleProducts.slice(0, 80)),
    [visibleProducts, showAllProducts, normalizedQuery]
  );

  const cartQtyById = useMemo(() => {
    const map = new Map<number, number>();
    for (const item of cart) {
      map.set(item.product.id, (map.get(item.product.id) ?? 0) + item.quantity);
    }
    return map;
  }, [cart]);

  const totalCartItems = useMemo(() => cart.reduce((sum, item) => sum + item.quantity, 0), [cart]);

  const parsedTable = Number(tableNumber);
  const matchingOpenTable = useMemo(
    () => (orderType === "DINE_IN" && parsedTable > 0 ? activeTables.find(t => t.tableNumber === parsedTable) : undefined),
    [activeTables, orderType, parsedTable]
  );

  const quickTableNumbers = useMemo(() => {
    const nums = new Set<number>([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    activeTables.forEach(t => nums.add(t.tableNumber));
    return Array.from(nums).sort((a, b) => a - b);
  }, [activeTables]);

  const locked = Boolean(pendingOrder) || isSubmitting;
  const button = (selected: boolean) =>
    `rounded-xl border px-3 py-2 text-sm text-right transition-colors ${
      selected
        ? "border-amber-500/40 bg-amber-500/15 font-bold text-amber-200 shadow-sm"
        : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700 hover:bg-slate-800/80"
    }`;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <TodayRegisterStrip summary={todaySummary} onRefresh={refreshTodaySummary} />

      <div className="cafe-pos-grid min-h-0 flex-1">
        <aside className="cafe-panel custom-scrollbar min-h-0 overflow-auto p-3">
          <h2 className="mb-3 border-b border-slate-800 pb-2 text-xs font-bold tracking-wide text-slate-400">
            دسته‌بندی منو
          </h2>
          <div className="cafe-category-list flex flex-wrap gap-2">
            <button
              type="button"
              className={`flex items-center justify-between ${button(selectedPosCategory === "all")}`}
              onClick={() => {
                setSelectedPosCategory("all");
                setShowAllProducts(false);
              }}
            >
              <span>همه موارد</span>
              <span className="text-xs opacity-75 tabular-nums">{shiftMoney.format(activeProducts.length)}</span>
            </button>
            {categories.map(category => {
              const count = categoryCounts.get(category.id) ?? 0;
              return (
                <button
                  type="button"
                  key={category.id}
                  className={`flex items-center justify-between ${button(selectedPosCategory === category.id)}`}
                  onClick={() => {
                    setSelectedPosCategory(category.id);
                    setShowAllProducts(false);
                  }}
                >
                  <span className="truncate">{category.name}</span>
                  <span className="text-xs opacity-75 tabular-nums">{shiftMoney.format(count)}</span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="cafe-panel flex min-h-0 min-w-0 flex-col overflow-hidden">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-4">
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-bold text-white">منوی سفارش</h1>
              <span className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-slate-300 tabular-nums">
                {shiftMoney.format(visibleProducts.length)} محصول
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[200px] flex-1 sm:w-64">
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500">
                  <IconSearch />
                </span>
                <input
                  type="text"
                  aria-label="جستجوی محصول"
                  placeholder="جستجوی محصول یا دسته‌بندی…"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="cafe-input w-full py-2 pl-8 pr-9 text-sm"
                />
                {searchQuery && (
                  <button
                    type="button"
                    aria-label="پاک کردن جستجو"
                    onClick={() => setSearchQuery("")}
                    className="absolute left-2 top-1/2 -translate-y-1/2 rounded-md px-1.5 py-0.5 text-xs font-bold text-slate-400 transition hover:bg-slate-800 hover:text-white"
                  >
                    ×
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => setCompactPosView(v => !v)}
                className={`rounded-xl border px-3 py-2 text-xs font-bold transition ${
                  compactPosView
                    ? "border-amber-500/40 bg-amber-500/15 text-amber-200"
                    : "border-slate-700 bg-slate-900/80 text-slate-300 hover:border-slate-600 hover:text-white"
                }`}
              >
                {compactPosView ? "نمای کارتی" : "نمای فشرده"}
              </button>
            </div>
          </header>

          <div
            className={
              compactPosView
                ? "custom-scrollbar grid content-start gap-2 overflow-auto p-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
                : "custom-scrollbar grid content-start gap-3 overflow-auto p-3.5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
            }
          >
            {displayedProducts.map(product => {
              const inCartQty = cartQtyById.get(product.id) ?? 0;
              if (compactPosView) {
                return (
                  <button
                    type="button"
                    key={product.id}
                    disabled={locked}
                    onClick={() => addToCart(product)}
                    className={`group flex items-center justify-between gap-2 rounded-xl border p-2.5 text-right transition-all disabled:opacity-60 ${
                      inCartQty > 0
                        ? "border-amber-500/50 bg-amber-950/20 hover:bg-amber-950/30"
                        : "border-slate-800 bg-slate-950/75 hover:border-amber-500/40 hover:bg-slate-900"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold text-white">{product.name}</span>
                      <span className="block truncate text-[11px] text-slate-400">
                        {product.category?.name || "عمومی"}
                      </span>
                    </div>
                    <div className="shrink-0 text-left">
                      <span className="block text-xs font-black text-emerald-400 tabular-nums">
                        {shiftMoney.format(product.price)} <span className="font-normal text-slate-400">تومان</span>
                      </span>
                      {inCartQty > 0 && (
                        <span className="mt-0.5 inline-block rounded-md border border-amber-500/40 bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-black text-amber-200 tabular-nums">
                          در فیش: {shiftMoney.format(inCartQty)}
                        </span>
                      )}
                    </div>
                  </button>
                );
              }
              return (
                <button
                  type="button"
                  key={product.id}
                  disabled={locked}
                  onClick={() => addToCart(product)}
                  className={`group flex flex-col justify-between rounded-2xl border p-3.5 text-right transition-all disabled:opacity-60 ${
                    inCartQty > 0
                      ? "border-amber-500/50 bg-amber-950/15 hover:bg-amber-950/25"
                      : "border-slate-800 bg-slate-950/75 hover:border-amber-500/40 hover:bg-slate-900"
                  }`}
                >
                  <div className="mb-2.5 flex items-center justify-between gap-2">
                    <span className="truncate rounded-lg border border-slate-800 bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-400">
                      {product.category?.name || "عمومی"}
                    </span>
                    {inCartQty > 0 ? (
                      <span className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/20 px-2 py-0.5 text-[11px] font-black text-amber-200 tabular-nums">
                        در فیش: {shiftMoney.format(inCartQty)}
                      </span>
                    ) : (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500/40 transition-colors group-hover:bg-emerald-400" />
                    )}
                  </div>
                  <span className="block break-words text-sm font-bold text-white">{product.name}</span>
                  <span className="mt-2 block text-sm font-black text-emerald-400 tabular-nums">
                    {shiftMoney.format(product.price)} <span className="text-xs font-normal text-slate-400">تومان</span>
                  </span>
                </button>
              );
            })}
            {visibleProducts.length > displayedProducts.length && (
              <div className="col-span-full flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-3 text-xs text-slate-300">
                <span className="tabular-nums">
                  نمایش {shiftMoney.format(displayedProducts.length)} از {shiftMoney.format(visibleProducts.length)} محصول
                </span>
                <button
                  type="button"
                  onClick={() => setShowAllProducts(true)}
                  className="rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 font-bold text-amber-200 transition hover:bg-amber-500/25"
                >
                  نمایش همه محصولات ({shiftMoney.format(visibleProducts.length)})
                </button>
              </div>
            )}
            {visibleProducts.length === 0 && (
              <p className="col-span-full p-6 text-center text-sm text-slate-400">محصولی برای نمایش نیست.</p>
            )}
          </div>
        </section>

        <section className="cafe-panel flex min-h-0 flex-col overflow-hidden">
          <header className="flex items-center justify-between border-b border-slate-800 bg-slate-950/60 p-4">
            <div className="flex items-center gap-2">
              <h2 className="font-bold text-white">فیش جاری</h2>
              {totalCartItems > 0 && (
                <span className="rounded-lg border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-xs font-bold text-amber-200 tabular-nums">
                  {shiftMoney.format(totalCartItems)} قلم
                </span>
              )}
            </div>
            {cart.length > 0 && !locked && (
              <button
                type="button"
                onClick={clearCart}
                className="rounded-lg border border-rose-500/20 bg-rose-950/40 px-2.5 py-1 text-xs font-medium text-rose-300 transition hover:bg-rose-950/80"
              >
                خالی کردن سبد
              </button>
            )}
          </header>

          <div className="custom-scrollbar flex-1 space-y-2 overflow-auto p-3">
            {cart.length === 0 && (
              <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-950/40 p-6 text-center text-xs text-slate-400">
                برای افزودن به فیش، یک محصول را از منو انتخاب کنید.
              </div>
            )}
            {cart.map(item => (
              <div
                key={item.product.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-slate-800/90 bg-slate-950/75 p-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">{item.product.name}</p>
                  <p className="mt-0.5 text-xs text-emerald-300 tabular-nums">
                    {shiftMoney.format(item.product.price * item.quantity)} تومان
                    {item.quantity > 1 && (
                      <span className="ms-1.5 text-slate-400">({shiftMoney.format(item.product.price)})</span>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    aria-label="کم کردن تعداد"
                    disabled={locked}
                    onClick={() => removeFromCart(item.product.id)}
                    className="h-8 w-8 rounded-lg border border-slate-700 bg-slate-900 text-sm font-bold text-slate-200 hover:border-slate-500 hover:bg-slate-800 disabled:opacity-50"
                  >
                    −
                  </button>
                  <span className="w-6 text-center text-sm font-bold text-white tabular-nums">
                    {shiftMoney.format(item.quantity)}
                  </span>
                  <button
                    type="button"
                    aria-label="افزایش تعداد"
                    disabled={locked}
                    onClick={() => addToCart(item.product)}
                    className="h-8 w-8 rounded-lg border border-slate-700 bg-slate-900 text-sm font-bold text-slate-200 hover:border-slate-500 hover:bg-slate-800 disabled:opacity-50"
                  >
                    +
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-3 border-t border-slate-800 bg-slate-950/50 p-4">
            <fieldset disabled={locked} className="space-y-3 disabled:opacity-50">
              <div className="grid grid-cols-2 gap-1.5 rounded-2xl border border-slate-800 bg-slate-950/90 p-1.5">
                <button
                  type="button"
                  onClick={() => setOrderType("TAKEAWAY")}
                  className={`flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-bold transition-all ${
                    orderType === "TAKEAWAY"
                      ? "border border-emerald-500/40 bg-gradient-to-br from-emerald-600 to-teal-600 text-white shadow-md"
                      : "border border-transparent text-slate-400 hover:bg-slate-900 hover:text-slate-200"
                  }`}
                >
                  <IconTakeaway className="h-4 w-4" />
                  <span>بیرون‌بر</span>
                </button>
                <button
                  type="button"
                  onClick={() => setOrderType("DINE_IN")}
                  className={`flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs transition-all ${
                    orderType === "DINE_IN"
                      ? "border border-amber-500/40 bg-gradient-to-br from-amber-500 to-orange-600 font-black text-slate-950 shadow-md"
                      : "border border-transparent font-bold text-slate-400 hover:bg-slate-900 hover:text-slate-200"
                  }`}
                >
                  <IconTables className="h-4 w-4" />
                  <span>سالن و میز</span>
                </button>
              </div>

              {orderType === "DINE_IN" ? (
                <div className="space-y-2.5 rounded-2xl border border-amber-500/25 bg-slate-900/80 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-300">انتخاب شماره میز سالن</span>
                    <div className="flex items-center gap-1 rounded-xl border border-slate-700/80 bg-slate-950 p-0.5">
                      <button
                        type="button"
                        aria-label="کاهش شماره میز"
                        onClick={() => {
                          const next = parsedTable > 1 ? parsedTable - 1 : 1;
                          setTableNumber(String(next));
                        }}
                        className="grid h-7 w-7 place-items-center rounded-lg text-sm font-bold text-slate-300 transition hover:bg-slate-800 hover:text-white"
                      >
                        −
                      </button>
                      <span className="min-w-[68px] px-1.5 text-center text-xs font-bold text-amber-300 tabular-nums">
                        {parsedTable > 0 ? `میز ${shiftMoney.format(parsedTable)}` : "انتخاب نشده"}
                      </span>
                      <button
                        type="button"
                        aria-label="افزایش شماره میز"
                        onClick={() => {
                          const next = parsedTable >= 1 ? parsedTable + 1 : 1;
                          setTableNumber(String(next));
                        }}
                        className="grid h-7 w-7 place-items-center rounded-lg text-sm font-bold text-slate-300 transition hover:bg-slate-800 hover:text-white"
                      >
                        +
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-1.5">
                    {quickTableNumbers.map(num => {
                      const isOpen = activeTables.some(t => t.tableNumber === num);
                      const isSelected = parsedTable === num;
                      return (
                        <button
                          key={num}
                          type="button"
                          onClick={() => setTableNumber(String(num))}
                          className={`flex flex-col items-center justify-center gap-0.5 rounded-xl border px-1.5 py-2 transition-all ${
                            isSelected
                              ? "border-amber-400 bg-amber-500 font-black text-slate-950 shadow-md shadow-amber-950/40"
                              : isOpen
                                ? "border-amber-500/40 bg-amber-950/60 text-amber-200 hover:bg-amber-900/60"
                                : "border-slate-800 bg-slate-950/80 text-slate-300 hover:border-slate-700 hover:bg-slate-800"
                          }`}
                        >
                          <span className="text-xs font-bold tabular-nums">میز {shiftMoney.format(num)}</span>
                          <span className="text-[10px] opacity-80">{isOpen ? "باز" : "خالی"}</span>
                        </button>
                      );
                    })}
                  </div>

                  {matchingOpenTable && (
                    <p className="rounded-xl border border-amber-500/30 bg-amber-950/60 px-3 py-2 text-xs text-amber-200 tabular-nums">
                      میز باز · مانده فعلی: {shiftMoney.format(matchingOpenTable.totalAmount)} تومان — به فاکتور میز اضافه می‌شود
                    </p>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setPaymentMethod("CARD")}
                    className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-xs transition-all ${
                      paymentMethod === "CARD"
                        ? "border-indigo-400/50 bg-gradient-to-br from-indigo-600 to-violet-600 font-bold text-white shadow-md"
                        : "border-slate-800 bg-slate-900/80 font-semibold text-slate-300 hover:border-slate-700 hover:text-white"
                    }`}
                  >
                    <IconCard className="h-4 w-4" />
                    <span>کارت‌خوان</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaymentMethod("CASH")}
                    className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-xs transition-all ${
                      paymentMethod === "CASH"
                        ? "border-emerald-400/50 bg-gradient-to-br from-emerald-600 to-teal-600 font-bold text-white shadow-md"
                        : "border-slate-800 bg-slate-900/80 font-semibold text-slate-300 hover:border-slate-700 hover:text-white"
                    }`}
                  >
                    <IconCash className="h-4 w-4" />
                    <span>دریافت نقدی</span>
                  </button>
                </div>
              )}
            </fieldset>

            {orderMessage && (
              <p
                role={orderMessage.kind === "error" ? "alert" : "status"}
                className={`rounded-xl p-2.5 text-sm ${
                  orderMessage.kind === "error"
                    ? "border border-rose-500/30 bg-rose-950/80 text-rose-200"
                    : "border border-emerald-500/30 bg-emerald-950/80 text-emerald-200"
                }`}
              >
                {orderMessage.text}
              </p>
            )}

            <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900/90 px-3.5 py-2.5">
              <span className="text-xs font-semibold text-slate-300">جمع قابل پرداخت</span>
              <span className="text-base font-black text-emerald-400 tabular-nums">
                {shiftMoney.format(totalAmount)} <span className="text-xs font-normal text-slate-400">تومان</span>
              </span>
            </div>

            <button
              type="button"
              onClick={submitOrder}
              disabled={(!pendingOrder && cart.length === 0) || isSubmitting}
              className={`w-full rounded-xl bg-gradient-to-r px-3 py-3 text-sm transition disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-400 disabled:shadow-none ${
                orderType === "DINE_IN"
                  ? "from-amber-500 to-orange-600 font-black text-slate-950 shadow-lg shadow-amber-950/40 hover:from-amber-400 hover:to-orange-500"
                  : "from-emerald-600 to-teal-600 font-bold text-white shadow-lg shadow-emerald-950/40 hover:from-emerald-500 hover:to-teal-500"
              }`}
            >
              {isSubmitting
                ? "در حال ثبت…"
                : pendingOrder
                  ? "پیگیری سفارش قبلی"
                  : orderType === "DINE_IN"
                    ? "ثبت روی میز"
                    : "ثبت فروش"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

// ==========================================
// سالن و میزها (TablesView)
// ==========================================
function TablesView({
  activeTables,
  todaySummary,
  refreshTodaySummary,
  tablesLoading,
  tableError,
  tableNotice,
  tablePayment,
  setTablePayment,
  checkingOut,
  currentUserRole,
  fetchActiveTables,
  startTableOrder,
  checkoutTable,
  onRequestReverse,
}: {
  activeTables: ActiveTableOrder[];
  todaySummary: TodayRegisterSummary | null;
  refreshTodaySummary: () => void;
  tablesLoading: boolean;
  tableError: string;
  tableNotice: string;
  tablePayment: { orderId: number; method: "CARD" | "CASH"; amount: number } | null;
  setTablePayment: (v: { orderId: number; method: "CARD" | "CASH"; amount: number } | null) => void;
  checkingOut: boolean;
  currentUserRole: string;
  fetchActiveTables: () => Promise<void>;
  startTableOrder: (number?: number) => void;
  checkoutTable: () => Promise<void>;
  onRequestReverse: (target: ReversalTarget) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <TodayRegisterStrip summary={todaySummary} onRefresh={refreshTodaySummary} />

      <section className="cafe-panel flex min-h-0 flex-1 flex-col p-5">
        <CafePageHeading title="سالن و میزها" description={`${shiftMoney.format(activeTables.length)} میز در انتظار تسویه`}>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={checkingOut} onClick={() => startTableOrder()} className="cafe-primary">
              سفارش میز جدید
            </button>
            <button
              type="button"
              disabled={tablesLoading || checkingOut}
              onClick={() => void fetchActiveTables()}
              className="cafe-secondary"
            >
              <IconRefresh />
              <span>{tablesLoading ? "در حال دریافت…" : "به‌روزرسانی"}</span>
            </button>
          </div>
        </CafePageHeading>
        <div className="custom-scrollbar min-h-0 flex-1 overflow-auto p-1">
          {tableNotice && (
            <p role="status" className="mb-3 rounded-xl border border-emerald-500/30 bg-emerald-950 p-3 text-sm text-emerald-200">
              {tableNotice}
            </p>
          )}
          {tableError && (
            <p role="alert" className="mb-3 rounded-xl border border-rose-500/30 bg-rose-950 p-3 text-sm text-rose-200">
              {tableError}
            </p>
          )}
          {activeTables.length === 0 && !tablesLoading && !tableError && (
            <div className="rounded-2xl border border-dashed border-slate-700 p-10 text-center text-sm text-slate-400">
              میز بازی وجود ندارد. برای ثبت سفارش سالن، دکمه «سفارش میز جدید» را بزنید.
            </div>
          )}
          <div className="grid items-start gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {[...activeTables]
              .sort((a, b) => a.tableNumber - b.tableNumber)
              .map(order => (
                <article
                  key={order.id}
                  className="rounded-2xl border border-amber-500/25 bg-gradient-to-br from-amber-950/25 via-slate-900/90 to-slate-950/95 p-4"
                >
                  <header className="flex items-start justify-between gap-2">
                    <div>
                      <h2 className="w-fit rounded-lg border border-amber-500/35 bg-amber-500/15 px-3 py-1 text-sm font-bold text-amber-200">
                        میز {shiftMoney.format(order.tableNumber)}
                      </h2>
                      <p className="mt-1.5 text-xs text-slate-400">{formatCafeDateTime(order.createdAt)}</p>
                    </div>
                    <p className="text-lg font-black text-emerald-400 tabular-nums">
                      {shiftMoney.format(order.totalAmount)}{" "}
                      <span className="text-xs font-normal text-slate-400">تومان</span>
                    </p>
                  </header>
                  <ul className="custom-scrollbar my-3 max-h-44 divide-y divide-slate-800/80 overflow-auto rounded-xl border border-slate-800 bg-slate-950/70 px-3">
                    {order.items.map(item => (
                      <li key={item.id} className="flex items-center justify-between gap-2 py-2 text-sm text-slate-200">
                        <span>{item.product?.name || "محصول"}</span>
                        <span className="shrink-0 text-xs text-slate-400 tabular-nums">
                          {shiftMoney.format(item.quantity)} عدد
                        </span>
                      </li>
                    ))}
                  </ul>
                  {tablePayment?.orderId === order.id ? (
                    <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/40 p-3">
                      <p className="mb-2.5 text-sm text-emerald-100">
                        {shiftMoney.format(tablePayment.amount)} تومان با{" "}
                        {tablePayment.method === "CASH" ? "پرداخت نقدی" : "کارت‌خوان"} دریافت شد؟
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" disabled={checkingOut} onClick={() => void checkoutTable()} className="cafe-primary">
                          {checkingOut ? "در حال ثبت…" : "تأیید تسویه"}
                        </button>
                        <button
                          type="button"
                          disabled={checkingOut}
                          onClick={() => setTablePayment(null)}
                          className="cafe-secondary"
                        >
                          انصراف
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          disabled={checkingOut}
                          onClick={() =>
                            setTablePayment({ orderId: order.id, method: "CARD", amount: order.totalAmount })
                          }
                          className="flex items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-2 py-2 text-sm font-bold text-white transition hover:bg-indigo-500 disabled:opacity-50"
                        >
                          <IconCard />
                          <span>تسویه کارت</span>
                        </button>
                        <button
                          type="button"
                          disabled={checkingOut}
                          onClick={() =>
                            setTablePayment({ orderId: order.id, method: "CASH", amount: order.totalAmount })
                          }
                          className="flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-2 py-2 text-sm font-bold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                        >
                          <IconCash />
                          <span>تسویه نقدی</span>
                        </button>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800/80 pt-2 text-xs font-medium">
                        <button
                          type="button"
                          className="text-amber-300 hover:text-amber-200"
                          onClick={() => startTableOrder(order.tableNumber)}
                        >
                          + افزودن سفارش به میز
                        </button>
                        {currentUserRole === "ADMIN" && (
                          <button
                            type="button"
                            disabled={checkingOut}
                            className="text-rose-300 hover:text-rose-200"
                            onClick={() =>
                              onRequestReverse({
                                orderId: order.id,
                                action: "ابطال",
                                onSuccess: async () => {
                                  await fetchActiveTables();
                                  refreshTodaySummary();
                                },
                              })
                            }
                          >
                            ابطال سفارش میز
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </article>
              ))}
          </div>
        </div>
      </section>
    </div>
  );
}

// ==========================================
// انبار و منو (InventoryView - حرفه‌ای و شرکتی)
// ==========================================
function InventoryView({
  apiFetch,
  refreshCatalog,
}: {
  apiFetch: ApiFetch;
  refreshCatalog: () => Promise<void>;
}) {
  const [subTab, setSubTab] = useState<"products" | "categories" | "materials" | "bom">("products");

  const [inventory, setInventory] = useState<RawMaterial[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  // Product filters
  const [productSearch, setProductSearch] = useState("");
  const [productCatFilter, setProductCatFilter] = useState<number | "all">("all");

  // Category states
  const [newCategoryName, setNewCategoryName] = useState("");
  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(null);
  const [editCategoryName, setEditCategoryName] = useState("");

  // Material states
  const [newMaterial, setNewMaterial] = useState({ name: "", unit: "گرم", stock: 0 });
  const [editingMaterial, setEditingMaterial] = useState<number | null>(null);
  const [editMaterialData, setEditMaterialData] = useState({ name: "", unit: "" });
  const [movementMaterial, setMovementMaterial] = useState<{ id: number; name: string; unit: string } | null>(null);
  const [movementKind, setMovementKind] = useState("RECEIVE");
  const [movementQuantity, setMovementQuantity] = useState("");
  const [movementReason, setMovementReason] = useState("");
  const [movementBusy, setMovementBusy] = useState(false);
  const [movementError, setMovementError] = useState("");
  const [movements, setMovements] = useState<InventoryMovementRow[]>([]);
  const [moreMovements, setMoreMovements] = useState(false);

  // Product states
  const [newProduct, setNewProduct] = useState({ name: "", price: 0, categoryId: 0 });
  const [editingProductId, setEditingProductId] = useState<number | null>(null);
  const [editProductData, setEditProductData] = useState({ name: "", price: 0, categoryId: 0, is_active: true });

  // BOM states
  const [bomForm, setBomForm] = useState({ productId: 0, materialId: 0, quantity: 0 });

  const fetchData = useCallback(async () => {
    try {
      const [invRes, catRes, prodRes] = await Promise.all([
        apiFetch(`${API_BASE}/api/inventory`),
        apiFetch(`${API_BASE}/api/categories`),
        apiFetch(`${API_BASE}/api/products`),
      ]);
      if (invRes.ok) {
        const invData: RawMaterial[] = await invRes.json();
        setInventory(invData);
        setBomForm(prev => (prev.materialId === 0 && invData.length > 0 ? { ...prev, materialId: invData[0].id } : prev));
      }
      if (catRes.ok) {
        const catData: Category[] = await catRes.json();
        setCategories(catData);
        setNewProduct(prev => (prev.categoryId === 0 && catData.length > 0 ? { ...prev, categoryId: catData[0].id } : prev));
      }
      if (prodRes.ok) {
        const prodData: Product[] = await prodRes.json();
        setProducts(prodData);
        setBomForm(prev => (prev.productId === 0 && prodData.length > 0 ? { ...prev, productId: prodData[0].id } : prev));
      }
    } catch {
      setError("خطا در دریافت اطلاعات انبار و منو.");
    }
  }, [apiFetch]);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) void fetchData();
    });
    return () => {
      cancelled = true;
    };
  }, [fetchData, subTab]);

  const clearFeedback = () => {
    setNotice("");
    setError("");
  };

  // --- Categories ---
  const handleAddCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
    if (!newCategoryName.trim()) return;
    try {
      const res = await apiFetch(`${API_BASE}/api/categories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCategoryName.trim() }),
      });
      if (!res.ok) {
        setError(extractDetail(await res.json().catch(() => null), "خطا در ثبت دسته‌بندی."));
        return;
      }
      setNewCategoryName("");
      setNotice("دسته‌بندی جدید ثبت شد.");
      await fetchData();
      await refreshCatalog();
    } catch {
      setError("عدم ارتباط با سرور");
    }
  };

  const saveEditCategory = async (id: number) => {
    clearFeedback();
    if (!editCategoryName.trim()) {
      setError("نام دسته‌بندی نمی‌تواند خالی باشد.");
      return;
    }
    try {
      const res = await apiFetch(`${API_BASE}/api/categories/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editCategoryName.trim() }),
      });
      if (!res.ok) {
        setError(extractDetail(await res.json().catch(() => null), "خطا در ویرایش دسته‌بندی."));
        return;
      }
      setEditingCategoryId(null);
      setNotice("دسته‌بندی ویرایش شد.");
      await fetchData();
      await refreshCatalog();
    } catch {
      setError("خطای ارتباط با سرور");
    }
  };

  const deleteCategory = async (id: number) => {
    clearFeedback();
    if (!window.confirm("آیا از حذف این دسته‌بندی مطمئن هستید؟")) return;
    try {
      const res = await apiFetch(`${API_BASE}/api/categories/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.error) {
        setError(extractDetail(data, "خطا در حذف دسته‌بندی."));
        return;
      }
      setNotice("دسته‌بندی حذف شد.");
      await fetchData();
      await refreshCatalog();
    } catch {
      setError("خطای ارتباط با سرور");
    }
  };

  // --- Materials ---
  const handleAddMaterial = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
    if (!newMaterial.name.trim()) return;
    try {
      const res = await apiFetch(`${API_BASE}/api/inventory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newMaterial),
      });
      if (!res.ok) {
        setError(
          extractDetail(await res.json().catch(() => null), "ثبت ماده ناموفق بود. نام و موجودی اولیه را بررسی کنید.")
        );
        return;
      }
      setNewMaterial({ name: "", unit: "گرم", stock: 0 });
      setNotice("ماده اولیه جدید ثبت شد.");
      await fetchData();
    } catch {
      setError("خطا در ثبت ماده اولیه");
    }
  };

  const startEditMaterial = (item: RawMaterial) => {
    clearFeedback();
    setEditingMaterial(item.id);
    setEditMaterialData({ name: item.name, unit: item.unit });
  };

  const saveEditMaterial = async (id: number) => {
    clearFeedback();
    try {
      const res = await apiFetch(`${API_BASE}/api/inventory/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editMaterialData),
      });
      if (!res.ok) {
        setError(extractDetail(await res.json().catch(() => null), "خطا در ذخیره تغییرات"));
        return;
      }
      setEditingMaterial(null);
      setNotice("مشخصات ماده اولیه ویرایش شد.");
      await fetchData();
    } catch {
      setError("خطای ارتباط با سرور");
    }
  };

  const handleDeleteMaterial = async (id: number) => {
    clearFeedback();
    if (!window.confirm("آیا از حذف این ماده مطمئن هستید؟")) return;
    try {
      const res = await apiFetch(`${API_BASE}/api/inventory/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(extractDetail(data, "خطا در حذف ماده اولیه!"));
        return;
      }
      if (movementMaterial?.id === id) setMovementMaterial(null);
      setNotice("ماده اولیه حذف شد.");
      await fetchData();
    } catch {
      setError("خطای ارتباط با سرور");
    }
  };

  const loadMovements = async (id: number, before?: number) => {
    try {
      const res = await apiFetch(
        `${API_BASE}/api/inventory/${id}/movements${before === undefined ? "" : `?before=${before}`}`
      );
      if (!res.ok) throw new Error();
      const rows: InventoryMovementRow[] = await res.json();
      setMovements(previous => (before === undefined ? rows : [...previous, ...rows]));
      setMoreMovements(rows.length === 50);
    } catch {
      setMovementError("دریافت سابقه انبار ناموفق بود.");
    }
  };

  const selectMovementMaterial = async (item: RawMaterial) => {
    setMovementMaterial({ id: item.id, name: item.name, unit: item.unit });
    setMovementBusy(true);
    setMovementError("");
    setMovements([]);
    setMoreMovements(false);
    try {
      await loadMovements(item.id);
    } finally {
      setMovementBusy(false);
    }
  };

  const saveMovement = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!movementMaterial || movementBusy || !movementQuantity || !movementReason.trim()) return;
    setMovementBusy(true);
    setMovementError("");
    try {
      const res = await apiFetch(`${API_BASE}/api/inventory/${movementMaterial.id}/movements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: movementKind, quantity: Number(movementQuantity), reason: movementReason }),
      });
      if (!res.ok) {
        setMovementError(extractDetail(await res.json().catch(() => null), "مقدار یا دلیل معتبر وارد کنید."));
        return;
      }
      setMovementQuantity("");
      setMovementReason("");
      await fetchData();
      await loadMovements(movementMaterial.id);
    } catch {
      setMovementError("نتیجه ثبت مشخص نیست. پیش از تلاش دوباره، سابقه را بررسی کنید.");
    } finally {
      setMovementBusy(false);
    }
  };

  // --- Products ---
  const handleAddProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
    if (!newProduct.name.trim() || newProduct.price <= 0) {
      setError("نام محصول و قیمت معتبر را وارد کنید.");
      return;
    }
    const catId = newProduct.categoryId === 0 && categories.length > 0 ? categories[0].id : newProduct.categoryId;
    if (!catId) {
      setError("ابتدا یک دسته‌بندی بسازید.");
      return;
    }
    try {
      const res = await apiFetch(`${API_BASE}/api/products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newProduct.name.trim(), price: newProduct.price, categoryId: catId }),
      });
      if (!res.ok) {
        setError(extractDetail(await res.json().catch(() => null), "خطا در ثبت محصول"));
        return;
      }
      const created: Product = await res.json();
      setNotice("محصول ثبت شد. می‌توانید از تب «فرمولاسیون و کسر انبار» مواد مصرفی آن را متصل کنید.");
      setNewProduct({ name: "", price: 0, categoryId: catId });
      setBomForm(prev => ({ ...prev, productId: created.id }));
      await fetchData();
      await refreshCatalog();
    } catch {
      setError("خطا در ثبت محصول");
    }
  };

  const startEditProduct = (prod: Product) => {
    clearFeedback();
    setEditingProductId(prod.id);
    setEditProductData({
      name: prod.name,
      price: prod.price,
      categoryId: prod.categoryId,
      is_active: prod.is_active !== false,
    });
  };

  const saveEditProduct = async (id: number) => {
    clearFeedback();
    if (!editProductData.name.trim() || editProductData.price < 0) {
      setError("نام و قیمت محصول باید معتبر باشد.");
      return;
    }
    try {
      const res = await apiFetch(`${API_BASE}/api/products/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editProductData.name.trim(),
          price: editProductData.price,
          categoryId: editProductData.categoryId,
          is_active: editProductData.is_active,
        }),
      });
      if (!res.ok) {
        setError(extractDetail(await res.json().catch(() => null), "خطا در ویرایش محصول"));
        return;
      }
      setEditingProductId(null);
      setNotice("تغییرات محصول ذخیره شد.");
      await fetchData();
      await refreshCatalog();
    } catch {
      setError("خطای ارتباط با سرور");
    }
  };

  const toggleProductActive = async (prod: Product) => {
    clearFeedback();
    const nextActive = prod.is_active === false;
    try {
      const res = await apiFetch(`${API_BASE}/api/products/${prod.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: nextActive }),
      });
      if (!res.ok) {
        setError(extractDetail(await res.json().catch(() => null), "خطا در تغییر وضعیت محصول"));
        return;
      }
      setNotice(nextActive ? `محصول «${prod.name}» در منوی فروش فعال شد.` : `محصول «${prod.name}» از منوی فروش غیرفعال شد.`);
      await fetchData();
      await refreshCatalog();
    } catch {
      setError("خطای ارتباط با سرور");
    }
  };

  const deleteProduct = async (prod: Product) => {
    clearFeedback();
    if (!window.confirm(`آیا از حذف محصول «${prod.name}» مطمئن هستید؟`)) return;
    try {
      const res = await apiFetch(`${API_BASE}/api/products/${prod.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(extractDetail(data, "خطا در حذف محصول"));
        return;
      }
      setNotice(
        data?.archived && typeof data?.message === "string"
          ? data.message
          : "محصول با موفقیت حذف شد."
      );
      await fetchData();
      await refreshCatalog();
    } catch {
      setError("خطای ارتباط با سرور");
    }
  };

  // --- BOM ---
  const handleAddBom = async () => {
    clearFeedback();
    if (bomForm.productId === 0 || bomForm.materialId === 0 || bomForm.quantity <= 0) {
      setError("لطفاً محصول، ماده اولیه و مقدار مثبت را درست انتخاب کنید.");
      return;
    }
    try {
      const res = await apiFetch(`${API_BASE}/api/recipes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bomForm),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(extractDetail(data, "خطا در ثبت فرمول."));
        return;
      }
      setNotice(data?.updated ? "مقدار ماده در فرمول به‌روزرسانی شد." : "ماده اولیه به فرمول محصول متصل شد.");
      setBomForm(prev => ({ ...prev, quantity: 0 }));
      await fetchData();
      await refreshCatalog();
    } catch {
      setError("عدم ارتباط با سرور");
    }
  };

  const handleDeleteBom = async (recipeId: number) => {
    clearFeedback();
    try {
      const res = await apiFetch(`${API_BASE}/api/recipes/${recipeId}`, { method: "DELETE" });
      if (!res.ok) {
        setError(extractDetail(await res.json().catch(() => null), "خطا در حذف فرمول"));
        return;
      }
      setNotice("ارتباط فرمول حذف شد.");
      await fetchData();
      await refreshCatalog();
    } catch {
      setError("خطای ارتباط با سرور");
    }
  };

  const activeProductsCount = products.filter(p => p.is_active !== false).length;
  const lowStockCount = inventory.filter(i => i.stock < 100).length;
  const filteredProducts = products.filter(
    p =>
      (productCatFilter === "all" || p.categoryId === productCatFilter) &&
      (!productSearch.trim() || p.name.toLowerCase().includes(productSearch.trim().toLowerCase()))
  );
  const selectedProductForBom = products.find(p => p.id === bomForm.productId);

  return (
    <div className="cafe-panel flex h-full flex-col overflow-auto p-5">
      <CafePageHeading title="انبار و منو" description="مدیریت محصولات فروش، دسته‌بندی‌ها، انبار مواد اولیه و فرمولاسیون کسر خودکار">
        <div className="flex flex-wrap gap-1 rounded-xl border border-slate-800 bg-slate-950/70 p-1">
          {[
            ["products", "محصولات و منو"],
            ["categories", "دسته‌بندی‌ها"],
            ["materials", "انبار مواد اولیه"],
            ["bom", "فرمولاسیون و کسر انبار"],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                clearFeedback();
                setSubTab(id as typeof subTab);
              }}
              className={`rounded-lg px-3.5 py-2 text-sm transition-all ${
                subTab === id ? "bg-amber-500 text-slate-950 font-black shadow" : "font-semibold text-slate-400 hover:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </CafePageHeading>

      {/* کارت‌های خلاصه انبار و منو */}
      <div className="mb-5 grid shrink-0 grid-cols-2 gap-3 xl:grid-cols-4">
        <div className="cafe-card p-3.5">
          <p className="text-xs text-slate-400">محصولات فعال منو</p>
          <p className="mt-1 text-xl font-black text-white tabular-nums">
            {shiftMoney.format(activeProductsCount)}{" "}
            <span className="text-xs font-normal text-slate-400">از {shiftMoney.format(products.length)}</span>
          </p>
        </div>
        <div className="cafe-card p-3.5">
          <p className="text-xs text-slate-400">دسته‌بندی‌ها</p>
          <p className="mt-1 text-xl font-black text-blue-300 tabular-nums">{shiftMoney.format(categories.length)}</p>
        </div>
        <div className="cafe-card p-3.5">
          <p className="text-xs text-slate-400">اقلام مواد اولیه</p>
          <p className="mt-1 text-xl font-black text-emerald-300 tabular-nums">{shiftMoney.format(inventory.length)}</p>
        </div>
        <div className="cafe-card p-3.5">
          <p className="text-xs text-slate-400">هشدار کمبود موجودی</p>
          <p className={`mt-1 text-xl font-black tabular-nums ${lowStockCount > 0 ? "text-amber-400" : "text-slate-300"}`}>
            {shiftMoney.format(lowStockCount)} <span className="text-xs font-normal text-slate-400">مورد</span>
          </p>
        </div>
      </div>

      {error && (
        <p role="alert" className="mb-4 shrink-0 rounded-xl border border-rose-500/30 bg-rose-950 p-3 text-sm text-rose-200">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-4 shrink-0 rounded-xl border border-emerald-500/30 bg-emerald-950 p-3 text-sm text-emerald-200">
          {notice}
        </p>
      )}

      {subTab === "products" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
          <form onSubmit={handleAddProduct} className="cafe-card flex shrink-0 flex-wrap items-end gap-3 p-4">
            <div className="min-w-[200px] flex-1 space-y-1.5">
              <label className="text-xs text-slate-400">نام محصول جدید</label>
              <input
                type="text"
                required
                placeholder="مثال: لاته کارامل"
                className="cafe-input w-full"
                value={newProduct.name}
                onChange={e => setNewProduct({ ...newProduct, name: e.target.value })}
              />
            </div>
            <div className="w-40 space-y-1.5">
              <label className="text-xs text-slate-400">قیمت (تومان)</label>
              <input
                type="number"
                required
                min="1"
                className="cafe-input w-full tabular-nums"
                value={newProduct.price || ""}
                onChange={e => setNewProduct({ ...newProduct, price: parseInt(e.target.value, 10) || 0 })}
              />
            </div>
            <div className="w-44 space-y-1.5">
              <label className="text-xs text-slate-400">دسته‌بندی</label>
              <select
                className="cafe-input w-full"
                value={newProduct.categoryId}
                onChange={e => setNewProduct({ ...newProduct, categoryId: parseInt(e.target.value, 10) })}
              >
                {categories.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="cafe-primary h-[42px] px-6">
              افزودن محصول
            </button>
          </form>

          {/* نوار جستجو و فیلتر */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
            <div className="relative min-w-[220px] flex-1 max-w-sm">
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500">
                <IconSearch />
              </span>
              <input
                type="search"
                placeholder="جستجو در لیست محصولات…"
                value={productSearch}
                onChange={e => setProductSearch(e.target.value)}
                className="cafe-input w-full py-2 pr-9"
              />
            </div>
            <select
              aria-label="فیلتر دسته‌بندی"
              value={productCatFilter}
              onChange={e => setProductCatFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
              className="cafe-input py-2"
            >
              <option value="all">همه دسته‌بندی‌ها</option>
              {categories.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="custom-scrollbar flex-1 overflow-y-auto rounded-2xl border border-slate-800 bg-slate-950/50">
            <table className="w-full text-right text-sm text-slate-300">
              <thead className="sticky top-0 bg-slate-900/95 text-slate-200 backdrop-blur-md">
                <tr>
                  <th className="p-3.5">کد</th>
                  <th className="p-3.5">نام محصول</th>
                  <th className="p-3.5">دسته‌بندی</th>
                  <th className="p-3.5">قیمت فروش</th>
                  <th className="p-3.5">وضعیت و فرمول</th>
                  <th className="p-3.5 text-center">عملیات</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-slate-500">
                      محصولی یافت نشد.
                    </td>
                  </tr>
                ) : (
                  filteredProducts.map(product => {
                    const isActive = product.is_active !== false;
                    const recipeCount = product.recipes?.length ?? 0;
                    return (
                      <tr key={product.id} className={`border-b border-slate-800/70 hover:bg-slate-900/60 ${!isActive ? "opacity-60" : ""}`}>
                        {editingProductId === product.id ? (
                          <>
                            <td className="p-3.5 text-slate-500 tabular-nums">#{product.id}</td>
                            <td className="p-2">
                              <input
                                type="text"
                                className="cafe-input w-full"
                                value={editProductData.name}
                                onChange={e => setEditProductData({ ...editProductData, name: e.target.value })}
                              />
                            </td>
                            <td className="p-2">
                              <select
                                className="cafe-input w-full"
                                value={editProductData.categoryId}
                                onChange={e =>
                                  setEditProductData({ ...editProductData, categoryId: parseInt(e.target.value, 10) })
                                }
                              >
                                {categories.map(c => (
                                  <option key={c.id} value={c.id}>
                                    {c.name}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="p-2">
                              <input
                                type="number"
                                min="0"
                                className="cafe-input w-32 tabular-nums"
                                value={editProductData.price}
                                onChange={e =>
                                  setEditProductData({ ...editProductData, price: parseInt(e.target.value, 10) || 0 })
                                }
                              />
                            </td>
                            <td className="p-2">
                              <label className="flex items-center gap-2 text-xs text-slate-200">
                                <input
                                  type="checkbox"
                                  checked={editProductData.is_active}
                                  onChange={e => setEditProductData({ ...editProductData, is_active: e.target.checked })}
                                  className="h-4 w-4 accent-blue-600"
                                />
                                فعال در منو
                              </label>
                            </td>
                            <td className="p-3.5">
                              <div className="flex justify-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => void saveEditProduct(product.id)}
                                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white"
                                >
                                  ذخیره
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingProductId(null)}
                                  className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs text-white"
                                >
                                  لغو
                                </button>
                              </div>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="p-3.5 text-slate-500 tabular-nums">#{product.id}</td>
                            <td className="p-3.5 font-bold text-white">{product.name}</td>
                            <td className="p-3.5">
                              <span className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-300">
                                {product.category?.name || "نامشخص"}
                              </span>
                            </td>
                            <td className="p-3.5 font-bold text-emerald-400 tabular-nums">
                              {shiftMoney.format(product.price)} تومان
                            </td>
                            <td className="p-3.5">
                              <div className="flex flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => void toggleProductActive(product)}
                                  className={`rounded-lg border px-2.5 py-1 text-xs font-bold ${
                                    isActive
                                      ? "border-emerald-500/30 bg-emerald-950/70 text-emerald-300 hover:bg-emerald-900"
                                      : "border-slate-700 bg-slate-900 text-slate-400 hover:bg-slate-800"
                                  }`}
                                >
                                  {isActive ? "فعال" : "غیرفعال"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setBomForm(prev => ({ ...prev, productId: product.id }));
                                    setSubTab("bom");
                                  }}
                                  className="rounded-lg border border-orange-500/30 bg-orange-950/50 px-2.5 py-1 text-xs text-orange-300 hover:bg-orange-900/50"
                                >
                                  فرمول ({shiftMoney.format(recipeCount)})
                                </button>
                              </div>
                            </td>
                            <td className="p-3.5 text-center">
                              <div className="flex justify-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => startEditProduct(product)}
                                  aria-label={`ویرایش ${product.name}`}
                                  className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 hover:border-blue-500 hover:text-blue-300"
                                >
                                  <IconEdit />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void deleteProduct(product)}
                                  aria-label={`حذف ${product.name}`}
                                  className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 hover:border-rose-500 hover:text-rose-300"
                                >
                                  <IconTrash />
                                </button>
                              </div>
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : subTab === "categories" ? (
        <>
          <form onSubmit={handleAddCategory} className="cafe-card mb-5 flex shrink-0 flex-wrap items-end gap-3 p-4">
            <div className="min-w-[220px] flex-1 space-y-1.5">
              <label className="text-xs text-slate-400">نام دسته‌بندی جدید</label>
              <input
                type="text"
                required
                placeholder="مثال: نوشیدنی‌های سرد"
                className="cafe-input w-full"
                value={newCategoryName}
                onChange={e => setNewCategoryName(e.target.value)}
              />
            </div>
            <button type="submit" className="cafe-primary h-[42px] px-7">
              ثبت دسته‌بندی
            </button>
          </form>

          <div className="custom-scrollbar flex-1 overflow-y-auto rounded-2xl border border-slate-800 bg-slate-950/50">
            <table className="w-full text-right text-sm text-slate-300">
              <thead className="sticky top-0 bg-slate-900/95 text-slate-200 backdrop-blur-md">
                <tr>
                  <th className="p-4">شناسه</th>
                  <th className="p-4">نام دسته‌بندی</th>
                  <th className="p-4">تعداد محصولات</th>
                  <th className="p-4 text-center">عملیات</th>
                </tr>
              </thead>
              <tbody>
                {categories.map(cat => {
                  const catCount = products.filter(p => p.categoryId === cat.id).length;
                  return (
                    <tr key={cat.id} className="border-b border-slate-800/70 transition-colors hover:bg-slate-900/60">
                      {editingCategoryId === cat.id ? (
                        <>
                          <td className="p-4 text-slate-500 tabular-nums">#{cat.id}</td>
                          <td className="p-2">
                            <input
                              type="text"
                              className="cafe-input w-full"
                              value={editCategoryName}
                              onChange={e => setEditCategoryName(e.target.value)}
                            />
                          </td>
                          <td className="p-4 text-slate-400 tabular-nums">{shiftMoney.format(catCount)}</td>
                          <td className="p-4">
                            <div className="flex justify-center gap-2">
                              <button
                                type="button"
                                onClick={() => void saveEditCategory(cat.id)}
                                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white"
                              >
                                ذخیره
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingCategoryId(null)}
                                className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs text-white"
                              >
                                لغو
                              </button>
                            </div>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="p-4 text-slate-500 tabular-nums">#{cat.id}</td>
                          <td className="p-4 font-bold text-white">{cat.name}</td>
                          <td className="p-4 text-slate-400 tabular-nums">{shiftMoney.format(catCount)} محصول</td>
                          <td className="p-4 text-center">
                            <div className="flex justify-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  clearFeedback();
                                  setEditingCategoryId(cat.id);
                                  setEditCategoryName(cat.name);
                                }}
                                aria-label={`ویرایش ${cat.name}`}
                                className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 hover:border-blue-500 hover:text-blue-300"
                              >
                                <IconEdit />
                              </button>
                              <button
                                type="button"
                                onClick={() => void deleteCategory(cat.id)}
                                aria-label={`حذف ${cat.name}`}
                                className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 hover:border-rose-500 hover:text-rose-300"
                              >
                                <IconTrash />
                              </button>
                            </div>
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : subTab === "materials" ? (
        <>
          <form onSubmit={handleAddMaterial} className="cafe-card mb-5 flex shrink-0 flex-wrap items-end gap-3 p-4">
            <div className="min-w-[180px] flex-1 space-y-1.5">
              <label className="text-xs text-slate-400">نام ماده اولیه</label>
              <input
                type="text"
                required
                placeholder="مثال: دانه قهوه عربیکا"
                className="cafe-input w-full"
                value={newMaterial.name}
                onChange={e => setNewMaterial({ ...newMaterial, name: e.target.value })}
              />
            </div>
            <div className="w-36 space-y-1.5">
              <label className="text-xs text-slate-400">موجودی اولیه</label>
              <input
                type="number"
                min="0"
                step="any"
                placeholder="۰"
                className="cafe-input w-full tabular-nums"
                value={newMaterial.stock || ""}
                onChange={e => setNewMaterial({ ...newMaterial, stock: parseFloat(e.target.value) || 0 })}
              />
            </div>
            <div className="w-36 space-y-1.5">
              <label className="text-xs text-slate-400">واحد شمارش</label>
              <select
                className="cafe-input w-full"
                value={newMaterial.unit}
                onChange={e => setNewMaterial({ ...newMaterial, unit: e.target.value })}
              >
                <option>گرم</option>
                <option>میلی‌لیتر</option>
                <option>عدد</option>
              </select>
            </div>
            <button type="submit" className="cafe-primary h-[42px] px-6">
              ثبت در انبار
            </button>
          </form>

          <div className="custom-scrollbar flex-1 overflow-y-auto rounded-2xl border border-slate-800 bg-slate-950/50">
            <table className="w-full text-right text-sm text-slate-300">
              <thead className="sticky top-0 bg-slate-900/95 text-slate-200 backdrop-blur-md">
                <tr>
                  <th className="p-3.5">کد</th>
                  <th className="p-3.5">نام ماده</th>
                  <th className="p-3.5">موجودی فعلی</th>
                  <th className="p-3.5">وضعیت</th>
                  <th className="p-3.5 text-left">عملیات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {inventory.map(item => {
                  const statusBadge =
                    item.stock <= 0
                      ? { label: "اتمام موجودی", cls: "border-rose-500/30 bg-rose-950/80 text-rose-300" }
                      : item.stock < 100
                        ? { label: "کمبود موجودی", cls: "border-amber-500/30 bg-amber-950/80 text-amber-300" }
                        : { label: "موجودی کافی", cls: "border-emerald-500/30 bg-emerald-950/80 text-emerald-300" };
                  return (
                    <tr key={item.id} className="group transition-colors hover:bg-slate-900/60">
                      {editingMaterial === item.id ? (
                        <>
                          <td className="p-3.5 text-slate-500 tabular-nums">#{item.id}</td>
                          <td className="p-2">
                            <input
                              type="text"
                              className="cafe-input w-full"
                              value={editMaterialData.name}
                              onChange={e => setEditMaterialData({ ...editMaterialData, name: e.target.value })}
                            />
                          </td>
                          <td className="p-3.5 tabular-nums">{shiftMoney.format(item.stock)}</td>
                          <td className="p-2">
                            <select
                              className="cafe-input w-full"
                              value={editMaterialData.unit}
                              onChange={e => setEditMaterialData({ ...editMaterialData, unit: e.target.value })}
                            >
                              <option>گرم</option>
                              <option>میلی‌لیتر</option>
                              <option>عدد</option>
                            </select>
                          </td>
                          <td className="flex justify-end gap-2 p-3.5 text-left">
                            <button
                              type="button"
                              onClick={() => void saveEditMaterial(item.id)}
                              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white"
                            >
                              ذخیره
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingMaterial(null)}
                              className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs text-white"
                            >
                              لغو
                            </button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="p-3.5 text-slate-500 tabular-nums">#{item.id}</td>
                          <td className="p-3.5 font-bold text-white">{item.name}</td>
                          <td className="p-3.5 font-bold text-white tabular-nums">
                            {shiftMoney.format(item.stock)}{" "}
                            <span className="text-xs font-normal text-slate-400">{item.unit}</span>
                          </td>
                          <td className="p-3.5">
                            <span className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${statusBadge.cls}`}>
                              {statusBadge.label}
                            </span>
                          </td>
                          <td className="flex justify-end gap-1.5 p-3.5 text-left">
                            <button
                              type="button"
                              disabled={movementBusy}
                              onClick={() => void selectMovementMaterial(item)}
                              className="rounded-lg border border-blue-500/30 bg-blue-600/20 px-3 py-1.5 text-xs font-semibold text-blue-200 hover:bg-blue-600/35"
                            >
                              کاردکس و گردش
                            </button>
                            <button
                              type="button"
                              onClick={() => startEditMaterial(item)}
                              aria-label={`ویرایش ${item.name}`}
                              className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 hover:border-blue-500 hover:text-blue-300"
                            >
                              <IconEdit />
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteMaterial(item.id)}
                              aria-label={`حذف ${item.name}`}
                              className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 hover:border-rose-500 hover:text-rose-300"
                            >
                              <IconTrash />
                            </button>
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {movementMaterial && (
            <section className="mt-4 shrink-0 rounded-2xl border border-blue-500/25 bg-slate-950/90 p-4">
              <div className="mb-3 flex items-center justify-between border-b border-slate-800 pb-2.5">
                <h3 className="font-bold text-white">کاردکس و گردش انبار: {movementMaterial.name}</h3>
                <button
                  type="button"
                  onClick={() => setMovementMaterial(null)}
                  className="rounded-lg px-2.5 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-white"
                >
                  بستن
                </button>
              </div>
              <form onSubmit={saveMovement} className="mb-4 flex flex-wrap items-end gap-3">
                <label className="text-xs text-slate-300">
                  نوع عملیات
                  <select
                    value={movementKind}
                    onChange={e => setMovementKind(e.target.value)}
                    className="cafe-input ms-2"
                  >
                    <option value="RECEIVE">ورود / خرید</option>
                    <option value="WASTE">ضایعات</option>
                    <option value="ADJUST">اصلاح موجودی انبارگردانی</option>
                  </select>
                </label>
                <label className="text-xs text-slate-300">
                  {movementKind === "ADJUST" ? "موجودی واقعی" : "مقدار"} ({movementMaterial.unit})
                  <input
                    required
                    type="number"
                    min="0"
                    step="any"
                    value={movementQuantity}
                    onChange={e => setMovementQuantity(e.target.value)}
                    className="cafe-input ms-2 w-28 tabular-nums"
                  />
                </label>
                <input
                  required
                  maxLength={300}
                  placeholder="توضیح / شماره فاکتور خرید"
                  aria-label="دلیل ثبت"
                  value={movementReason}
                  onChange={e => setMovementReason(e.target.value)}
                  className="cafe-input min-w-[200px] flex-1"
                />
                <button disabled={movementBusy} className="cafe-primary">
                  ثبت گردش
                </button>
              </form>
              {movementError && (
                <p role="alert" className="mb-3 rounded-lg bg-rose-950 p-2.5 text-sm text-rose-200">
                  {movementError}
                </p>
              )}
              {movements.length === 0 && !movementBusy ? (
                <p className="text-sm text-slate-400">هنوز گردشی برای این ماده ثبت نشده است.</p>
              ) : (
                <div className="custom-scrollbar max-h-56 overflow-y-auto rounded-xl border border-slate-800">
                  <table className="w-full text-right text-xs text-slate-300">
                    <thead className="sticky top-0 bg-slate-900 text-slate-400">
                      <tr>
                        <th className="p-2.5">عملیات</th>
                        <th className="p-2.5">تغییر موجودی</th>
                        <th className="p-2.5">اپراتور</th>
                        <th className="p-2.5">تاریخ و ساعت</th>
                        <th className="p-2.5">توضیح</th>
                      </tr>
                    </thead>
                    <tbody>
                      {movements.map(row => (
                        <tr key={row.id} className="border-t border-slate-800/70">
                          <td className="p-2.5 font-bold text-white">
                            {{
                              OPENING: "موجودی اولیه",
                              RECEIVE: "ورود مواد",
                              WASTE: "ضایعات",
                              ADJUST: "اصلاح موجودی",
                              SALE: "مصرف سفارش",
                              RETURN: "برگشت سفارش",
                            }[row.kind] ?? row.kind}
                          </td>
                          <td className="p-2.5 tabular-nums">
                            {shiftMoney.format(row.beforeStock)} ← {shiftMoney.format(row.afterStock)} {row.unit}
                          </td>
                          <td className="p-2.5">{row.employeeName}</td>
                          <td className="p-2.5 tabular-nums">{formatCafeDateTime(row.recordedAt)}</td>
                          <td className="p-2.5 text-slate-400">
                            {row.reason}
                            {row.orderId && ` · سفارش ${shiftMoney.format(row.orderId)}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {moreMovements && (
                <button
                  type="button"
                  disabled={movementBusy}
                  className="mt-2 text-xs text-blue-300 hover:text-blue-200"
                  onClick={async () => {
                    setMovementBusy(true);
                    try {
                      await loadMovements(movementMaterial.id, movements.at(-1)?.id);
                    } finally {
                      setMovementBusy(false);
                    }
                  }}
                >
                  نمایش سوابق قدیمی‌تر
                </button>
              )}
            </section>
          )}
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden lg:flex-row">
          <div className="cafe-card flex flex-col space-y-4 p-5 lg:w-1/3">
            <h3 className="border-b border-slate-800 pb-3 text-base font-bold text-white">اتصال ماده اولیه به محصول</h3>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-400">۱. انتخاب محصول</label>
              <select
                className="cafe-input w-full"
                value={bomForm.productId}
                onChange={e => setBomForm({ ...bomForm, productId: parseInt(e.target.value, 10) })}
              >
                {products.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-400">۲. انتخاب ماده اولیه</label>
              <select
                className="cafe-input w-full"
                value={bomForm.materialId}
                onChange={e => setBomForm({ ...bomForm, materialId: parseInt(e.target.value, 10) })}
              >
                {inventory.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.unit})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-400">۳. مقدار مصرفی در هر واحد فروش</label>
              <input
                type="number"
                min="0"
                step="any"
                className="cafe-input w-full tabular-nums"
                value={bomForm.quantity || ""}
                onChange={e => setBomForm({ ...bomForm, quantity: parseFloat(e.target.value) || 0 })}
              />
            </div>
            <button type="button" onClick={() => void handleAddBom()} className="cafe-primary mt-auto py-3">
              ذخیره فرمول محصول
            </button>
          </div>

          <div className="cafe-card custom-scrollbar flex-1 overflow-y-auto p-5">
            <h3 className="mb-5 flex items-center gap-2 text-base font-bold text-white">
              <span>مواد مصرفی کسر شونده برای:</span>
              <span className="rounded-lg border border-blue-500/30 bg-blue-500/15 px-3 py-1 text-sm text-blue-300">
                {selectedProductForBom?.name || "–"}
              </span>
            </h3>

            {!selectedProductForBom || !selectedProductForBom.recipes || selectedProductForBom.recipes.length === 0 ? (
              <div className="mt-8 rounded-2xl border border-dashed border-slate-700 p-8 text-center text-sm text-slate-500">
                هنوز ماده اولیه‌ای به این محصول متصل نشده است.
              </div>
            ) : (
              <table className="w-full border-collapse text-right text-sm text-slate-300">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="pb-3">نام ماده اولیه</th>
                    <th className="pb-3">مقدار کسر در هر فروش</th>
                    <th className="pb-3 text-center">عملیات</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedProductForBom.recipes.map(recipe => {
                    const mat = inventory.find(i => i.id === recipe.materialId);
                    return (
                      <tr key={recipe.id} className="border-b border-slate-800/70 hover:bg-slate-900/50">
                        <td className="py-3.5 font-medium text-white">{mat?.name || "نامشخص"}</td>
                        <td className="py-3.5 font-bold text-amber-300 tabular-nums">
                          {shiftMoney.format(recipe.quantity)} {mat?.unit || ""}
                        </td>
                        <td className="py-3.5 text-center">
                          <button
                            type="button"
                            onClick={() => void handleDeleteBom(recipe.id)}
                            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-rose-300 hover:border-rose-500"
                          >
                            حذف ارتباط
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ==========================================
// گزارشات مالی (ReportsView)
// ==========================================
function ReportsView({
  apiFetch,
  onRequestReverse,
  refreshTodaySummary,
}: {
  apiFetch: ApiFetch;
  onRequestReverse: (target: ReversalTarget) => void;
  refreshTodaySummary: () => void;
}) {
  const [orders, setOrders] = useState<OrderHistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [timeFilter, setTimeFilter] = useState<"today" | "week" | "month" | "custom" | "all">("today");
  const [expandedOrder, setExpandedOrder] = useState<number | null>(null);
  const [visibleOrderCount, setVisibleOrderCount] = useState(60);
  const [customStartDate, setCustomStartDate] = useState<PersianDate | null>(null);
  const [customEndDate, setCustomEndDate] = useState<PersianDate | null>(null);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const limit = timeFilter === "all" || timeFilter === "custom" ? 3000 : 500;
      const response = await apiFetch(`${API_BASE}/api/orders?limit=${limit}`);
      if (!response.ok) throw new Error();
      setOrders(await response.json());
      setVisibleOrderCount(60);
    } catch {
      setError("دریافت گزارشات مالی ناموفق بود.");
    } finally {
      setLoading(false);
    }
  }, [apiFetch, timeFilter]);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) void loadOrders();
    });
    return () => {
      cancelled = true;
    };
  }, [loadOrders]);

  const reprintReceipt = async (orderId: number) => {
    setError("");
    try {
      const response = await apiFetch(`${API_BASE}/api/orders/${orderId}/reprint`, { method: "POST" });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.receiptOk) {
        setError(result?.detail || result?.receiptError || "باز کردن رسید ناموفق بود.");
      }
    } catch {
      setError("خطا در ارتباط با سرور");
    }
  };

  const now = new Date();
  const today = persianDate(now);
  const todayKey = persianDateKey(today);
  const firstYear = orders.reduce((earliest, order) => {
    const date = new Date(order.settledAt ?? order.createdAt);
    return Number.isNaN(date.getTime()) ? earliest : Math.min(earliest, persianDate(date).year);
  }, today.year - 5);
  const periodStart =
    timeFilter === "week" ? startOfCafeWeek(now) : timeFilter === "month" ? { ...today, day: 1 } : today;
  const fromKey =
    timeFilter === "custom" ? (customStartDate ? persianDateKey(customStartDate) : 0) : persianDateKey(periodStart);
  const toKey = timeFilter === "custom" && customEndDate ? persianDateKey(customEndDate) : todayKey;
  const invalidRange = timeFilter === "custom" && fromKey > toKey;

  const inPeriod = (isoDate: string) => {
    if (timeFilter === "all") return true;
    const date = new Date(isoDate);
    if (invalidRange || Number.isNaN(date.getTime())) return false;
    const key = persianDateKey(persianDate(date));
    return fromKey <= key && key <= toKey;
  };

  const filteredOrders = orders.filter(
    order => (order.status === "COMPLETED" || order.status === "REFUNDED") && inPeriod(order.settledAt ?? order.createdAt)
  );
  const completedOrders = filteredOrders.filter(order => order.status === "COMPLETED");
  const reversals = orders.filter(order => order.reversal && inPeriod(order.reversal.reversedAt));
  const refunds = reversals.filter(order => order.status === "REFUNDED");
  const refundTotal = refunds.reduce((sum, order) => sum + order.totalAmount, 0);
  const historyOrders = Array.from(new Map([...filteredOrders, ...reversals].map(order => [order.id, order])).values()).sort(
    (left, right) =>
      Date.parse(right.reversal?.reversedAt ?? right.settledAt ?? right.createdAt) -
      Date.parse(left.reversal?.reversedAt ?? left.settledAt ?? left.createdAt)
  );

  const totalRevenue = filteredOrders.reduce((sum, order) => sum + order.totalAmount, 0);
  const netRevenue = Math.max(0, totalRevenue - refundTotal);

  const totalItemsSold = completedOrders.reduce(
    (sum, order) => sum + order.items.reduce((s, i) => s + i.quantity, 0),
    0
  );
  const cardRevenue = completedOrders
    .filter(o => o.paymentMethod === "CARD")
    .reduce((sum, order) => sum + order.totalAmount, 0);
  const cashRevenue = completedOrders
    .filter(o => o.paymentMethod === "CASH")
    .reduce((sum, order) => sum + order.totalAmount, 0);
  const validRevenue = cardRevenue + cashRevenue;

  const dineInCount = completedOrders.filter(o => o.orderType === "DINE_IN").length;
  const takeawayCount = completedOrders.filter(o => o.orderType === "TAKEAWAY").length;

  const productStats: Record<string, { qty: number; rev: number }> = {};
  completedOrders.forEach(order => {
    order.items.forEach(item => {
      const name = item.product?.name || "محصول حذف شده";
      if (!productStats[name]) productStats[name] = { qty: 0, rev: 0 };
      productStats[name].qty += item.quantity;
      productStats[name].rev += item.quantity * item.price;
    });
  });

  const topProducts = Object.entries(productStats)
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 5);

  return (
    <div className="cafe-panel flex h-full flex-col overflow-auto p-5">
      <div className="mb-6 flex shrink-0 flex-col items-start justify-between gap-4 xl:flex-row xl:items-center">
        <div>
          <h2 className="mb-1 text-2xl font-bold text-white">گزارشات مالی و فروش</h2>
          <p className="text-sm text-slate-400">تحلیل فروش، مرجوعی‌ها و تفکیک روش‌های پرداخت به تاریخ شمسی</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {timeFilter === "custom" && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-blue-500/30 bg-slate-950/70 p-2">
              <PersianDatePicker
                label="از تاریخ"
                value={customStartDate}
                onChange={setCustomStartDate}
                today={today}
                firstYear={firstYear}
              />
              <PersianDatePicker
                label="تا تاریخ"
                value={customEndDate}
                onChange={setCustomEndDate}
                today={today}
                firstYear={firstYear}
              />
              {invalidRange && (
                <span role="alert" className="text-xs text-rose-300">
                  تاریخ شروع بعد از پایان است.
                </span>
              )}
            </div>
          )}

          <div className="flex rounded-xl border border-slate-800 bg-slate-950/80 p-1 shadow-inner">
            {(
              [
                ["today", "امروز"],
                ["week", "این هفته"],
                ["month", "این ماه"],
                ["custom", "تاریخ دلخواه"],
                ["all", "کل دوره"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setTimeFilter(key);
                  setVisibleOrderCount(60);
                }}
                className={`rounded-lg px-3.5 py-2 text-sm transition-all ${
                  timeFilter === key
                    ? key === "all"
                      ? "bg-slate-700 font-bold text-white"
                      : "bg-amber-500 font-black text-slate-950 shadow"
                    : "font-bold text-slate-400 hover:text-white"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <button type="button" disabled={loading} onClick={() => void loadOrders()} className="cafe-secondary">
            <IconRefresh />
            <span>{loading ? "در حال دریافت…" : "به‌روزرسانی"}</span>
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mb-4 shrink-0 rounded-xl border border-rose-500/30 bg-rose-950 p-3 text-sm text-rose-200">
          {error}
        </p>
      )}

      <div className="mb-6 grid shrink-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="flex flex-col justify-between rounded-2xl border border-blue-500/20 bg-gradient-to-br from-blue-950/50 to-slate-950/90 p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-slate-400">فروش ناخالص</p>
            <span className="rounded-lg bg-blue-500/10 p-1.5 text-blue-300">
              <IconReports className="h-4 w-4" />
            </span>
          </div>
          <h3 className="mt-2 text-2xl font-black text-blue-300 tabular-nums">
            {shiftMoney.format(totalRevenue)} <span className="text-xs font-normal text-slate-400">تومان</span>
          </h3>
          <div className="mt-3 flex justify-between border-t border-slate-800/80 pt-2 text-xs tabular-nums">
            <span className="text-rose-300">مرجوعی: {shiftMoney.format(refundTotal)}</span>
            <span className="font-bold text-emerald-300">خالص: {shiftMoney.format(netRevenue)}</span>
          </div>
        </div>

        <div className="flex flex-col justify-between rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-950/40 to-slate-950/90 p-5">
          <p className="text-sm font-medium text-slate-400">فیش‌های موفق</p>
          <div className="mt-2 flex items-baseline gap-2.5">
            <h3 className="text-2xl font-black text-emerald-400 tabular-nums">
              {shiftMoney.format(completedOrders.length)} <span className="text-xs font-normal text-slate-400">سفارش</span>
            </h3>
            <span className="text-xs text-slate-400 tabular-nums">({shiftMoney.format(totalItemsSold)} قلم)</span>
          </div>
          <p className="mt-3 border-t border-slate-800/80 pt-2 text-xs text-slate-400">
            {refunds.length > 0 ? `${shiftMoney.format(refunds.length)} مورد مرجوعی ثبت شده` : "بدون مرجوعی در این بازه"}
          </p>
        </div>

        <div className="flex flex-col justify-between rounded-2xl border border-slate-800 bg-slate-950/70 p-5">
          <p className="mb-3 text-sm font-medium text-slate-400">تفکیک پرداخت فروش موفق</p>
          <div className="mb-2 flex justify-between text-xs font-bold tabular-nums">
            <span className="flex items-center gap-1 text-indigo-300">
              <IconCard className="h-3.5 w-3.5" />
              کارت: {shiftMoney.format(cardRevenue)}
            </span>
            <span className="flex items-center gap-1 text-teal-300">
              <IconCash className="h-3.5 w-3.5" />
              نقد: {shiftMoney.format(cashRevenue)}
            </span>
          </div>
          <div className="flex h-2.5 w-full overflow-hidden rounded-full border border-slate-800 bg-slate-900">
            <div
              style={{ width: `${validRevenue === 0 ? 50 : (cardRevenue / validRevenue) * 100}%` }}
              className="h-full bg-indigo-500 transition-all"
            />
            <div
              style={{ width: `${validRevenue === 0 ? 50 : (cashRevenue / validRevenue) * 100}%` }}
              className="h-full bg-teal-500 transition-all"
            />
          </div>
        </div>

        <div className="flex flex-col justify-between rounded-2xl border border-slate-800 bg-slate-950/70 p-5">
          <p className="mb-3 text-sm font-medium text-slate-400">تفکیک نوع سرویس</p>
          <div className="grid grid-cols-2 gap-2.5">
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-2.5 text-center">
              <span className="block text-xs text-slate-400">سالن</span>
              <span className="mt-1 block text-lg font-bold text-white tabular-nums">{shiftMoney.format(dineInCount)}</span>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-2.5 text-center">
              <span className="block text-xs text-slate-400">بیرون‌بر</span>
              <span className="mt-1 block text-lg font-bold text-white tabular-nums">{shiftMoney.format(takeawayCount)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden xl:flex-row">
        <div className="flex flex-[2] flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/60">
          <div className="shrink-0 border-b border-slate-800 bg-slate-900/60 p-4">
            <h3 className="text-base font-bold text-white">تاریخچه فیش‌های صادر شده</h3>
          </div>

          <div className="custom-scrollbar flex-1 space-y-2.5 overflow-y-auto p-4">
            {historyOrders.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center p-8 text-sm text-slate-500">
                در این بازه زمانی هیچ سفارشی ثبت نشده است.
              </div>
            ) : (
              <>
                {historyOrders.slice(0, visibleOrderCount).map(order => {
                const statusBadge =
                  order.status === "REFUNDED"
                    ? { label: "مرجوع‌شده", cls: "bg-rose-500/15 text-rose-300 border-rose-500/30" }
                    : order.status === "CANCELLED"
                      ? { label: "ابطال‌شده", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" }
                      : { label: "تکمیل‌شده", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" };

                return (
                  <div
                    key={order.id}
                    className="group overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50 transition-all hover:border-slate-700"
                  >
                    <div
                      onClick={() => setExpandedOrder(expandedOrder === order.id ? null : order.id)}
                      className="flex cursor-pointer flex-wrap items-center justify-between gap-3 p-3.5 md:flex-nowrap"
                    >
                      <div className="flex flex-wrap items-center gap-2.5">
                        <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 px-2.5 py-1 font-mono text-xs font-bold text-blue-300">
                          #{order.id}
                        </div>
                        {order.orderType === "DINE_IN" ? (
                          <span className="rounded-lg border border-purple-500/25 bg-purple-500/15 px-2.5 py-1 text-xs text-purple-200">
                            سالن · میز {shiftMoney.format(order.tableNumber)}
                          </span>
                        ) : (
                          <span className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-300">
                            بیرون‌بر
                          </span>
                        )}
                        <span
                          className={`rounded-lg border px-2.5 py-1 text-xs ${
                            order.paymentMethod === "CARD"
                              ? "border-indigo-500/25 bg-indigo-500/15 text-indigo-300"
                              : "border-teal-500/25 bg-teal-500/15 text-teal-300"
                          }`}
                        >
                          {order.paymentMethod === "CARD" ? "کارت‌خوان" : "نقدی"}
                        </span>
                        <span className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${statusBadge.cls}`}>
                          {statusBadge.label}
                        </span>
                      </div>

                      <div className="flex items-center gap-4">
                        <span className="text-xs text-slate-400 tabular-nums">
                          {formatCafeDateTime(order.settledAt ?? order.createdAt)}
                        </span>
                        <span className="text-base font-black text-emerald-400 tabular-nums">
                          {shiftMoney.format(order.totalAmount)} <span className="text-xs font-normal text-slate-500">تومان</span>
                        </span>
                      </div>
                    </div>

                    {expandedOrder === order.id && (
                      <div className="border-t border-slate-800 bg-slate-950/70 p-4">
                        {order.reversal && (
                          <p className="mb-3 text-xs text-rose-300">
                            {order.status === "CANCELLED" ? "ابطال" : "مرجوعی"} در {formatCafeDateTime(order.reversal.reversedAt)}
                            {" · "}
                            {order.reversal.reason}
                            {" · "}
                            {order.reversal.restocked ? "موجودی برگشت داده شد" : "بدون برگشت موجودی"}
                          </p>
                        )}
                        <div className="mb-3 flex flex-wrap gap-2">
                          {(order.status === "COMPLETED" || order.status === "REFUNDED") && (
                            <button
                              type="button"
                              className="rounded-lg border border-blue-500/40 px-3 py-1.5 text-xs font-semibold text-blue-300 hover:bg-blue-950/50"
                              onClick={() => void reprintReceipt(order.id)}
                            >
                              باز کردن رسید برای چاپ
                            </button>
                          )}
                          {order.status === "COMPLETED" && (
                            <button
                              type="button"
                              className="rounded-lg border border-rose-500/40 px-3 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-950/50"
                              onClick={() =>
                                onRequestReverse({
                                  orderId: order.id,
                                  action: "مرجوعی",
                                  onSuccess: async () => {
                                    await loadOrders();
                                    refreshTodaySummary();
                                  },
                                })
                              }
                            >
                              ثبت مرجوعی کامل
                            </button>
                          )}
                        </div>
                        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 lg:grid-cols-3">
                          {order.items.map((item, idx) => (
                            <div
                              key={idx}
                              className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900/70 p-2.5"
                            >
                              <div className="flex items-center gap-2.5">
                                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-500/20 text-xs font-bold text-blue-300 tabular-nums">
                                  {shiftMoney.format(item.quantity)}
                                </span>
                                <span className="text-xs font-medium text-slate-200">{item.product?.name || "محصول نامشخص"}</span>
                              </div>
                              <span className="text-xs text-slate-400 tabular-nums">
                                {shiftMoney.format(item.price * item.quantity)} تومان
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
                {historyOrders.length > visibleOrderCount && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-3 text-xs text-slate-300">
                    <span className="tabular-nums">
                      نمایش {shiftMoney.format(Math.min(visibleOrderCount, historyOrders.length))} از{" "}
                      {shiftMoney.format(historyOrders.length)} سفارش
                    </span>
                    <button
                      type="button"
                      onClick={() => setVisibleOrderCount(count => count + 60)}
                      className="rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 font-bold text-amber-200 transition hover:bg-amber-500/25"
                    >
                      نمایش ۶۰ سفارش بعدی
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="flex min-h-[280px] flex-1 flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/60">
          <div className="shrink-0 border-b border-slate-800 bg-slate-900/60 p-4">
            <h3 className="text-base font-bold text-white">پرفروش‌ترین اقلام منو</h3>
          </div>
          <div className="custom-scrollbar flex-1 space-y-2.5 overflow-y-auto p-4">
            {topProducts.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-500">
                داده‌ای برای نمایش وجود ندارد.
              </div>
            ) : (
              topProducts.map((prod, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-3.5 rounded-xl border border-slate-800 bg-slate-900/60 p-3"
                >
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-black tabular-nums ${
                      idx === 0
                        ? "border border-amber-500/30 bg-amber-500/20 text-amber-300"
                        : idx === 1
                          ? "border border-slate-400/30 bg-slate-400/20 text-slate-200"
                          : idx === 2
                            ? "border border-orange-600/30 bg-orange-600/20 text-orange-300"
                            : "bg-slate-800 text-slate-400"
                    }`}
                  >
                    {shiftMoney.format(idx + 1)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="truncate text-sm font-bold text-white">{prod.name}</h4>
                    <p className="text-xs text-slate-400 tabular-nums">
                      فروش: <span className="font-semibold text-blue-300">{shiftMoney.format(prod.qty)}</span> عدد
                    </p>
                  </div>
                  <div className="text-left">
                    <span className="block text-sm font-bold text-emerald-400 tabular-nums">
                      {shiftMoney.format(prod.rev)}
                    </span>
                    <span className="text-[10px] text-slate-500">تومان</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// پرسنل، شیفت و حقوق (EmployeesView - ساده، دقیق و ۱۰۰٪ شمسی)
// ==========================================
function EmployeesView({
  apiFetch,
  currentUserId,
}: {
  apiFetch: ApiFetch;
  currentUserId: number;
}) {
  const [empSubTab, setEmpSubTab] = useState<"payroll" | "logs">("payroll");

  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [attendances, setAttendances] = useState<AttendanceRow[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [addingEmployee, setAddingEmployee] = useState(false);
  const [employeeError, setEmployeeError] = useState("");
  const [notice, setNotice] = useState("");

  // فیلتر ماه شمسی برای حقوق و تردد
  const currentPersianMonth = useMemo(() => persianDate(new Date()), []);
  const currentMonthKey = currentPersianMonth.year * 100 + currentPersianMonth.month;
  const prevMonth = useMemo(
    () => previousPersianMonth(currentPersianMonth.year, currentPersianMonth.month),
    [currentPersianMonth.month, currentPersianMonth.year]
  );
  const prevMonthKey = prevMonth.year * 100 + prevMonth.month;

  const [monthFilter, setMonthFilter] = useState<"current" | "previous" | "all">("current");
  const [logEmployeeFilter, setLogEmployeeFilter] = useState<number | "all">("all");

  const [newEmp, setNewEmp] = useState({
    name: "",
    role: "CASHIER",
    phone: "",
    password: "",
    baseSalary: 0,
    hourlyRate: 0,
    shiftStart: "08:00",
    shiftEnd: "16:00",
  });

  const [editingEmployee, setEditingEmployee] = useState<EmployeeRow | null>(null);
  const [editEmpForm, setEditEmpForm] = useState({
    name: "",
    phone: "",
    password: "",
    baseSalary: 0,
    hourlyRate: 0,
    shiftStart: "08:00",
    shiftEnd: "16:00",
    isActive: true,
  });
  const [savingEdit, setSavingEdit] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [empRes, attRes] = await Promise.all([
        apiFetch(`${API_BASE}/api/employees`),
        apiFetch(`${API_BASE}/api/attendance`),
      ]);
      if (empRes.ok) setEmployees(await empRes.json());
      if (attRes.ok) setAttendances(await attRes.json());
    } catch {
      setEmployeeError("خطا در ارتباط با سرور");
    }
  }, [apiFetch]);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) void fetchData();
    });
    return () => {
      cancelled = true;
    };
  }, [fetchData]);

  const filteredAttendances = useMemo(() => {
    return attendances.filter(log => {
      if (monthFilter !== "all") {
        const dt = new Date(log.checkIn);
        if (Number.isNaN(dt.getTime())) return false;
        const ym = persianYearMonthKey(dt);
        if (monthFilter === "current" && ym !== currentMonthKey) return false;
        if (monthFilter === "previous" && ym !== prevMonthKey) return false;
      }
      return true;
    });
  }, [attendances, currentMonthKey, monthFilter, prevMonthKey]);

  const handleAddEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (addingEmployee) return;
    setAddingEmployee(true);
    setEmployeeError("");
    setNotice("");
    try {
      const res = await apiFetch(`${API_BASE}/api/employees`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...newEmp,
          phone: newEmp.phone.trim() || null,
        }),
      });
      if (!res.ok) {
        setEmployeeError(extractDetail(await res.json().catch(() => null), "اطلاعات فرم را بررسی کنید."));
        return;
      }
      setIsAdding(false);
      setNewEmp({
        name: "",
        role: "CASHIER",
        phone: "",
        password: "",
        baseSalary: 0,
        hourlyRate: 0,
        shiftStart: "08:00",
        shiftEnd: "16:00",
      });
      setNotice("پرسنل جدید با موفقیت ثبت شد.");
      await fetchData();
    } catch {
      setEmployeeError("پاسخ ثبت دریافت نشد. پیش از تلاش دوباره فهرست پرسنل را بررسی کنید.");
    } finally {
      setAddingEmployee(false);
    }
  };

  const openEditEmployee = (emp: EmployeeRow) => {
    setEmployeeError("");
    setNotice("");
    setIsAdding(false);
    setEditingEmployee(emp);
    setEditEmpForm({
      name: emp.name,
      phone: emp.phone || "",
      password: "",
      baseSalary: emp.baseSalary,
      hourlyRate: emp.hourlyRate,
      shiftStart: emp.shiftStart,
      shiftEnd: emp.shiftEnd,
      isActive: emp.isActive,
    });
  };

  const saveEditEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingEmployee || savingEdit) return;
    setSavingEdit(true);
    setEmployeeError("");
    setNotice("");
    try {
      const payload: Record<string, unknown> = {
        name: editEmpForm.name.trim(),
        phone: editEmpForm.phone.trim() || null,
        baseSalary: editEmpForm.baseSalary,
        hourlyRate: editEmpForm.hourlyRate,
        shiftStart: editEmpForm.shiftStart,
        shiftEnd: editEmpForm.shiftEnd,
        isActive: editEmpForm.isActive,
      };
      if (editEmpForm.password.trim()) {
        payload.password = editEmpForm.password;
      }
      const res = await apiFetch(`${API_BASE}/api/employees/${editingEmployee.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setEmployeeError(extractDetail(await res.json().catch(() => null), "ویرایش پرسنل ناموفق بود."));
        return;
      }
      setEditingEmployee(null);
      setNotice("اطلاعات و حقوق پرسنل به‌روزرسانی شد.");
      await fetchData();
    } catch {
      setEmployeeError("خطای ارتباط با سرور");
    } finally {
      setSavingEdit(false);
    }
  };

  const deleteOrArchiveEmployee = async (emp: EmployeeRow) => {
    if (!window.confirm(`آیا از حذف / غیرفعال‌سازی «${emp.name}» مطمئن هستید؟`)) return;
    setEmployeeError("");
    setNotice("");
    try {
      const res = await apiFetch(`${API_BASE}/api/employees/${emp.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setEmployeeError(extractDetail(data, "حذف پرسنل ناموفق بود."));
        return;
      }
      setNotice(typeof data?.message === "string" ? data.message : "انجام شد.");
      await fetchData();
    } catch {
      setEmployeeError("خطای ارتباط با سرور");
    }
  };

  const changeRole = async (employeeId: number, role: string) => {
    if (!window.confirm("نقش این حساب تغییر کند؟ برای اعمال دسترسی جدید، پرسنل باید دوباره وارد شود.")) return;
    setEmployeeError("");
    setNotice("");
    try {
      const response = await apiFetch(`${API_BASE}/api/employees/${employeeId}/role`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (response.ok) {
        setEmployees(previous => previous.map(employee => (employee.id === employeeId ? { ...employee, role } : employee)));
        setNotice("نقش کاربری تغییر یافت.");
      } else {
        setEmployeeError(extractDetail(await response.json().catch(() => null), "تغییر نقش ناموفق بود."));
      }
    } catch {
      setEmployeeError("خطا در ارتباط با سرور");
    }
  };

  const handleCheckIn = async (employeeId: number) => {
    setEmployeeError("");
    setNotice("");
    try {
      const res = await apiFetch(`${API_BASE}/api/attendance/check-in`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId, shiftType: "FULL" }),
      });
      if (res.ok) {
        setNotice("ورود به شیفت ثبت شد.");
        await fetchData();
      } else {
        setEmployeeError(extractDetail(await res.json().catch(() => null), "ثبت ورود ناموفق بود."));
      }
    } catch {
      setEmployeeError("خطای ارتباط با سرور");
    }
  };

  const handleCheckOut = async (attendanceId: number) => {
    setEmployeeError("");
    setNotice("");
    try {
      const res = await apiFetch(`${API_BASE}/api/attendance/check-out/${attendanceId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: "خروج ثبت شده توسط مدیر" }),
      });
      if (res.ok) {
        const data = await res.json();
        setNotice(
          `خروج ثبت شد · کارکرد: ${toPersianDigits(data.metrics?.workHours ?? 0)} ساعت · اضافه‌کاری: ${toPersianDigits(data.metrics?.overtime ?? 0)} ساعت · کسر کار: ${toPersianDigits(data.metrics?.deficit ?? 0)} ساعت`
        );
        await fetchData();
      } else {
        setEmployeeError(extractDetail(await res.json().catch(() => null), "ثبت خروج ناموفق بود."));
      }
    } catch {
      setEmployeeError("خطای ارتباط با سرور");
    }
  };

  const handleDeleteAttendance = async (attendanceId: number) => {
    if (!window.confirm("این رکورد تردد حذف شود؟")) return;
    setEmployeeError("");
    setNotice("");
    try {
      const res = await apiFetch(`${API_BASE}/api/attendance/${attendanceId}`, { method: "DELETE" });
      if (!res.ok) {
        setEmployeeError(extractDetail(await res.json().catch(() => null), "حذف رکورد تردد ناموفق بود."));
        return;
      }
      setNotice("رکورد تردد حذف شد.");
      await fetchData();
    } catch {
      setEmployeeError("خطای ارتباط با سرور");
    }
  };

  const payrollData = useMemo(() => {
    return employees.map(emp => {
      const empLogs = filteredAttendances.filter(a => a.employeeId === emp.id && a.checkOut);
      const activeShift = attendances.find(a => a.employeeId === emp.id && !a.checkOut) || null;
      const totalWorkHours = empLogs.reduce((sum, a) => sum + (a.workHours || 0), 0);
      const totalOvertime = empLogs.reduce((sum, a) => sum + (a.overtime || 0), 0);
      const totalDeficit = empLogs.reduce((sum, a) => sum + (a.deficit || 0), 0);

      const autoHourly = emp.hourlyRate > 0 ? emp.hourlyRate : suggestHourlyRate(emp.baseSalary, emp.shiftStart, emp.shiftEnd);
      const isAutoRate = emp.hourlyRate <= 0 && emp.baseSalary > 0;

      const overtimePay = Math.round(totalOvertime * autoHourly);
      const deficitDeduction = Math.round(totalDeficit * autoHourly);
      const netPayable = Math.max(0, Math.round(emp.baseSalary + overtimePay - deficitDeduction));

      return {
        ...emp,
        activeShift,
        shiftsCount: empLogs.length,
        totalWorkHours: Number(totalWorkHours.toFixed(2)),
        totalOvertime: Number(totalOvertime.toFixed(2)),
        totalDeficit: Number(totalDeficit.toFixed(2)),
        effectiveRate: autoHourly,
        isAutoRate,
        overtimePay,
        deficitDeduction,
        netPayable,
      };
    });
  }, [attendances, employees, filteredAttendances]);

  const activeStaffCount = payrollData.filter(e => Boolean(e.activeShift)).length;
  const totalPeriodHours = payrollData.reduce((sum, e) => sum + e.totalWorkHours, 0);
  const totalNetPayroll = payrollData.filter(e => e.isActive).reduce((sum, e) => sum + e.netPayable, 0);

  const visibleLogs = filteredAttendances.filter(log =>
    logEmployeeFilter === "all" ? true : log.employeeId === logEmployeeFilter
  );

  const newEmpSuggestedRate = suggestHourlyRate(newEmp.baseSalary, newEmp.shiftStart, newEmp.shiftEnd);
  const editEmpSuggestedRate = suggestHourlyRate(editEmpForm.baseSalary, editEmpForm.shiftStart, editEmpForm.shiftEnd);

  return (
    <div className="cafe-panel flex h-full flex-col overflow-auto p-5">
      <CafePageHeading
        title="پرسنل، شیفت و حقوق"
        description="ثبت خودکار ورود و خروج پرسنل هنگام لاگین و محاسبه شفاف حقوق ماهانه"
      >
        <div className="no-print flex flex-wrap items-center gap-2">
          <div className="flex rounded-xl border border-slate-800 bg-slate-950/80 p-1">
            <button
              type="button"
              onClick={() => setEmpSubTab("payroll")}
              className={`rounded-lg px-4 py-2 text-sm transition ${
                empSubTab === "payroll" ? "bg-amber-500 font-black text-slate-950 shadow" : "font-bold text-slate-400 hover:text-white"
              }`}
            >
              لیست پرسنل و حقوق
            </button>
            <button
              type="button"
              onClick={() => setEmpSubTab("logs")}
              className={`rounded-lg px-4 py-2 text-sm transition ${
                empSubTab === "logs" ? "bg-amber-500 font-black text-slate-950 shadow" : "font-bold text-slate-400 hover:text-white"
              }`}
            >
              ریز ترددها
            </button>
          </div>
          {empSubTab === "payroll" && (
            <>
              <button
                type="button"
                onClick={() => {
                  setIsAdding(!isAdding);
                  setEditingEmployee(null);
                }}
                className="cafe-primary"
              >
                {isAdding ? "بستن فرم" : "+ افزودن پرسنل"}
              </button>
              <button type="button" onClick={() => window.print()} className="cafe-secondary">
                <IconPrint />
                <span>چاپ لیست حقوق</span>
              </button>
            </>
          )}
        </div>
      </CafePageHeading>

      {/* فیلتر دوره شمسی و کارت‌های خلاصه */}
      <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="no-print flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-950/70 p-1">
          <button
            type="button"
            onClick={() => setMonthFilter("current")}
            className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
              monthFilter === "current" ? "bg-emerald-600 text-white" : "text-slate-400 hover:text-white"
            }`}
          >
            {formatPersianYearMonth(currentPersianMonth.year, currentPersianMonth.month)}
          </button>
          <button
            type="button"
            onClick={() => setMonthFilter("previous")}
            className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
              monthFilter === "previous" ? "bg-emerald-600 text-white" : "text-slate-400 hover:text-white"
            }`}
          >
            {formatPersianYearMonth(prevMonth.year, prevMonth.month)}
          </button>
          <button
            type="button"
            onClick={() => setMonthFilter("all")}
            className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
              monthFilter === "all" ? "bg-slate-700 text-white" : "text-slate-400 hover:text-white"
            }`}
          >
            کل سوابق
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <div className="cafe-card px-3.5 py-2">
            <span className="block text-[11px] text-slate-400">تعداد پرسنل</span>
            <span className="text-base font-black text-white tabular-nums">{shiftMoney.format(employees.length)}</span>
          </div>
          <div className="cafe-card px-3.5 py-2">
            <span className="block text-[11px] text-slate-400">حاضر در شیفت</span>
            <span className="text-base font-black text-emerald-400 tabular-nums">{shiftMoney.format(activeStaffCount)}</span>
          </div>
          <div className="cafe-card px-3.5 py-2">
            <span className="block text-[11px] text-slate-400">مجموع کارکرد دوره</span>
            <span className="text-base font-black text-blue-300 tabular-nums">
              {toPersianDigits(totalPeriodHours.toFixed(1))} ساعت
            </span>
          </div>
          <div className="cafe-card px-3.5 py-2">
            <span className="block text-[11px] text-slate-400">جمع حقوق قابل پرداخت</span>
            <span className="text-base font-black text-emerald-300 tabular-nums">
              {shiftMoney.format(totalNetPayroll)} تومان
            </span>
          </div>
        </div>
      </div>

      {employeeError && (
        <p role="alert" className="no-print mb-4 shrink-0 rounded-xl border border-rose-500/30 bg-rose-950 p-3 text-sm text-rose-200">
          {employeeError}
        </p>
      )}
      {notice && (
        <p role="status" className="no-print mb-4 shrink-0 rounded-xl border border-emerald-500/30 bg-emerald-950 p-3 text-sm text-emerald-200">
          {notice}
        </p>
      )}

      {isAdding && empSubTab === "payroll" && (
        <form
          onSubmit={handleAddEmployee}
          className="no-print mb-5 grid shrink-0 grid-cols-1 gap-4 rounded-2xl border border-blue-500/25 bg-slate-950/80 p-5 sm:grid-cols-2 lg:grid-cols-4"
        >
          <div>
            <label className="mb-1 block text-xs text-slate-400" htmlFor="employee-name">
              نام و نام خانوادگی
            </label>
            <input
              id="employee-name"
              required
              type="text"
              value={newEmp.name}
              onChange={e => setNewEmp({ ...newEmp, name: e.target.value })}
              className="cafe-input w-full"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">سمت / نقش</label>
            <select
              value={newEmp.role}
              onChange={e => setNewEmp({ ...newEmp, role: e.target.value })}
              className="cafe-input w-full"
            >
              <option value="CASHIER">صندوق‌دار</option>
              <option value="BARISTA">باریستا</option>
              <option value="WAITER">سالن‌دار</option>
              <option value="ADMIN">مدیر سیستم</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400" htmlFor="employee-password">
              رمز ورود اختصاصی
            </label>
            <input
              id="employee-password"
              required
              minLength={4}
              maxLength={128}
              type="password"
              value={newEmp.password}
              onChange={e => setNewEmp({ ...newEmp, password: e.target.value })}
              className="cafe-input w-full"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">شماره تماس (اختیاری)</label>
            <input
              type="text"
              dir="ltr"
              value={newEmp.phone}
              onChange={e => setNewEmp({ ...newEmp, phone: e.target.value })}
              className="cafe-input w-full"
            />
          </div>
          <Time24Picker
            label="شروع شیفت موظفی"
            value={newEmp.shiftStart}
            onChange={v => setNewEmp({ ...newEmp, shiftStart: v })}
          />
          <Time24Picker
            label="پایان شیفت موظفی"
            value={newEmp.shiftEnd}
            onChange={v => setNewEmp({ ...newEmp, shiftEnd: v })}
          />
          <div>
            <label className="mb-1 block text-xs text-slate-400">حقوق پایه ماهانه (تومان)</label>
            <input
              type="number"
              min="0"
              value={newEmp.baseSalary}
              onChange={e => setNewEmp({ ...newEmp, baseSalary: Number(e.target.value) })}
              className="cafe-input w-full tabular-nums"
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-emerald-400">نرخ ساعتی اضافه‌کاری / کسرکار</span>
              {newEmpSuggestedRate > 0 && (
                <button
                  type="button"
                  onClick={() => setNewEmp({ ...newEmp, hourlyRate: newEmpSuggestedRate })}
                  className="text-[11px] text-blue-300 hover:underline"
                >
                  پیشنهاد: {shiftMoney.format(newEmpSuggestedRate)}
                </button>
              )}
            </div>
            <input
              type="number"
              min="0"
              value={newEmp.hourlyRate}
              onChange={e => setNewEmp({ ...newEmp, hourlyRate: Number(e.target.value) })}
              className="cafe-input w-full tabular-nums"
            />
          </div>
          <div className="col-span-full flex items-center justify-between gap-3 border-t border-slate-800 pt-3">
            <p className="text-xs text-slate-400">
              اگر نرخ ساعتی صفر بماند، هنگام محاسبه حقوق به‌صورت خودکار از تقسیم حقوق پایه بر ساعات موظفی ماه محاسبه می‌شود.
            </p>
            <button type="submit" disabled={addingEmployee} className="cafe-primary shrink-0 px-6">
              {addingEmployee ? "در حال ثبت…" : "ثبت پرسنل"}
            </button>
          </div>
        </form>
      )}

      {editingEmployee && empSubTab === "payroll" && (
        <form
          onSubmit={saveEditEmployee}
          className="no-print mb-5 grid shrink-0 grid-cols-1 gap-4 rounded-2xl border border-amber-500/30 bg-slate-950/85 p-5 sm:grid-cols-2 lg:grid-cols-4"
        >
          <div className="col-span-full flex items-center justify-between border-b border-slate-800 pb-2.5">
            <h3 className="font-bold text-amber-300">ویرایش مشخصات و حقوق: {editingEmployee.name}</h3>
            <button type="button" onClick={() => setEditingEmployee(null)} className="text-xs text-slate-400 hover:text-white">
              بستن
            </button>
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">نام پرسنل</label>
            <input
              required
              type="text"
              value={editEmpForm.name}
              onChange={e => setEditEmpForm({ ...editEmpForm, name: e.target.value })}
              className="cafe-input w-full"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">شماره تماس</label>
            <input
              type="text"
              dir="ltr"
              value={editEmpForm.phone}
              onChange={e => setEditEmpForm({ ...editEmpForm, phone: e.target.value })}
              className="cafe-input w-full"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">رمز جدید (در صورت نیاز)</label>
            <input
              type="password"
              minLength={4}
              maxLength={128}
              placeholder="خالی بگذارید اگر تغییر نمی‌کند"
              value={editEmpForm.password}
              onChange={e => setEditEmpForm({ ...editEmpForm, password: e.target.value })}
              className="cafe-input w-full"
            />
          </div>
          <div className="flex items-end">
            <label className="flex w-full cursor-pointer items-center gap-2 rounded-xl border border-slate-800 bg-slate-900 px-3 py-2.5 text-sm text-slate-200">
              <input
                type="checkbox"
                disabled={editingEmployee.id === currentUserId}
                checked={editEmpForm.isActive}
                onChange={e => setEditEmpForm({ ...editEmpForm, isActive: e.target.checked })}
                className="h-4 w-4 accent-blue-600"
              />
              <span>حساب فعال باشد</span>
            </label>
          </div>
          <Time24Picker
            label="شروع شیفت موظفی"
            value={editEmpForm.shiftStart}
            onChange={v => setEditEmpForm({ ...editEmpForm, shiftStart: v })}
          />
          <Time24Picker
            label="پایان شیفت موظفی"
            value={editEmpForm.shiftEnd}
            onChange={v => setEditEmpForm({ ...editEmpForm, shiftEnd: v })}
          />
          <div>
            <label className="mb-1 block text-xs text-slate-400">حقوق پایه ماهانه (تومان)</label>
            <input
              type="number"
              min="0"
              value={editEmpForm.baseSalary}
              onChange={e => setEditEmpForm({ ...editEmpForm, baseSalary: Number(e.target.value) })}
              className="cafe-input w-full tabular-nums"
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-emerald-400">نرخ ساعتی اضافه‌کاری / کسرکار</span>
              {editEmpSuggestedRate > 0 && (
                <button
                  type="button"
                  onClick={() => setEditEmpForm({ ...editEmpForm, hourlyRate: editEmpSuggestedRate })}
                  className="text-[11px] text-blue-300 hover:underline"
                >
                  پیشنهاد: {shiftMoney.format(editEmpSuggestedRate)}
                </button>
              )}
            </div>
            <input
              type="number"
              min="0"
              value={editEmpForm.hourlyRate}
              onChange={e => setEditEmpForm({ ...editEmpForm, hourlyRate: Number(e.target.value) })}
              className="cafe-input w-full tabular-nums"
            />
          </div>
          <div className="col-span-full flex justify-end gap-2">
            <button type="button" onClick={() => setEditingEmployee(null)} className="cafe-secondary">
              انصراف
            </button>
            <button type="submit" disabled={savingEdit} className="cafe-primary">
              {savingEdit ? "در حال ذخیره…" : "ذخیره تغییرات"}
            </button>
          </div>
        </form>
      )}

      {empSubTab === "payroll" && (
        <div className="custom-scrollbar flex-1 overflow-auto rounded-2xl border border-slate-800 bg-slate-950/60">
          <table className="w-full text-right text-sm text-slate-300">
            <thead className="sticky top-0 bg-slate-900/95 text-xs text-slate-300 backdrop-blur-md">
              <tr>
                <th className="p-3.5">پرسنل و سمت</th>
                <th className="p-3.5">ساعت شیفت</th>
                <th className="p-3.5">وضعیت حضور</th>
                <th className="p-3.5">کارکرد دوره</th>
                <th className="p-3.5">حقوق پایه</th>
                <th className="p-3.5 text-blue-300">اضافه‌کاری (+)</th>
                <th className="p-3.5 text-rose-300">کسر کار (-)</th>
                <th className="p-3.5 text-emerald-300">خالص پرداختی</th>
                <th className="no-print p-3.5 text-center">عملیات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {payrollData.map(data => (
                <tr key={data.id} className={`hover:bg-slate-900/60 ${!data.isActive ? "opacity-55" : ""}`}>
                  <td className="p-3.5">
                    <div className="font-bold text-white">{data.name}</div>
                    <div className="mt-1 flex items-center gap-2">
                      <select
                        aria-label={`نقش ${data.name}`}
                        value={data.role}
                        disabled={data.id === currentUserId || Boolean(data.activeShift)}
                        onChange={e => void changeRole(data.id, e.target.value)}
                        className="rounded-md border border-slate-700 bg-slate-900 px-2 py-0.5 text-xs text-slate-300 disabled:opacity-60"
                      >
                        <option value="ADMIN">مدیر سیستم</option>
                        <option value="CASHIER">صندوق‌دار</option>
                        <option value="BARISTA">باریستا</option>
                        <option value="WAITER">سالن‌دار</option>
                      </select>
                      {!data.isActive && <span className="text-[11px] text-rose-300">غیرفعال</span>}
                    </div>
                  </td>
                  <td className="p-3.5 text-xs text-slate-300 tabular-nums">
                    {toPersianDigits(data.shiftStart)} تا {toPersianDigits(data.shiftEnd)}
                  </td>
                  <td className="p-3.5">
                    {data.activeShift ? (
                      <div className="space-y-1">
                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-950/70 px-2 py-0.5 text-xs font-bold text-emerald-300">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                          حاضر در شیفت
                        </span>
                        <div className="text-[11px] text-slate-400 tabular-nums">
                          {formatCafeDateTime(data.activeShift.checkIn)}
                        </div>
                      </div>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2 py-0.5 text-xs text-slate-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-slate-500" />
                        خارج از شیفت
                      </span>
                    )}
                  </td>
                  <td className="p-3.5 tabular-nums">
                    <span className="font-bold text-white">{toPersianDigits(data.totalWorkHours)} ساعت</span>
                    <span className="block text-[11px] text-slate-500">{shiftMoney.format(data.shiftsCount)} شیفت</span>
                  </td>
                  <td className="p-3.5 tabular-nums">
                    {shiftMoney.format(data.baseSalary)} <span className="text-[11px] text-slate-500">تومان</span>
                    {data.effectiveRate > 0 && (
                      <span className="block text-[11px] text-slate-500">
                        نرخ ساعتی: {shiftMoney.format(data.effectiveRate)} {data.isAutoRate ? "(خودکار)" : ""}
                      </span>
                    )}
                  </td>
                  <td className="p-3.5 text-blue-300 tabular-nums">
                    {shiftMoney.format(data.overtimePay)} <span className="text-[11px] text-slate-500">تومان</span>
                    <span className="block text-[11px] text-blue-400/75">{toPersianDigits(data.totalOvertime)} ساعت</span>
                  </td>
                  <td className="p-3.5 text-rose-300 tabular-nums">
                    {shiftMoney.format(data.deficitDeduction)} <span className="text-[11px] text-slate-500">تومان</span>
                    <span className="block text-[11px] text-rose-400/75">{toPersianDigits(data.totalDeficit)} ساعت</span>
                  </td>
                  <td className="p-3.5">
                    <span className="inline-block rounded-xl border border-emerald-500/30 bg-emerald-500/15 px-3 py-1.5 text-sm font-black text-emerald-300 tabular-nums">
                      {shiftMoney.format(data.netPayable)} تومان
                    </span>
                  </td>
                  <td className="no-print p-3.5">
                    <div className="flex items-center justify-center gap-1.5">
                      {data.activeShift ? (
                        <button
                          type="button"
                          onClick={() => void handleCheckOut(data.activeShift!.id)}
                          className="rounded-lg bg-rose-600 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-rose-500"
                        >
                          ثبت خروج
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={!data.isActive}
                          onClick={() => void handleCheckIn(data.id)}
                          className="rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-40"
                        >
                          ثبت ورود
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => openEditEmployee(data)}
                        aria-label={`ویرایش ${data.name}`}
                        className="rounded-lg border border-slate-700 bg-slate-900 p-1.5 text-slate-300 hover:border-blue-500 hover:text-blue-300"
                      >
                        <IconEdit />
                      </button>
                      {data.id !== currentUserId && (
                        <button
                          type="button"
                          onClick={() => void deleteOrArchiveEmployee(data)}
                          aria-label={`حذف ${data.name}`}
                          className="rounded-lg border border-slate-700 bg-slate-900 p-1.5 text-slate-300 hover:border-rose-500 hover:text-rose-300"
                        >
                          <IconTrash />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {empSubTab === "logs" && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
          <div className="flex shrink-0 items-center justify-between gap-3">
            <select
              aria-label="فیلتر پرسنل"
              value={logEmployeeFilter}
              onChange={e => setLogEmployeeFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
              className="cafe-input py-2"
            >
              <option value="all">همه پرسنل</option>
              {employees.map(emp => (
                <option key={emp.id} value={emp.id}>
                  {emp.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-slate-400 tabular-nums">
              {shiftMoney.format(visibleLogs.length)} رکورد تردد
            </span>
          </div>

          <div className="custom-scrollbar flex-1 overflow-y-auto rounded-2xl border border-slate-800 bg-slate-950/60">
            <table className="w-full text-right text-sm text-slate-300">
              <thead className="sticky top-0 bg-slate-900/95 text-xs text-slate-300 backdrop-blur-md">
                <tr>
                  <th className="p-3.5">نام پرسنل</th>
                  <th className="p-3.5">تاریخ و ساعت ورود (شمسی ۲۴ ساعته)</th>
                  <th className="p-3.5">تاریخ و ساعت خروج (شمسی ۲۴ ساعته)</th>
                  <th className="p-3.5 text-emerald-400">کارکرد (ساعت)</th>
                  <th className="p-3.5 text-blue-400">اضافه کاری</th>
                  <th className="p-3.5 text-rose-400">کسر کار</th>
                  <th className="p-3.5 text-center">حذف</th>
                </tr>
              </thead>
              <tbody>
                {visibleLogs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-slate-500">
                      ترددی در این بازه ثبت نشده است.
                    </td>
                  </tr>
                ) : (
                  visibleLogs.map(log => (
                    <tr key={log.id} className="border-b border-slate-800/70 transition hover:bg-slate-900/60">
                      <td className="p-3.5 font-bold text-white">{log.employee?.name}</td>
                      <td className="p-3.5 text-xs tabular-nums">{formatCafeDateTime(log.checkIn)}</td>
                      <td className="p-3.5 text-xs tabular-nums">
                        {log.checkOut ? (
                          formatCafeDateTime(log.checkOut)
                        ) : (
                          <span className="rounded-lg border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">
                            در حال کار
                          </span>
                        )}
                      </td>
                      <td className="p-3.5 font-bold text-emerald-400 tabular-nums">
                        {log.workHours ? toPersianDigits(log.workHours) : "–"}
                      </td>
                      <td className="p-3.5 font-bold text-blue-400 tabular-nums">
                        {log.overtime ? toPersianDigits(log.overtime) : "–"}
                      </td>
                      <td className="p-3.5 font-bold text-rose-400 tabular-nums">
                        {log.deficit ? toPersianDigits(log.deficit) : "–"}
                      </td>
                      <td className="p-3.5 text-center">
                        <button
                          type="button"
                          onClick={() => void handleDeleteAttendance(log.id)}
                          aria-label="حذف رکورد تردد"
                          className="rounded-lg border border-slate-700 bg-slate-900 p-1.5 text-slate-300 hover:border-rose-500 hover:text-rose-300"
                        >
                          <IconTrash />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ==========================================
// تنظیمات سیستم (SettingsView)
// ==========================================
function SettingsView({ apiFetch }: { apiFetch: ApiFetch }) {
  const [settings, setSettings] = useState({
    cafeName: "",
    cafeSubtitle: "",
    address: "",
    phone: "",
    footerMessage: "",
    socialMedia: "",
    showLogo: true,
    printMode: "PREVIEW" as "PREVIEW" | "PRINTER" | "BOTH" | "NONE",
    printerName: "",
  });
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [testingPrint, setTestingPrint] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [previewClock, setPreviewClock] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) setPreviewClock(formatCafeDateTime(new Date().toISOString()));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadLogoPreview = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/settings/logo`);
      if (!res.ok) {
        setLogoPreviewUrl(null);
        return;
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      setLogoPreviewUrl(prev => {
        if (prev) URL.revokeObjectURL(prev);
        return objectUrl;
      });
    } catch {
      setLogoPreviewUrl(null);
    }
  }, [apiFetch]);

  useEffect(() => {
    apiFetch(`${API_BASE}/api/settings`)
      .then(res => res.json())
      .then(data => {
        if (data && !data.error) {
          setSettings({
            cafeName: data.cafeName || "",
            cafeSubtitle: data.cafeSubtitle || "",
            address: data.address || "",
            phone: data.phone || "",
            footerMessage: data.footerMessage || "",
            socialMedia: data.socialMedia || "",
            showLogo: data.showLogo !== undefined ? data.showLogo : true,
            printMode:
              data.printMode === "PRINTER" ||
              data.printMode === "BOTH" ||
              data.printMode === "NONE" ||
              data.printMode === "PREVIEW"
                ? data.printMode
                : "PREVIEW",
            printerName: data.printerName || "",
          });
          if (data.logoPath) {
            void loadLogoPreview();
          }
        }
      })
      .catch(() => setError("دریافت تنظیمات ناموفق بود."));
  }, [apiFetch, loadLogoPreview]);

  useEffect(() => {
    return () => {
      if (logoPreviewUrl) URL.revokeObjectURL(logoPreviewUrl);
    };
  }, [logoPreviewUrl]);

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setNotice("");
    setError("");
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await apiFetch(`${API_BASE}/api/upload-logo`, {
        method: "POST",
        body: formData,
      });
      if (res.ok) {
        setNotice("لوگوی اختصاصی با موفقیت در سرور ذخیره شد.");
        await loadLogoPreview();
      } else {
        setError(extractDetail(await res.json().catch(() => null), "خطا در آپلود عکس."));
      }
    } catch {
      setError("عدم ارتباط با سرور هنگام آپلود!");
    } finally {
      setIsUploading(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setNotice("");
    setError("");
    try {
      const res = await apiFetch(`${API_BASE}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (res.ok) {
        setNotice("تنظیمات با موفقیت به‌روزرسانی شد.");
      } else {
        setError(extractDetail(await res.json().catch(() => null), "ذخیره تنظیمات ناموفق بود."));
      }
    } catch {
      setError("عدم ارتباط با سرور!");
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestPrint = async () => {
    setTestingPrint(true);
    setNotice("");
    setError("");
    try {
      const res = await apiFetch(`${API_BASE}/api/settings/test-print`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          printMode: settings.printMode,
          printerName: settings.printerName,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.receiptOk) {
        setNotice(
          settings.printMode === "NONE"
            ? "فیش آزمایشی تولید شد (حالت بدون چاپ خودکار)."
            : settings.printMode === "PREVIEW"
              ? "فیش آزمایشی تولید و باز شد."
              : "فیش آزمایشی به پرینتر ویندوز ارسال شد."
        );
      } else {
        setError(extractDetail(data, data?.receiptError || "چاپ فیش آزمایشی ناموفق بود."));
      }
    } catch {
      setError("عدم ارتباط با سرور هنگام تست چاپ!");
    } finally {
      setTestingPrint(false);
    }
  };

  return (
    <div className="cafe-panel custom-scrollbar flex h-full flex-col overflow-auto p-5">
      <CafePageHeading
        title="تنظیمات سیستم و چاپگر"
        description="مدیریت اطلاعات هویتی مجموعه، پیکربندی فیش حرارتی و لوگوی چاپی"
      >
        <button type="button" onClick={() => void handleSave()} disabled={isSaving} className="cafe-primary px-6 py-2.5">
          {isSaving ? "در حال ذخیره…" : "ذخیره تنظیمات"}
        </button>
      </CafePageHeading>

      <div className="mb-5 grid shrink-0 grid-cols-2 gap-3 xl:grid-cols-4">
        <div className="cafe-card p-3.5">
          <p className="text-xs text-slate-400">عنوان تجاری مجموعه</p>
          <p className="mt-1 truncate text-lg font-black text-white">{settings.cafeName || "ثبت نشده"}</p>
        </div>
        <div className="cafe-card p-3.5">
          <p className="text-xs text-slate-400">وضعیت لوگو در فیش</p>
          <p className={`mt-1 text-lg font-black ${settings.showLogo ? "text-emerald-400" : "text-slate-400"}`}>
            {settings.showLogo ? "فعال در چاپ" : "غیرفعال"}
          </p>
        </div>
        <div className="cafe-card p-3.5">
          <p className="text-xs text-slate-400">شماره تماس روی فیش</p>
          <p className="mt-1 truncate text-lg font-black text-amber-300 tabular-nums" dir="ltr">
            {settings.phone || "ثبت نشده"}
          </p>
        </div>
        <div className="cafe-card p-3.5">
          <p className="text-xs text-slate-400">استاندارد چاپ و تقویم</p>
          <p className="mt-1 text-sm font-bold text-indigo-300">حرارتی ۸۰mm · شمسی ۲۴ ساعته</p>
        </div>
      </div>

      {error && (
        <p role="alert" className="mb-4 w-full shrink-0 rounded-xl border border-rose-500/30 bg-rose-950 p-3 text-sm text-rose-200">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-4 w-full shrink-0 rounded-xl border border-emerald-500/30 bg-emerald-950 p-3 text-sm text-emerald-200">
          {notice}
        </p>
      )}

      <div className="grid w-full grid-cols-1 items-start gap-5 xl:grid-cols-12">
        <div className="space-y-5 xl:col-span-8">
          <section className="cafe-card space-y-5 p-5">
            <header className="border-b border-slate-800 pb-3">
              <h2 className="text-base font-bold text-white">مشخصات هویتی و ارتباطی مجموعه</h2>
              <p className="mt-0.5 text-xs text-slate-400">
                این اطلاعات در سربرگ و پاورقی تمام فیش‌های مشتری و گزارش‌های چاپی درج می‌شود.
              </p>
            </header>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs text-slate-400">نام مجموعه</label>
                <input
                  type="text"
                  value={settings.cafeName}
                  onChange={e => setSettings({ ...settings, cafeName: e.target.value })}
                  className="cafe-input w-full"
                  placeholder="مثال: کافه وان"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-slate-400">زیرعنوان روی فیش</label>
                <input
                  type="text"
                  value={settings.cafeSubtitle}
                  onChange={e => setSettings({ ...settings, cafeSubtitle: e.target.value })}
                  className="cafe-input w-full"
                  placeholder="مثال: شعبه مرکزی"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-slate-400">شماره تماس</label>
                <input
                  type="text"
                  value={settings.phone}
                  onChange={e => setSettings({ ...settings, phone: e.target.value })}
                  className="cafe-input w-full"
                  placeholder="041-12345678"
                  dir="ltr"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-slate-400">شناسه شبکه اجتماعی</label>
                <input
                  type="text"
                  value={settings.socialMedia}
                  onChange={e => setSettings({ ...settings, socialMedia: e.target.value })}
                  className="cafe-input w-full"
                  placeholder="@CafeOne"
                  dir="ltr"
                />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <label className="text-xs text-slate-400">آدرس کامل مجموعه</label>
                <input
                  type="text"
                  value={settings.address}
                  onChange={e => setSettings({ ...settings, address: e.target.value })}
                  className="cafe-input w-full"
                  placeholder="آدرس کامل مجموعه"
                />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <label className="text-xs text-slate-400">پیام قدردانی پایین فیش</label>
                <input
                  type="text"
                  value={settings.footerMessage}
                  onChange={e => setSettings({ ...settings, footerMessage: e.target.value })}
                  className="cafe-input w-full"
                  placeholder="مثال: از حضور شما سپاسگزاریم"
                />
              </div>
            </div>
          </section>

          <section className="cafe-card space-y-4 p-5">
            <header className="border-b border-slate-800 pb-3">
              <h2 className="text-base font-bold text-white">تنظیمات ظاهری و لوگوی فیش چاپی</h2>
              <p className="mt-0.5 text-xs text-slate-400">مدیریت تصویر لوگوی حرارتی و نمایش آن روی خروجی چاپ</p>
            </header>

            <div className="flex flex-col items-start justify-between gap-4 rounded-xl border border-slate-800 bg-slate-900/70 p-4 sm:flex-row sm:items-center">
              <div className="flex items-center gap-4">
                {logoPreviewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={logoPreviewUrl}
                    alt="پیش‌نمایش لوگوی کافه"
                    className="h-14 w-14 rounded-xl border border-slate-700 bg-white object-contain p-1"
                  />
                ) : (
                  <div className="grid h-14 w-14 place-items-center rounded-xl border border-dashed border-slate-700 bg-slate-950 text-slate-500">
                    <IconPrint className="h-6 w-6" />
                  </div>
                )}
                <div>
                  <h3 className="text-sm font-bold text-slate-200">لوگوی چاپی فیش</h3>
                  <p className="mt-1 text-xs text-slate-400">تصویر مربع با کنتراست بالا برای چاپ حرارتی انتخاب کنید.</p>
                </div>
              </div>

              <div className="relative w-full sm:w-auto">
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleLogoUpload}
                  disabled={isUploading}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                />
                <button type="button" disabled={isUploading} className="cafe-secondary w-full sm:w-auto">
                  {isUploading ? "در حال آپلود…" : "انتخاب تصویر لوگو"}
                </button>
              </div>
            </div>

            <div className="grid gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="printModeSelect" className="block text-xs font-bold text-slate-300">
                  نحوه خروجی فیش فروش (فیش‌پرینتر / پیش‌نمایش)
                </label>
                <select
                  id="printModeSelect"
                  value={settings.printMode}
                  onChange={e =>
                    setSettings({
                      ...settings,
                      printMode: e.target.value as "PREVIEW" | "PRINTER" | "BOTH" | "NONE",
                    })
                  }
                  className="cafe-input w-full py-2.5 text-sm"
                >
                  <option value="PREVIEW">پیش‌نمایش روی صفحه (پیش‌فرض)</option>
                  <option value="PRINTER">ارسال مستقیم به فیش‌پرینتر ویندوز</option>
                  <option value="BOTH">چاپ مستقیم + پیش‌نمایش روی صفحه</option>
                  <option value="NONE">فقط ثبت فیش بدون چاپ خودکار</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="printerNameInput" className="block text-xs font-bold text-slate-300">
                  نام دقیق پرینتر در ویندوز (خالی = پرینتر پیش‌فرض سیستم)
                </label>
                <input
                  id="printerNameInput"
                  type="text"
                  dir="ltr"
                  placeholder="e.g. POS-80C"
                  value={settings.printerName}
                  disabled={settings.printMode === "PREVIEW" || settings.printMode === "NONE"}
                  onChange={e => setSettings({ ...settings, printerName: e.target.value })}
                  className="cafe-input w-full py-2.5 text-left text-sm disabled:opacity-50"
                />
              </div>
            </div>

            <label
              htmlFor="showLogoToggle"
              className="flex cursor-pointer select-none items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-4 text-sm font-bold text-slate-200 transition hover:border-slate-700"
            >
              <input
                type="checkbox"
                checked={settings.showLogo}
                onChange={e => setSettings({ ...settings, showLogo: e.target.checked })}
                className="h-5 w-5 cursor-pointer rounded border-slate-600 accent-emerald-500"
                id="showLogoToggle"
              />
              <span>چاپ لوگو در بالای فیش فروش فعال باشد</span>
            </label>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
              <p className="text-xs text-slate-400">تغییرات بلافاصله روی فیش‌های بعدی اعمال می‌شوند.</p>
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => void handleTestPrint()}
                  disabled={testingPrint || isSaving}
                  className="cafe-secondary px-5 py-2.5 text-xs font-bold"
                >
                  {testingPrint ? "در حال چاپ آزمایشی…" : "تست چاپ فیش آزمایشی"}
                </button>
                <button type="button" onClick={() => void handleSave()} disabled={isSaving} className="cafe-primary px-8 py-2.5">
                  {isSaving ? "در حال ذخیره…" : "ذخیره تنظیمات"}
                </button>
              </div>
            </div>
          </section>
        </div>

        <aside className="cafe-card flex flex-col p-5 xl:col-span-4">
          <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-3">
            <h2 className="text-sm font-bold text-white">پیش‌نمایش زنده فیش مشتری</h2>
            <span className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-bold text-amber-300">
              ۸۰ میلی‌متر
            </span>
          </div>

          <div className="mx-auto w-full max-w-xs rounded-2xl border border-slate-300 bg-white p-5 text-slate-900 shadow-xl">
            <div className="flex flex-col items-center border-b border-dashed border-slate-300 pb-3.5 text-center">
              {settings.showLogo && logoPreviewUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoPreviewUrl} alt="لوگوی فیش" className="mb-2 h-14 w-14 object-contain" />
              )}
              <p className="text-base font-black text-slate-950">{settings.cafeName || "کافه وان"}</p>
              <p className="mt-0.5 text-xs font-medium text-slate-600">{settings.cafeSubtitle || "شعبه مرکزی"}</p>
            </div>

            <div className="space-y-1 border-b border-dashed border-slate-300 py-2.5 text-[11px] text-slate-700 tabular-nums">
              <div className="flex justify-between">
                <span>شماره فیش:</span>
                <span className="font-bold text-slate-950">#۱۰۴</span>
              </div>
              <div className="flex justify-between">
                <span>نوع سرویس:</span>
                <span className="font-semibold text-slate-900">سالن · میز ۳</span>
              </div>
              <div className="flex justify-between">
                <span>تاریخ و ساعت:</span>
                <span>{previewClock || "۱۴۰۵/۰۸/۲۴، ۱۴:۳۰"}</span>
              </div>
            </div>

            <div className="space-y-1.5 border-b border-dashed border-slate-300 py-3 text-xs tabular-nums">
              <div className="flex justify-between text-slate-800">
                <span>اسپرسو دبل × ۱</span>
                <span className="font-semibold">۸۵,۰۰۰</span>
              </div>
              <div className="flex justify-between text-slate-800">
                <span>کیک شکلاتی × ۱</span>
                <span className="font-semibold">۱۱۰,۰۰۰</span>
              </div>
            </div>

            <div className="flex items-center justify-between border-b border-dashed border-slate-300 py-3 text-sm font-black text-slate-950 tabular-nums">
              <span>مبلغ قابل پرداخت</span>
              <span>۱۹۵,۰۰۰ تومان</span>
            </div>

            <div className="space-y-1 pt-3 text-center text-[11px] text-slate-600">
              {settings.address && <p>{settings.address}</p>}
              <div className="flex flex-wrap justify-center gap-2 tabular-nums" dir="ltr">
                {settings.phone && <span>{settings.phone}</span>}
                {settings.socialMedia && <span>{settings.socialMedia}</span>}
              </div>
              <p className="pt-1 font-bold text-slate-800">{settings.footerMessage || "از حضور شما سپاسگزاریم"}</p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ==========================================
// ریشه اپلیکیشن (Dashboard)
// ==========================================
export default function Dashboard() {
  const [pendingOrder, setPendingOrder] = useState<string | null>(null);
  const submittingOrder = useRef(false);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [token, setToken] = useState("");
  const apiFetch = useCallback<ApiFetch>(
    async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      const response = await fetch(url, { ...init, headers });
      if (response.status === 401) {
        setToken("");
        setCurrentUser(null);
      }
      return response;
    },
    [token]
  );

  const [loginPassword, setLoginPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loginTab, setLoginTab] = useState<"staff" | "admin">("staff");
  const [loginClock, setLoginClock] = useState("");

  useEffect(() => {
    if (currentUser) return;
    let cancelled = false;
    const syncClock = () => {
      if (!cancelled) setLoginClock(formatCafeDateTime(new Date().toISOString()));
    };
    Promise.resolve().then(syncClock);
    const timer = setInterval(syncClock, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [currentUser]);

  const [activeTab, setActiveTab] = useState("pos");
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [apiStatus, setApiStatus] = useState("در حال اتصال...");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedPosCategory, setSelectedPosCategory] = useState<number | "all">("all");
  const [paymentMethod, setPaymentMethod] = useState("CARD");
  const [orderType, setOrderType] = useState("TAKEAWAY");
  const [tableNumber, setTableNumber] = useState("");
  const [orderMessage, setOrderMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const [todaySummary, setTodaySummary] = useState<TodayRegisterSummary | null>(null);
  const [activeTables, setActiveTables] = useState<ActiveTableOrder[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tableError, setTableError] = useState("");
  const [tableNotice, setTableNotice] = useState("");
  const [tablePayment, setTablePayment] = useState<{ orderId: number; method: "CARD" | "CASH"; amount: number } | null>(
    null
  );
  const [checkingOut, setCheckingOut] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [reversalTarget, setReversalTarget] = useState<ReversalTarget | null>(null);

  const refreshCatalog = useCallback(async () => {
    if (!token) return;
    const [prodRes, catRes] = await Promise.all([
      apiFetch(`${API_BASE}/api/products`),
      apiFetch(`${API_BASE}/api/categories`),
    ]);
    if (prodRes.status === 401) return;
    if (!prodRes.ok) throw new Error("Server Error");
    setProducts(await prodRes.json());
    if (catRes.ok) setCategories(await catRes.json());
    setApiStatus("متصل");
  }, [apiFetch, token]);

  const fetchTodaySummary = useCallback(async () => {
    if (!token) return;
    try {
      const res = await apiFetch(`${API_BASE}/api/register/today`);
      if (res.ok) setTodaySummary(await res.json());
    } catch {
      // silent retry on next user action
    }
  }, [apiFetch, token]);

  const fetchActiveTables = useCallback(async () => {
    if (!token) return;
    setTablesLoading(true);
    setTableError("");
    try {
      const res = await apiFetch(`${API_BASE}/api/tables/active`);
      if (!res.ok) throw new Error();
      setActiveTables(await res.json());
    } catch {
      setTableError("دریافت میزهای باز ناموفق بود. دوباره به‌روزرسانی کنید.");
    } finally {
      setTablesLoading(false);
    }
  }, [apiFetch, token]);

  useEffect(() => {
    if (!token) return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout>;
    const fetchInitialData = async () => {
      try {
        await refreshCatalog();
        void fetchActiveTables();
        void fetchTodaySummary();
      } catch {
        setApiStatus("در حال اتصال...");
        if (!stopped) retry = setTimeout(fetchInitialData, 3000);
      }
    };
    void fetchInitialData();
    return () => {
      stopped = true;
      clearTimeout(retry);
    };
  }, [fetchActiveTables, fetchTodaySummary, refreshCatalog, token]);

  useEffect(() => {
    if (!token) return;
    if (activeTab === "tables" || activeTab === "pos") {
      let cancelled = false;
      Promise.resolve().then(() => {
        if (!cancelled) {
          void fetchTodaySummary();
          if (activeTab === "tables" || orderType === "DINE_IN") {
            void fetchActiveTables();
          }
        }
      });
      return () => {
        cancelled = true;
      };
    }
  }, [activeTab, fetchActiveTables, fetchTodaySummary, orderType, token]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: loginPassword, loginMode: loginTab }),
      });
      const data = await res.json();
      if (data.success) {
        setCart([]);
        setOrderMessage(null);
        setTableNumber("");
        setToken(data.token);
        try {
          setPendingOrder(localStorage.getItem(pendingOrderKey(data.employee.id)));
        } catch {
          setPendingOrder(null);
        }
        setCurrentUser(data.employee);
        setLoginError("");
        setLoginPassword("");
        setActiveTab("pos");
      } else {
        setLoginError(data.error);
      }
    } catch {
      setLoginError("خطا در ارتباط با سرور بک‌اند");
    }
  };

  const handleLogout = async () => {
    if (leaving || isSubmitting || checkingOut) return;
    if (pendingOrder) {
      setActiveTab("pos");
      setOrderMessage({ kind: "error", text: "اول وضعیت سفارش قبلی را مشخص کنید." });
      return;
    }
    const message = "شیفت کاری شما پایان یابد و از حساب خارج شوید؟";
    if (!window.confirm(cart.length ? `${message} سبد ثبت‌نشده پاک می‌شود.` : message)) return;
    setLeaving(true);
    try {
      const response = await apiFetch(`${API_BASE}/api/logout`, { method: "POST" });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        alert(extractDetail(data, "خروج ثبت نشد. دوباره تلاش کنید."));
        return;
      }
      setCart([]);
      setTableNumber("");
      setTodaySummary(null);
      setToken("");
      setCurrentUser(null);
    } catch {
      alert("نتیجه خروج مشخص نیست. اتصال را بررسی و دوباره تلاش کنید.");
    } finally {
      setLeaving(false);
    }
  };

  const checkoutTable = async () => {
    if (checkingOut || !tablePayment) return;
    const { orderId, method, amount } = tablePayment;
    setCheckingOut(true);
    setTableNotice("");
    setTableError("");
    try {
      const res = await apiFetch(`${API_BASE}/api/orders/${orderId}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentMethod: method, expectedAmount: amount }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        await fetchActiveTables();
        setTableError(extractDetail(data, "تسویه ثبت نشد."));
      } else {
        setActiveTables(tables => tables.filter(order => order.id !== orderId));
        void fetchTodaySummary();
        setTableNotice(
          data?.receiptOk === false
            ? "تسویه ثبت شد. باز کردن رسید ناموفق بود و می‌توان از گزارش مالی دوباره آن را باز کرد."
            : "تسویه ثبت شد."
        );
      }
      setTablePayment(null);
    } catch {
      await fetchActiveTables();
      setTablePayment(null);
      setTableError("پاسخ تسویه دریافت نشد. قبل از دریافت دوباره وجه، وضعیت میز را بررسی کنید.");
    } finally {
      setCheckingOut(false);
    }
  };

  const addToCart = (product: Product) => {
    if (pendingOrder) {
      setOrderMessage({ kind: "error", text: "ابتدا نتیجه سفارش قبلی را با دکمه پیگیری مشخص کنید." });
      return;
    }
    setCart(prev => {
      const existing = prev.find(item => item.product.id === product.id);
      if (existing) {
        return prev.map(item => (item.product.id === product.id ? { ...item, quantity: item.quantity + 1 } : item));
      }
      return [...prev, { product, quantity: 1 }];
    });
  };

  const removeFromCart = (productId: number) => {
    if (pendingOrder) {
      setOrderMessage({ kind: "error", text: "ابتدا نتیجه سفارش قبلی را با دکمه پیگیری مشخص کنید." });
      return;
    }
    setCart(prev => {
      const existing = prev.find(item => item.product.id === productId);
      if (existing && existing.quantity > 1) {
        return prev.map(item => (item.product.id === productId ? { ...item, quantity: item.quantity - 1 } : item));
      }
      return prev.filter(item => item.product.id !== productId);
    });
  };

  const clearCart = () => {
    if (pendingOrder || isSubmitting) return;
    setCart([]);
    setOrderMessage(null);
  };

  const totalAmount = cart.reduce((sum, item) => sum + item.product.price * item.quantity, 0);

  const submitOrder = async () => {
    if (submittingOrder.current || !currentUser || (!pendingOrder && cart.length === 0)) return;
    setOrderMessage(null);
    if (!pendingOrder && orderType === "DINE_IN" && (!Number.isInteger(Number(tableNumber)) || Number(tableNumber) < 1)) {
      setOrderMessage({ kind: "error", text: "شماره میز را وارد کنید." });
      return;
    }

    submittingOrder.current = true;
    setIsSubmitting(true);
    const key = pendingOrderKey(currentUser.id);
    const remember = (body: string | null) => {
      setPendingOrder(body);
      try {
        if (body === null) localStorage.removeItem(key);
        else localStorage.setItem(key, body);
      } catch {
        // The current window can still retry using its in-memory copy.
      }
    };

    try {
      const body =
        pendingOrder ??
        JSON.stringify({
          submissionId: crypto.randomUUID(),
          items: cart.map(c => ({ productId: c.product.id, quantity: c.quantity, price: c.product.price })),
          paymentMethod,
          orderType,
          tableNumber: Number(tableNumber) || 0,
        });
      remember(body);
      const response = await apiFetch(`${API_BASE}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.status !== "success") {
        if (response.status === 409 || response.status === 422) remember(null);
        setOrderMessage({
          kind: "error",
          text: extractDetail(data, "نتیجه ثبت مشخص نشد. همان سفارش را پیگیری کنید."),
        });
        return;
      }

      remember(null);
      setCart([]);
      setTableNumber("");
      void fetchActiveTables();
      void fetchTodaySummary();
      if (data.replayed) {
        setOrderMessage({ kind: "success", text: `سفارش شماره ${shiftMoney.format(data.orderId)} قبلاً ثبت شده بود.` });
      } else if (data.orderStatus === "PENDING") {
        setOrderMessage({ kind: "success", text: "سفارش میز ثبت شد. رسید موقع تسویه صادر می‌شود." });
      } else if (data.receiptOk === false) {
        setOrderMessage({ kind: "error", text: "سفارش ثبت شد. برای بازکردن دوباره رسید، از گزارش مالی استفاده کنید." });
      } else {
        setOrderMessage({ kind: "success", text: "فروش بیرون‌بر ثبت شد." });
      }
    } catch {
      setOrderMessage({ kind: "error", text: "نتیجه ثبت مشخص نشد. همان سفارش را پیگیری کنید." });
    } finally {
      submittingOrder.current = false;
      setIsSubmitting(false);
    }
  };

  const startTableOrder = (number?: number) => {
    if (pendingOrder || isSubmitting || cart.length) {
      setTableError("ابتدا سفارش فعلی را ثبت یا سبد آن را خالی کنید.");
      return;
    }
    setOrderType("DINE_IN");
    setTableNumber(number === undefined ? "" : String(number));
    setActiveTab("pos");
  };

  // صفحه ورود کافه وان (تطبیق‌شده با تصویر مرجع، بدون اسکرول و با هویت گرم کافه)
  if (!currentUser) {
    return (
      <main
        dir="ltr"
        className="grid h-screen max-h-screen w-full grid-cols-1 overflow-hidden bg-[#FAF3EB] text-[#26130B] lg:grid-cols-12"
      >
        {/* نیمه چپ: تصویر باکیفیت اسپرسوساز */}
        <section className="relative hidden h-full min-h-0 overflow-hidden bg-[#160B06] lg:col-span-6 lg:block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/login-espresso.jpg"
            alt="اسپرسوساز کافه وان"
            className="h-full w-full object-cover object-center"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-[#160B06]/90 via-[#160B06]/40 to-transparent"
          />
          <div
            dir="rtl"
            className="absolute inset-x-5 bottom-4 flex items-center justify-between gap-3 rounded-2xl border border-[#C89D66]/30 bg-[#1B0E08]/95 px-4 py-2.5 text-xs text-[#F5E6D3] shadow-xl tabular-nums"
          >
            <span className="inline-flex items-center gap-2 font-bold text-[#F3C68F]">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              سیستم آماده به کار
            </span>
            <span className="font-medium text-[#E5D3BE]">{loginClock || "تقویم رسمی شمسی"}</span>
          </div>
        </section>

        {/* نیمه راست: پنل ورود شرکتی با طیف گرم و روشن */}
        <section
          dir="rtl"
          className="flex h-full min-h-0 flex-col justify-between overflow-hidden bg-gradient-to-b from-[#FFFDF9] via-[#FAF3EB] to-[#F3E7D9] px-6 py-4 sm:px-10 lg:col-span-6 lg:px-14 xl:px-20 xl:py-6"
        >
          {/* هدر برند */}
          <header className="flex shrink-0 items-center justify-between gap-4">
            <div dir="ltr" className="inline-flex items-center gap-2.5">
              <IconCoffeeBeans className="h-8 w-8 shrink-0" />
              <span className="font-serif text-2xl font-black tracking-tight text-[#2B160C] sm:text-3xl">Cafe One</span>
            </div>
            <span className="rounded-full border border-[#DFCBB5] bg-white px-3.5 py-1 text-[11px] font-bold text-[#7A4424] shadow-sm">
              نسخه سازمانی
            </span>
          </header>

          {/* فرم مرکزی ورود */}
          <div className="mx-auto my-auto w-full max-w-md space-y-4 py-2 xl:space-y-5">
            <div className="space-y-2">
              <h1 className="text-center text-2xl font-black tracking-tight text-[#26130B] sm:text-3xl xl:text-4xl">
                ورود به کافه وان
              </h1>
              <p className="text-justify text-xs leading-5 text-[#6D4C3D] sm:text-[13px] sm:leading-6">
                سامانه یکپارچه مدیریت فروش، سالن و میزها، کنترل انبار و ثبت خودکار شیفت پرسنل با تقویم رسمی شمسی و ساعت ۲۴ ساعته آماده ثبت عملیات کاری شماست.
              </p>
            </div>

            {/* سوئیچر دو تبی پرسنل / مدیریت */}
            <div
              role="tablist"
              aria-label="نوع ورود به سامانه"
              className="grid grid-cols-2 gap-1.5 rounded-full border border-[#D7C2AC] bg-white/95 p-1 shadow-sm"
            >
              <button
                type="button"
                role="tab"
                aria-selected={loginTab === "staff"}
                onClick={() => {
                  setLoginTab("staff");
                  setLoginError("");
                }}
                className={`rounded-full px-4 py-2 text-sm transition-all ${
                  loginTab === "staff"
                    ? "bg-gradient-to-l from-[#D4B085] to-[#C49A6C] font-black text-[#26130B] shadow-sm"
                    : "font-bold text-[#6B4A38] hover:bg-[#FAF3EB] hover:text-[#26130B]"
                }`}
              >
                پرسنل
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={loginTab === "admin"}
                onClick={() => {
                  setLoginTab("admin");
                  setLoginError("");
                }}
                className={`rounded-full px-4 py-2 text-sm transition-all ${
                  loginTab === "admin"
                    ? "bg-gradient-to-l from-[#B88652] to-[#9E6B3B] font-black text-white shadow-sm"
                    : "font-bold text-[#6B4A38] hover:bg-[#FAF3EB] hover:text-[#26130B]"
                }`}
              >
                مدیریت
              </button>
            </div>

            <form onSubmit={handleLogin} className="space-y-3.5">
              <div className="space-y-1.5">
                <label htmlFor="login-password" className="block text-sm font-bold text-[#3B2115]">
                  رمز عبور {loginTab === "admin" ? "مدیریت" : ""}
                </label>
                <div className="relative flex items-center rounded-2xl border-2 border-[#D0B89F] bg-white transition-all focus-within:border-[#7A4424] focus-within:ring-4 focus-within:ring-[#C89D66]/25">
                  <IconLock className="pointer-events-none absolute right-4 h-5 w-5 text-[#5C3A28]" />
                  <input
                    id="login-password"
                    type={showPassword ? "text" : "password"}
                    required
                    autoFocus
                    value={loginPassword}
                    onChange={e => setLoginPassword(e.target.value)}
                    placeholder={
                      loginTab === "admin"
                        ? "رمز عبور مدیر سیستم را وارد کنید"
                        : "رمز عبور اختصاصی پرسنل را وارد کنید"
                    }
                    className="w-full rounded-2xl bg-transparent py-3 pl-12 pr-12 text-center text-lg font-bold tracking-widest text-[#26130B] outline-none placeholder:text-xs placeholder:font-normal placeholder:tracking-normal placeholder:text-[#A38B77] xl:py-3.5"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(v => !v)}
                    aria-label={showPassword ? "مخفی کردن رمز" : "نمایش رمز"}
                    className="absolute left-3.5 rounded-lg p-1.5 text-[#5C3A28] transition hover:bg-[#F5EBE0] hover:text-[#26130B]"
                  >
                    <IconEye open={showPassword} className="h-5 w-5" />
                  </button>
                </div>
              </div>

              {loginError && (
                <p
                  role="alert"
                  className="rounded-xl border border-rose-300 bg-rose-50 px-3.5 py-2 text-center text-xs font-semibold text-rose-800 sm:text-sm"
                >
                  {loginError}
                </p>
              )}

              <button
                type="submit"
                className="w-full rounded-2xl bg-gradient-to-l from-[#4A2511] via-[#3B1D0E] to-[#2B1409] py-3 text-sm font-black text-white shadow-lg shadow-[#3B1D0E]/25 transition hover:from-[#5C2F16] hover:to-[#3B1D0E] active:scale-[0.995] sm:text-base xl:py-3.5"
              >
                ورود به سیستم
              </button>
            </form>

            <p className="rounded-2xl border border-[#E5D3BE] bg-white/80 px-4 py-2.5 text-justify text-[11px] leading-5 text-[#6D4C3D] sm:text-xs">
              با ثبت ورود در هر یک از بخش‌های پرسنل یا مدیریت، زمان شروع شیفت کاری شما به‌صورت خودکار در سیستم تردد ثبت شده و تا زمان ثبت خروج فعال می‌ماند.
            </p>
          </div>

          {/* پاورقی پنل ورود */}
          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[#E5D3BE] pt-2.5 text-[11px] text-[#7D5E4D] tabular-nums sm:text-xs">
            <span>تقویم ۱۰۰٪ شمسی · ساعت ۲۴ ساعته</span>
            <span className="lg:hidden">{loginClock || "آماده به کار"}</span>
          </footer>
        </section>
      </main>
    );
  }

  return (
    <main dir="rtl" className="flex h-screen overflow-hidden bg-slate-950 text-slate-200">
      <Sidebar
        currentUser={currentUser}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        apiStatus={apiStatus}
        leaving={leaving}
        handleLogout={handleLogout}
      />
      <div className="cafe-workspace h-full min-w-0 flex-1 overflow-hidden bg-[radial-gradient(ellipse_at_top,_rgba(30,41,59,0.45),_transparent_70%)] p-4">
        {activeTab === "pos" && (
          <POSView
            products={products}
            categories={categories}
            activeTables={activeTables}
            todaySummary={todaySummary}
            refreshTodaySummary={() => void fetchTodaySummary()}
            selectedPosCategory={selectedPosCategory}
            setSelectedPosCategory={setSelectedPosCategory}
            cart={cart}
            pendingOrder={pendingOrder}
            isSubmitting={isSubmitting}
            orderType={orderType}
            setOrderType={setOrderType}
            tableNumber={tableNumber}
            setTableNumber={setTableNumber}
            paymentMethod={paymentMethod}
            setPaymentMethod={setPaymentMethod}
            orderMessage={orderMessage}
            totalAmount={totalAmount}
            addToCart={addToCart}
            removeFromCart={removeFromCart}
            clearCart={clearCart}
            submitOrder={submitOrder}
          />
        )}
        {activeTab === "tables" && (
          <TablesView
            activeTables={activeTables}
            todaySummary={todaySummary}
            refreshTodaySummary={() => void fetchTodaySummary()}
            tablesLoading={tablesLoading}
            tableError={tableError}
            tableNotice={tableNotice}
            tablePayment={tablePayment}
            setTablePayment={setTablePayment}
            checkingOut={checkingOut}
            currentUserRole={currentUser.role}
            fetchActiveTables={fetchActiveTables}
            startTableOrder={startTableOrder}
            checkoutTable={checkoutTable}
            onRequestReverse={setReversalTarget}
          />
        )}
        {currentUser.role === "ADMIN" && activeTab === "inventory" && (
          <InventoryView apiFetch={apiFetch} refreshCatalog={refreshCatalog} />
        )}
        {currentUser.role === "ADMIN" && activeTab === "reports" && (
          <ReportsView
            apiFetch={apiFetch}
            onRequestReverse={setReversalTarget}
            refreshTodaySummary={() => void fetchTodaySummary()}
          />
        )}
        {currentUser.role === "ADMIN" && activeTab === "settings" && <SettingsView apiFetch={apiFetch} />}
        {currentUser.role === "ADMIN" && activeTab === "employees" && (
          <EmployeesView apiFetch={apiFetch} currentUserId={currentUser.id} />
        )}
      </div>

      {reversalTarget && (
        <ReversalModal target={reversalTarget} apiFetch={apiFetch} onClose={() => setReversalTarget(null)} />
      )}
    </main>
  );
}
