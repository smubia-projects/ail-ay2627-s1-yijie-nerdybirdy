import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { Footer } from "@/components/Footer";
import { ApiNotices } from "@/components/RateLimitCTA";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NerdyBirdy — your AI professor for your own notes",
  description:
    "Upload your lecture notes, ask questions with page citations, and quiz yourself with verified questions.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-slate-50 text-slate-900">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-2xl items-center px-4 py-3">
            <Link href="/" className="text-lg font-bold text-slate-900">
              🦉 Nerdy<span className="text-indigo-700">Birdy</span>
            </Link>
          </div>
        </header>
        <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6 [overflow-wrap:anywhere]">{children}</main>
        <Footer />
        <ApiNotices />
      </body>
    </html>
  );
}
