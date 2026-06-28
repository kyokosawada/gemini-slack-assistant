import { describe, it, expect } from "bun:test";
import { createEventBooker } from "./booker";
import type { CalendarApi, CalendarEventInput } from "../tools/calendar";

/** A fake Calendar client that records the events it was asked to insert. */
function fakeCalendar(opts: { fail?: string } = {}): CalendarApi & {
  inserted: Array<{ calendarId: string; requestBody: CalendarEventInput }>;
} {
  const inserted: Array<{ calendarId: string; requestBody: CalendarEventInput }> = [];
  return {
    inserted,
    events: {
      list: async () => ({ data: {} }),
      insert: async (params) => {
        if (opts.fail) throw new Error(opts.fail);
        inserted.push(params);
        return { data: { id: "evt-1", ...params.requestBody } };
      },
    },
    freebusy: { query: async () => ({ data: {} }) },
  };
}

describe("createEventBooker", () => {
  it("inserts an event with the end derived from the duration and named attendees on the invite", async () => {
    const calendar = fakeCalendar();
    const booker = createEventBooker(calendar);

    await booker.book({
      kind: "event",
      title: "Intro call",
      start: "2026-07-02T14:00:00Z",
      durationMin: 30,
      attendees: ["jane@acme.com"],
    });

    expect(calendar.inserted).toHaveLength(1);
    expect(calendar.inserted[0]).toEqual({
      calendarId: "primary",
      requestBody: {
        summary: "Intro call",
        start: { dateTime: "2026-07-02T14:00:00Z" },
        end: { dateTime: "2026-07-02T14:30:00.000Z" }, // start + 30 minutes
        attendees: [{ email: "jane@acme.com" }],
      },
    });
  });

  it("books a solo event with no attendees on the invite", async () => {
    const calendar = fakeCalendar();
    const booker = createEventBooker(calendar);

    await booker.book({
      kind: "event",
      title: "Focus block",
      start: "2026-07-02T09:00:00Z",
      durationMin: 60,
      attendees: [],
    });

    expect(calendar.inserted[0]!.requestBody).toMatchObject({
      summary: "Focus block",
      end: { dateTime: "2026-07-02T10:00:00.000Z" },
      attendees: [],
    });
  });

  it("surfaces a clear error when the Calendar API rejects the insert", async () => {
    const calendar = fakeCalendar({ fail: "invalid_grant: token expired" });
    const booker = createEventBooker(calendar);

    await expect(
      booker.book({
        kind: "event",
        title: "Sync",
        start: "2026-07-02T14:00:00Z",
        durationMin: 30,
        attendees: [],
      }),
    ).rejects.toThrow(/failed to create event.*invalid_grant/i);
  });
});
