import type { Metadata, Viewport } from "next";
import { Big_Shoulders, Martian_Mono } from "next/font/google";
import "./globals.css";

const display = Big_Shoulders({
  subsets: ["latin"],
  variable: "--font-display",
});

const mono = Martian_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "H.E.L.M. — Heads-up Executive Logic Module",
  description: "Ember Core HUD — the helm over the vault",
};

// viewport-fit=cover so env(safe-area-inset-*) resolves on notched phones
// (the chat composer + phone HUD lean on it); themeColor tints the mobile
// browser/PWA chrome to the reactor black.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0a0d",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning: DarkReader & similar extensions inject attrs on
    // <html>/<body> before hydration — silence those (descendants still checked)
    <html lang="en" suppressHydrationWarning>
      <body className={`${display.variable} ${mono.variable}`} suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
