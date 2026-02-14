import { redirect } from "next/navigation";
import { isSetupComplete, getDisplayName } from "@/actions/auth";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const setupComplete = await isSetupComplete();
  if (!setupComplete) {
    redirect("/setup");
  }

  const displayName = await getDisplayName();

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <LoginForm displayName={displayName} />
    </div>
  );
}
