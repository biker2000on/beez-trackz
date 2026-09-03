"use client";

import type { ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { useAccessProfile } from "@/features/access/api";

/**
 * The Admin area's client-side gate.
 *
 * Enforcement is and stays server-side (`requireAdmin`,
 * `backend/internal/httpapi/middleware.go`) — every read behind this gate is
 * admin-only there. What this adds is that a non-admin who types `/admin`
 * gets a sentence instead of a page of failed requests, and that the
 * admin-only reads are never issued at all.
 */
export function AdminGate({ children }: { children: ReactNode }) {
  const profile = useAccessProfile();
  if (profile.isPending) return <Skeleton className="h-72 w-full" />;
  if (profile.data?.isAdmin !== true) {
    return (
      <p className="text-sm text-muted-foreground">
        Administrator access required
      </p>
    );
  }
  return children;
}
