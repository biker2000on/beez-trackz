import { Logo } from "@/components/logo";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 px-4 py-12">
      <Logo className="scale-125" />
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
