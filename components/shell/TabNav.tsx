"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Briefcase, Target, Crown, MessageSquare, type LucideIcon } from "lucide-react";
import { TABS, type TabId } from "@/lib/tabs";

// Lucide icons keyed by tab — the tab registry names them; this binds the names
// to components (Halo's one icon library, one stroke weight).
const ICONS: Record<TabId, LucideIcon> = {
  today: LayoutDashboard,
  morphy: Briefcase,
  jobs: Target,
  chess: Crown,
  chat: MessageSquare,
};

// Which registry route is active — exact for "/", prefix for the rest so
// nested paths still light their tab.
function isActive(pathname: string, route: string): boolean {
  return route === "/" ? pathname === "/" : pathname === route || pathname.startsWith(route + "/");
}

export default function TabNav({ variant }: { variant: "pill" | "bottom" }) {
  const pathname = usePathname();
  const tabs = variant === "bottom" ? TABS.filter((t) => t.phone) : TABS;

  return (
    <nav className={`tabnav tabnav-${variant}`} aria-label="HELM tabs">
      {tabs.map((t) => {
        const Icon = ICONS[t.id];
        const active = isActive(pathname, t.route);
        return (
          <Link
            key={t.id}
            href={t.route}
            className={`tabnav-item ${active ? "is-active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <Icon className="tabnav-icon" strokeWidth={1.75} aria-hidden="true" />
            <span className="tabnav-label">{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
