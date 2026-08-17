"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { api, type AuthStatus } from "@/lib/api";
import { BottomNav } from "@/components/shell/bottom-nav";
import { OfflineBanner } from "@/components/shell/offline-banner";
import { Sidebar } from "@/components/shell/sidebar";
import { ShortcutsProvider } from "@/components/shortcuts/provider";
import { LogoMark } from "@/components/logo";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();

  const status = useQuery({
    queryKey: ["auth", "status"],
    queryFn: () => api.get<AuthStatus>("/auth/status"),
    staleTime: 60_000,
  });

  const unauthenticated =
    status.isSuccess && !status.data.authenticated;

  React.useEffect(() => {
    if (unauthenticated) router.replace("/login");
  }, [unauthenticated, router]);

  // Session check pending or failed-and-redirecting: show a quiet splash so
  // protected content never flashes for signed-out visitors.
  if (!status.isSuccess || unauthenticated) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <LogoMark className="size-12 animate-pulse" />
        {status.isError && (
          <p className="text-sm text-muted-foreground">
            Could not reach the server.{" "}
            <button
              type="button"
              className="font-medium text-primary underline-offset-4 hover:underline"
              onClick={() => status.refetch()}
            >
              Retry
            </button>
          </p>
        )}
      </div>
    );
  }

  return (
    <ShortcutsProvider>
      <div className="flex min-h-dvh flex-1 flex-col pt-[var(--safe-top)]">
        <React.Suspense fallback={null}>
          <Sidebar />
        </React.Suspense>
        <div className="flex flex-1 flex-col lg:pl-60">
          <OfflineBanner />
          <main className="flex-1 px-4 py-6 pb-24 lg:px-8 lg:pb-8">
            {children}
          </main>
        </div>
        <React.Suspense fallback={null}>
          <BottomNav />
        </React.Suspense>
      </div>
    </ShortcutsProvider>
  );
}
