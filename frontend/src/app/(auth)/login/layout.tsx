import type { Metadata } from "next";

// The page is a client component, so its title lives on this layout.
export const metadata: Metadata = { title: "Sign in" };

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
