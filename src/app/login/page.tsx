import { redirect } from "next/navigation";
import { isSetupComplete, getDisplayName } from "@/actions/auth";
import { isOidcConfigured, getOidcProviderName } from "@/lib/oidc";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const setupComplete = await isSetupComplete();
  if (!setupComplete) {
    redirect("/setup");
  }

  const displayName = await getDisplayName();
  const { error } = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <LoginForm
        displayName={displayName}
        oidcProviderName={isOidcConfigured() ? getOidcProviderName() : null}
        oidcError={error ?? null}
      />
    </div>
  );
}
