import type { Metadata } from "next";
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
