import { describe, it, expect } from "bun:test";
import { buildSendPreview, CONFIRM_ACTION_ID, CANCEL_ACTION_ID } from "./sendPreview";
import type { EmailDraft } from "../email/sender";

const draft: EmailDraft = {
  to: "jane@acme.com",
  subject: "Intro call",
  body: "Hi Jane,\nThursday works.",
};

describe("buildSendPreview", () => {
  it("shows the full draft with Send/Cancel buttons carrying the key", () => {
    const blocks = buildSendPreview("pending-1", draft);
    const json = JSON.stringify(blocks);

    // The whole draft is visible to the user before anything is sent.
    expect(json).toContain("jane@acme.com");
    expect(json).toContain("Intro call");
    expect(json).toContain("Thursday works.");

    const actions = blocks.find((b) => b.type === "actions");
    expect(actions).toBeDefined();
    const elements = (actions as { elements: any[] }).elements;

    const confirm = elements.find((e) => e.action_id === CONFIRM_ACTION_ID);
    const cancel = elements.find((e) => e.action_id === CANCEL_ACTION_ID);

    // Each button carries the key so the click resolves back to this draft.
    expect(confirm.value).toBe("pending-1");
    expect(cancel.value).toBe("pending-1");
    expect(confirm.text.text).toMatch(/send/i);
    expect(cancel.text.text).toMatch(/cancel/i);
  });
});
