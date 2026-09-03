"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserRound } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * `/me` is deliberately not one of the seven areas (design 2026-09-03 §2.1):
 * it is the per-user surface, so it sits beside Log out rather than in the
 * nav tree. It still needs one entry point, or the route exists and nothing
 * reaches it.
 */
export function AccountLink({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = pathname === "/me";
  return (
    <Link
      href="/me"
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-3 rounded-md px-4 py-2 text-sm font-medium transition-colors",
        active ? "text-primary" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <UserRound className="size-4" />
      My preferences
    </Link>
  );
}
