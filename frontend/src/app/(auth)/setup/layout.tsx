import type { Metadata } from "next";

// The page is a client component, so its title lives on this layout.
export const metadata: Metadata = { title: "Set up your account" };

export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
