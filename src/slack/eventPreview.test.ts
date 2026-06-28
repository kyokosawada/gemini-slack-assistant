import { describe, it, expect } from "bun:test";
import { buildEventPreview } from "./eventPreview";
import { CONFIRM_ACTION_ID, CANCEL_ACTION_ID } from "./sendPreview";
import type { EventDraft } from "../calendar/booker";

const draft: EventDraft = {
  kind: "event",
  title: "Intro call",
  start: "2026-07-02T14:00:00Z",
  durationMin: 30,
  attendees: ["jane@acme.com"],
};

describe("buildEventPreview", () => {
  it("shows the event title, time, duration, and attendees with Confirm/Cancel buttons carrying the key", () => {
    const blocks = buildEventPreview("pending-2", draft);
    const json = JSON.stringify(blocks);

    // The whole proposal is visible before anything is booked.
    expect(json).toContain("Intro call");
    expect(json).toContain("2026-07-02T14:00:00Z");
    expect(json).toContain("30");
    expect(json).toContain("jane@acme.com");

    const actions = blocks.find((b) => b.type === "actions");
    expect(actions).toBeDefined();
    const elements = (actions as { elements: any[] }).elements;

    const confirm = elements.find((e) => e.action_id === CONFIRM_ACTION_ID);
    const cancel = elements.find((e) => e.action_id === CANCEL_ACTION_ID);

    // Same buttons/action_ids as the send preview, so one handler resolves both.
    expect(confirm.value).toBe("pending-2");
    expect(cancel.value).toBe("pending-2");
    expect(confirm.text.text).toMatch(/confirm/i);
    expect(cancel.text.text).toMatch(/cancel/i);
  });

  it("renders an event with no attendees without a blank field", () => {
    const blocks = buildEventPreview("pending-3", { ...draft, attendees: [] });
    const json = JSON.stringify(blocks);

    expect(json).toContain("Intro call");
    expect(json.toLowerCase()).toContain("none");
  });
});
