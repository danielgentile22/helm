import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import Shell from "@/components/shell/Shell";

// Halo type system: Inter for UI/headlines/body, JetBrains Mono for every
// metric and token value. Exposed as --font-display / --font-mono so the CSS
// keeps its variable names (now carrying the Halo faces).
const display = Inter({
  subsets: ["latin"],
  variable: "--font-display",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "H.E.L.M. — Heads-up Executive Logic Module",
  description: "Project-tabbed heads-up display over the vault",
};

// viewport-fit=cover so env(safe-area-inset-*) resolves on notched phones (the
// bottom tab bar + chat composer lean on it); themeColor tints mobile chrome to
// the Halo canvas.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0A0B0F",
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
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
