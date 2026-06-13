"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "pwa-install-dismissed";

function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function detectIos(): boolean {
  if (typeof window === "undefined") return false;
  return (
    /iphone|ipad|ipod/i.test(window.navigator.userAgent) ||
    (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1)
  );
}

interface PwaInstallContextValue {
  /** Chrome/Edge captured a beforeinstallprompt event. */
  canInstall: boolean;
  /** Running as an installed standalone app. */
  isInstalled: boolean;
  isIos: boolean;
  /** The install toast has been dismissed (persisted). */
  dismissed: boolean;
  promptInstall: () => Promise<"accepted" | "dismissed" | "unavailable">;
  dismiss: () => void;
}

const PwaInstallContext = createContext<PwaInstallContextValue | null>(null);

export function PwaInstallProvider({ children }: { children: React.ReactNode }) {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIos, setIsIos] = useState(false);
  // Default dismissed=true until localStorage is read, to avoid flashing the
  // toast before we know the user's choice.
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setIsInstalled(detectStandalone());
    setIsIos(detectIos());
    setDismissed(Boolean(localStorage.getItem(DISMISS_KEY)));

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setIsInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferred) return "unavailable" as const;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    setDeferred(null);
    if (outcome === "accepted") setIsInstalled(true);
    return outcome;
  }, [deferred]);

  const dismiss = useCallback(() => {
    localStorage.setItem(DISMISS_KEY, "true");
    setDismissed(true);
  }, []);

  return (
    <PwaInstallContext.Provider
      value={{
        canInstall: Boolean(deferred),
        isInstalled,
        isIos,
        dismissed,
        promptInstall,
        dismiss,
      }}
    >
      {children}
    </PwaInstallContext.Provider>
  );
}

export function usePwaInstall(): PwaInstallContextValue {
  const ctx = useContext(PwaInstallContext);
  if (!ctx) throw new Error("usePwaInstall requires PwaInstallProvider");
  return ctx;
}
