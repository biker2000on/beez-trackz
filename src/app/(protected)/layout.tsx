import { Sidebar } from "@/components/nav/sidebar";
import { ShortcutProvider } from "@/components/keyboard/shortcut-provider";
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
    <ShortcutProvider>
    <div className="min-h-screen">
      <Sidebar />
      <main className="md:pl-64 pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
        <OfflineBanner />
        {children}
      </main>
      <BottomNav />
      <SyncIndicator />
      <InstallPrompt />
      <AutoSyncInit />
    </div>
    </ShortcutProvider>
  );
}
