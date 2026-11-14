export type PersianDate = { year: number; month: number; day: number };

export const persianMonths = [
  "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
] as const;

const timeZone = "Asia/Tehran";

const persianDay = new Intl.DateTimeFormat("en", {
  timeZone,
  calendar: "persian",
  numberingSystem: "latn",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

const gregorianDay = new Intl.DateTimeFormat("en", {
  timeZone,
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

const persianDateTime24 = new Intl.DateTimeFormat("fa-IR", {
  timeZone,
  calendar: "persian",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const persianDigits = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

export function toPersianDigits(value: string | number): string {
  return String(value).replace(/\d/g, d => persianDigits[Number(d)]);
}

function dateParts(formatter: Intl.DateTimeFormat, date: Date): PersianDate {
  const parts = formatter.formatToParts(date);
  return {
    year: Number(parts.find(part => part.type === "year")?.value),
    month: Number(parts.find(part => part.type === "month")?.value),
    day: Number(parts.find(part => part.type === "day")?.value),
  };
}

export function persianDate(date: Date): PersianDate {
  return dateParts(persianDay, date);
}

export function persianDateKey({ year, month, day }: PersianDate): number {
  return year * 10_000 + month * 100 + day;
}

export function persianYearMonthKey(date: Date): number {
  const { year, month } = persianDate(date);
  return year * 100 + month;
}

export function previousPersianMonth(year: number, month: number): { year: number; month: number } {
  if (month > 1) return { year, month: month - 1 };
  return { year: year - 1, month: 12 };
}

export function formatPersianYearMonth(year: number, month: number): string {
  const monthName = persianMonths[month - 1] ?? "";
  return `${monthName} ${toPersianDigits(year)}`;
}

export function daysInPersianMonth(year: number, month: number): number {
  if (month <= 6) return 31;
  if (month <= 11) return 30;
  // Esfand 30, if present, falls near the Gregorian March equinox.
  for (let marchDay = 18; marchDay <= 22; marchDay++) {
    const date = persianDate(new Date(Date.UTC(year + 622, 2, marchDay, 12)));
    if (date.year === year && date.month === 12 && date.day === 30) return 30;
  }
  return 29;
}

export function startOfCafeWeek(now: Date): PersianDate {
  const { year, month, day } = dateParts(gregorianDay, now);
  const localDate = new Date(Date.UTC(year, month - 1, day, 12));
  localDate.setUTCDate(localDate.getUTCDate() - ((localDate.getUTCDay() + 1) % 7));
  return persianDate(localDate);
}

export function formatCafeDateTime(value?: string | null): string {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  const parts = Object.fromEntries(persianDateTime24.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}/${parts.month}/${parts.day} · ${parts.hour}:${parts.minute}`;
}

export function formatPersonnelDateTime(value?: string | null): string {
  return formatCafeDateTime(value);
}

export function formatCafeDateOnly(value?: string | null): string {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  const parts = Object.fromEntries(persianDateTime24.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}/${parts.month}/${parts.day}`;
}
