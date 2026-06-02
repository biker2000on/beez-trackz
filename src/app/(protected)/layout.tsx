import { Sidebar } from "@/components/nav/sidebar";
import { BottomNav } from "@/components/nav/bottom-nav";
import { OfflineBanner } from "@/components/offline/offline-banner";
import { SyncIndicator } from "@/components/offline/sync-indicator";
import { InstallPrompt } from "@/components/pwa/install-prompt";
import { AutoSyncInit } from "@/components/offline/auto-sync-init";

export const dynamic = "force-dynamic";

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <Sidebar />
      <main className="md:pl-64 pb-16 md:pb-0">
        <OfflineBanner />
        {children}
      </main>
      <BottomNav />
      <SyncIndicator />
      <InstallPrompt />
      <AutoSyncInit />
    </div>
  );
}
