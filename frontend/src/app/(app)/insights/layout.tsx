"use client";

import { usePathname } from "next/navigation";

import { useQuery } from "@tanstack/react-query";

import { Skeleton } from "@/components/ui/skeleton";
import { api, type AuthStatus } from "@/lib/api";

const ADMIN_REPORT_PREFIXES = [
  "/insights/finance",
  "/insights/sales-planning",
  "/insights/economics",
  "/insights/profitability",
  "/insights/bottling",
];

function isAdminReportPath(pathname: string) {
  return ADMIN_REPORT_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Insights chrome: the admin gate for the finance and planning reports. The
 * section strip that used to sit here is gone — the sidebar lists the
 * Insights pages on desktop and `PageHeader` carries them on phones.
 */
export default function ReportsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  // /auth/status is already in the cache from the app shell and carries the
  // admin flag, so gating here costs no extra request (SEAM-019).
  const profile = useQuery({
    queryKey: ["auth", "status"],
    queryFn: () => api.get<AuthStatus>("/auth/status"),
    staleTime: 60_000,
  });
  const needsAdmin = isAdminReportPath(pathname);
  const blocked =
    needsAdmin && profile.isSuccess && profile.data?.isAdmin !== true;

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-6">
      {needsAdmin && profile.isPending ? (
        <Skeleton className="h-72 w-full" />
      ) : blocked ? (
        <p className="text-sm text-muted-foreground">
          Administrator access required
        </p>
      ) : (
        children
      )}
    </div>
  );
}
