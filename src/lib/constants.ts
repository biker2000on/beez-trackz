let _sessionSecret: Uint8Array | null = null;

export function getSessionSecret(): Uint8Array {
  if (_sessionSecret) return _sessionSecret;
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret === "change-me-to-a-random-string") {
    throw new Error(
      "SESSION_SECRET must be set to a secure random value in .env.local"
    );
  }
  _sessionSecret = new TextEncoder().encode(secret);
  return _sessionSecret;
}
