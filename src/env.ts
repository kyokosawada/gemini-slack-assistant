/**
 * Read a required environment variable, throwing a clear error if it is unset.
 *
 * Lifted from `lead-approval-bot` (bot #1) so both bots fail loudly and
 * identically on missing configuration.
 */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}
