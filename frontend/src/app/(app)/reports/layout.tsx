"use client";

import { Suspense } from "react";
import { usePathname } from "next/navigation";

import { useQuery } from "@tanstack/react-query";

import { Skeleton } from "@/components/ui/skeleton";
import { ReportsSectionNav } from "@/features/operations/reports-nav";
import { api, type AuthStatus } from "@/lib/api";

const ADMIN_REPORT_PREFIXES = [
  "/reports/finance",
  "/reports/sales-planning",
  "/reports/economics",
  "/reports/profitability",
  "/reports/expenses",
  "/reports/bottling",
  "/reports/customers",
];

function isAdminReportPath(pathname: string) {
  return ADMIN_REPORT_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** Reports chrome: the section menu that replaced two nested tab strips. */
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
      <Suspense fallback={<Skeleton className="h-11 w-full max-w-2xl" />}>
        <ReportsSectionNav />
      </Suspense>
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
