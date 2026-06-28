import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createOAuthClient, GOOGLE_SCOPES } from "./auth";

/**
 * One-time (≈weekly in Testing mode) consent flow that mints `token.json`.
 *
 * Run with `bun run authorize`: it prints a Google consent URL and starts a
 * tiny loopback server. After you approve, Google redirects the browser to that
 * server, which captures the authorization code automatically — no copy/paste,
 * and on a high port so it never collides with anything on :80 (e.g. Apache).
 */
const PORT = 53682; // arbitrary high loopback port; Google ignores the port for loopback redirects
const REDIRECT_URI = `http://localhost:${PORT}`;

const client = createOAuthClient();

const authUrl = client.generateAuthUrl({
  access_type: "offline", // request a refresh token
  prompt: "select_account consent", // show the account chooser, then consent
  scope: GOOGLE_SCOPES,
  redirect_uri: REDIRECT_URI,
});

console.log("\n1. Open this URL and approve (Gmail + Calendar), as your test-user account:\n");
console.log("   " + authUrl + "\n");
console.log(`2. Waiting for the approval to land on ${REDIRECT_URI} …\n`);

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", REDIRECT_URI);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (!code && !error) {
      res.end("Waiting for authorization…"); // ignore stray requests (e.g. favicon)
      return;
    }
    res.end(
      error
        ? `Authorization failed: ${error}. You can close this tab.`
        : "✅ Authorized — you can close this tab and return to the terminal.",
    );
    server.close();
    if (error) reject(new Error(error));
    else resolve(code!);
  });
  server.on("error", reject);
  server.listen(PORT);
});

const { tokens } = await client.getToken({ code, redirect_uri: REDIRECT_URI });
writeFileSync("token.json", JSON.stringify(tokens, null, 2));
console.log("✅ Saved token.json — Gmail + Calendar access granted. You can run `bun start`.");
process.exit(0);
