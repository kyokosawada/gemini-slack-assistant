import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { createOAuthClient, GMAIL_READONLY_SCOPES } from "./auth";

/**
 * One-time (well, ~weekly in Testing mode) consent flow that mints `token.json`.
 * Run with `bun run authorize`: it prints a Google consent URL, you approve as
 * the sole test user, paste the code back, and the token is cached locally.
 */
const client = createOAuthClient();

const authUrl = client.generateAuthUrl({
  access_type: "offline", // request a refresh token
  prompt: "consent",
  scope: GMAIL_READONLY_SCOPES,
});

console.log("1. Visit this URL and grant access (read-only Gmail):\n");
console.log("   " + authUrl + "\n");

const rl = createInterface({ input: process.stdin, output: process.stdout });
const code = (await rl.question("2. Paste the authorization code here: ")).trim();
rl.close();

const { tokens } = await client.getToken(code);
writeFileSync("token.json", JSON.stringify(tokens, null, 2));
console.log("\n✅ Saved token.json — Gmail read access granted.");
