import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { ThemeProvider } from "@/components/theme-provider";
import { QueryProvider } from "@/lib/query";
import { Toaster } from "@/components/ui/toaster";
import { PwaRegister } from "@/components/pwa-register";
import { InstallPrompt } from "@/components/install-prompt";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Beez Trackz",
    template: "%s · Beez Trackz",
  },
  description: "Self-hosted beekeeping tracker — apiaries, hives, queens, and honey.",
  applicationName: "Beez Trackz",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Beez Trackz",
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#d97706" },
    { media: "(prefers-color-scheme: dark)", color: "#1c1917" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <QueryProvider>
            {children}
            <Toaster position="top-right" />
            <PwaRegister />
            <InstallPrompt />
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
