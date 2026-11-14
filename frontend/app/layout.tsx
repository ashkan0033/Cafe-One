import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// بارگذاری فونت وزیرمتن با پشتیبانی از حروف عربی و فارسی
const vazirmatn = localFont({ src: "./Vazirmatn-Regular.ttf" });

export const metadata: Metadata = {
  title: "POS - سیستم مدیریت",
  description: "نرم‌افزار جامع مدیریت کافه رستوران",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fa" dir="rtl" className="dark">
      <body className={`${vazirmatn.className} bg-slate-950 text-slate-100 min-h-screen antialiased`}>
        {children}
      </body>
    </html>
  );
}