import { describe, it, expect } from "bun:test";
import {
  listEventsTool,
  findFreeTimeTool,
  freeSlots,
  type CalendarApi,
  type CalendarEventsListResponse,
  type FreeBusyResponse,
} from "./calendar";

const MIN = 60_000; // one minute in ms — keeps the free-slot math readable

/**
 * A fake standing in for the googleapis Calendar client, recording the params it
 * was called with and returning scripted responses (or throwing for errors).
 */
function fakeCalendar(handlers: {
  list?: (params: { calendarId: string; timeMin?: string; timeMax?: string }) => CalendarEventsListResponse;
  freebusy?: (body: { timeMin: string; timeMax: string; items: Array<{ id: string }> }) => FreeBusyResponse;
}): CalendarApi & {
  listCalls: any[];
  freebusyCalls: any[];
} {
  const listCalls: any[] = [];
  const freebusyCalls: any[] = [];
  return {
    listCalls,
    freebusyCalls,
    events: {
      list: async (params) => {
        listCalls.push(params);
        return { data: handlers.list?.(params) ?? {} };
      },
    },
    freebusy: {
      query: async (params) => {
        freebusyCalls.push(params.requestBody);
        return { data: handlers.freebusy?.(params.requestBody) ?? {} };
      },
    },
  };
}

describe("listEventsTool", () => {
  it("lists events in a range and shapes them for the model", async () => {
    const calendar = fakeCalendar({
      list: () => ({
        items: [
          { id: "e1", summary: "Standup", start: { dateTime: "2026-06-25T09:00:00Z" }, end: { dateTime: "2026-06-25T09:15:00Z" } },
          { id: "e2", summary: "All-day offsite", start: { date: "2026-06-26" }, end: { date: "2026-06-27" } },
        ],
      }),
    });

    const tool = listEventsTool(calendar);
    const result = await tool.run({ start: "2026-06-25T00:00:00Z", end: "2026-06-27T00:00:00Z" });

    // request shaping: single-events, time-ordered, scoped to the primary calendar
    expect(calendar.listCalls).toEqual([
      {
        calendarId: "primary",
        timeMin: "2026-06-25T00:00:00Z",
        timeMax: "2026-06-27T00:00:00Z",
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 50,
      },
    ]);
    // result parsing: timed events use dateTime, all-day events fall back to date
    expect(result).toEqual([
      { id: "e1", title: "Standup", start: "2026-06-25T09:00:00Z", end: "2026-06-25T09:15:00Z" },
      { id: "e2", title: "All-day offsite", start: "2026-06-26", end: "2026-06-27" },
    ]);
  });

  it("returns an empty list when the range has no events", async () => {
    const calendar = fakeCalendar({ list: () => ({}) }); // Calendar omits `items` when empty

    const tool = listEventsTool(calendar);
    const result = await tool.run({ start: "2026-06-25T00:00:00Z", end: "2026-06-26T00:00:00Z" });

    expect(result).toEqual([]);
  });

  it("propagates a Calendar API error (e.g. expired auth) instead of swallowing it", async () => {
    const calendar = fakeCalendar({
      list: () => {
        throw new Error("invalid_grant: token expired");
      },
    });

    const tool = listEventsTool(calendar);

    expect(tool.run({ start: "a", end: "b" })).rejects.toThrow("invalid_grant");
  });
});

describe("freeSlots", () => {
  it("returns the whole window when nothing is busy", () => {
    const slots = freeSlots([], 0, 480 * MIN, 30 * MIN);

    expect(slots).toEqual([{ start: 0, end: 480 * MIN }]);
  });

  it("splits the window around a meeting", () => {
    const slots = freeSlots([{ start: 120 * MIN, end: 180 * MIN }], 0, 480 * MIN, 30 * MIN);

    expect(slots).toEqual([
      { start: 0, end: 120 * MIN },
      { start: 180 * MIN, end: 480 * MIN },
    ]);
  });

  it("drops gaps shorter than the requested duration", () => {
    // only a 20-minute tail remains, which is too short for a 30-minute slot
    const slots = freeSlots([{ start: 0, end: 460 * MIN }], 0, 480 * MIN, 30 * MIN);

    expect(slots).toEqual([]);
  });

  it("merges overlapping busy blocks and ignores busy outside the window", () => {
    const slots = freeSlots(
      [
        { start: -60 * MIN, end: 60 * MIN }, // starts before the window → clipped to [0, 60)
        { start: 30 * MIN, end: 90 * MIN }, // overlaps the first → merges to [0, 90)
        { start: 600 * MIN, end: 700 * MIN }, // entirely after the window → ignored
      ],
      0,
      480 * MIN,
      30 * MIN,
    );

    expect(slots).toEqual([{ start: 90 * MIN, end: 480 * MIN }]);
  });

  it("treats back-to-back meetings as one busy block (no zero-length gap)", () => {
    const slots = freeSlots(
      [
        { start: 60 * MIN, end: 120 * MIN },
        { start: 120 * MIN, end: 180 * MIN },
      ],
      0,
      480 * MIN,
      30 * MIN,
    );

    expect(slots).toEqual([
      { start: 0, end: 60 * MIN },
      { start: 180 * MIN, end: 480 * MIN },
    ]);
  });
});

describe("findFreeTimeTool", () => {
  it("queries free/busy for the working day and returns open slots around the busy blocks", async () => {
    const calendar = fakeCalendar({
      freebusy: () => ({
        calendars: { primary: { busy: [{ start: "2026-06-25T11:00:00Z", end: "2026-06-25T12:00:00Z" }] } },
      }),
    });

    const tool = findFreeTimeTool(calendar);
    const result = await tool.run({ date: "2026-06-25", duration: 60 });

    // request shaping: free/busy over the primary calendar's 09:00–17:00 UTC window
    expect(calendar.freebusyCalls).toEqual([
      {
        timeMin: "2026-06-25T09:00:00.000Z",
        timeMax: "2026-06-25T17:00:00.000Z",
        items: [{ id: "primary" }],
      },
    ]);
    // a 60-minute slot before the meeting and the rest of the afternoon after it
    expect(result).toEqual([
      { start: "2026-06-25T09:00:00.000Z", end: "2026-06-25T11:00:00.000Z" },
      { start: "2026-06-25T12:00:00.000Z", end: "2026-06-25T17:00:00.000Z" },
    ]);
  });

  it("returns the whole working day when the calendar is clear", async () => {
    const calendar = fakeCalendar({ freebusy: () => ({}) });

    const tool = findFreeTimeTool(calendar);
    const result = await tool.run({ date: "2026-06-25", duration: 30 });

    expect(result).toEqual([
      { start: "2026-06-25T09:00:00.000Z", end: "2026-06-25T17:00:00.000Z" },
    ]);
  });

  it("propagates a Calendar API error instead of swallowing it", async () => {
    const calendar = fakeCalendar({
      freebusy: () => {
        throw new Error("invalid_grant: token expired");
      },
    });

    const tool = findFreeTimeTool(calendar);

    expect(tool.run({ date: "2026-06-25", duration: 30 })).rejects.toThrow("invalid_grant");
  });
});
