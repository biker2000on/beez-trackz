import { cookies } from "next/headers";
import { verifySession } from "./session";

/**
 * Defense-in-depth session check for server actions. Middleware already
 * gates these routes; this guards against matcher regressions and direct
 * invocation. No-ops under vitest so action unit tests run without a
 * request scope.
 */
export async function requireSession(): Promise<void> {
  if (process.env.VITEST) return;
  const token = (await cookies()).get("session")?.value;
  if (!token || !(await verifySession(token))) {
    throw new Error("Unauthorized");
  }
}
