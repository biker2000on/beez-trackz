import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { ThemeProvider } from "@/components/theme-provider";
import { QueryProvider } from "@/lib/query";
import { Toaster } from "@/components/ui/toaster";
import { PwaRegister } from "@/components/pwa-register";
import { InstallPrompt } from "@/components/install-prompt";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BrandProvider } from "@/components/brand-provider";
import { DARK_THEME_COLOR, resolveBrand } from "@/lib/brand";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * The brand is a *runtime* value: one image serves Apiary Atlas by default and
 * GentleBee Atlas when the deployment sets BRAND_DISPLAY_NAME. Static
 * prerendering would bake whatever `BRAND_*` happened to be set during
 * `next build` — which is nothing — into the HTML, so every branded deployment
 * would ship the default name in its prerendered pages. Rendering at request
 * time is what makes "no rebuild for a new brand" true.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const brand = resolveBrand();
  return {
    title: {
      default: brand.displayName,
      template: `%s · ${brand.displayName}`,
    },
    description: brand.tagline,
    applicationName: brand.displayName,
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      // iOS shows this under the home-screen icon, where the short name fits.
      title: brand.shortName,
      statusBarStyle: "default",
    },
    formatDetection: {
      telephone: false,
    },
    icons: {
      apple: "/apple-touch-icon.png",
    },
  };
}

export async function generateViewport(): Promise<Viewport> {
  const brand = resolveBrand();
  return {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    themeColor: [
      // Only the light-mode chrome is tinted by the brand. The dark value is a
      // fixed app constant so a configured color cannot wreck the contrast of
      // the status bar against the app's dark surfaces.
      { media: "(prefers-color-scheme: light)", color: brand.themeColor },
      { media: "(prefers-color-scheme: dark)", color: DARK_THEME_COLOR },
    ],
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Resolved once, on the server, and handed to the client tree as-is: server
  // HTML and hydrated UI read the same object, so they cannot disagree.
  const brand = resolveBrand();

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <BrandProvider brand={brand}>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            <QueryProvider>
              <TooltipProvider delayDuration={300}>
              {children}
              <Toaster />
              <PwaRegister />
              <InstallPrompt />
              </TooltipProvider>
            </QueryProvider>
          </ThemeProvider>
        </BrandProvider>
      </body>
    </html>
  );
}
