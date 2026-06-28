import type { Tool } from "./registry";

/**
 * The slice of the googleapis Calendar client this bot uses: `events.list` for
 * reading the schedule and `freebusy.query` for finding open slots. The real
 * client (`google.calendar({ version: "v3", auth })`) satisfies this shape, and
 * tests pass a fake — so the tools are exercised against mocked Calendar
 * responses without a network or real credentials.
 */
export interface CalendarApi {
  events: {
    list(params: {
      calendarId: string;
      timeMin?: string;
      timeMax?: string;
      singleEvents?: boolean;
      orderBy?: string;
      maxResults?: number;
    }): Promise<{ data: CalendarEventsListResponse }>;
  };
  freebusy: {
    query(params: {
      requestBody: { timeMin: string; timeMax: string; items: Array<{ id: string }> };
    }): Promise<{ data: FreeBusyResponse }>;
  };
}

export interface CalendarEventTime {
  dateTime?: string | null;
  date?: string | null;
}

export interface CalendarEvent {
  id?: string | null;
  summary?: string | null;
  start?: CalendarEventTime | null;
  end?: CalendarEventTime | null;
}

export interface CalendarEventsListResponse {
  items?: CalendarEvent[] | null;
}

export interface TimePeriod {
  start?: string | null;
  end?: string | null;
}

export interface FreeBusyResponse {
  calendars?: { [calendarId: string]: { busy?: TimePeriod[] | null } } | null;
}

/** An event shaped for the model: enough to summarize the user's schedule. */
export interface CalendarEventSummary {
  id: string;
  title: string;
  start: string;
  end: string;
}

/** Upper bound on events returned in one range, to keep the model prompt small. */
const MAX_EVENTS = 50;

/**
 * Working-hours window for `find_free_time`, in UTC. Free time is only suggested
 * inside these hours so the bot never proposes the middle of the night. (A
 * future refinement could honour the calendar's own timezone.)
 */
const WORK_START_HOUR = 9;
const WORK_END_HOUR = 17;

/** A half-open time interval `[start, end)`, in epoch milliseconds. */
export interface Interval {
  start: number;
  end: number;
}

/**
 * Given busy intervals and a window, return the free gaps within the window that
 * are at least `durationMs` long. Busy intervals are clipped to the window,
 * overlapping/adjacent ones are merged, and gaps shorter than the requested
 * duration are dropped. Pure and timezone-free — callers pass epoch ms.
 */
export function freeSlots(
  busy: Interval[],
  windowStart: number,
  windowEnd: number,
  durationMs: number,
): Interval[] {
  const merged: Interval[] = [];
  const clipped = busy
    .map((b) => ({ start: Math.max(b.start, windowStart), end: Math.min(b.end, windowEnd) }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);
  for (const b of clipped) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else merged.push({ ...b });
  }

  const slots: Interval[] = [];
  let cursor = windowStart;
  for (const b of merged) {
    if (b.start - cursor >= durationMs) slots.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (windowEnd - cursor >= durationMs) slots.push({ start: cursor, end: windowEnd });
  return slots;
}

/** A timed event carries `dateTime`; an all-day event carries `date`. */
function whenOf(time: CalendarEventTime | null | undefined): string {
  return time?.dateTime ?? time?.date ?? "";
}

/**
 * `list_events(start, end)` — list the user's events between two RFC3339
 * timestamps, ordered by start time with recurring events expanded into their
 * individual instances. An empty range yields an empty list, which the agent
 * loop feeds back so the model can say the schedule is clear.
 */
export function listEventsTool(calendar: CalendarApi): Tool {
  return {
    definition: {
      name: "list_events",
      description:
        "List the user's calendar events between two RFC3339 timestamps (start and end). " +
        "Returns each event's id, title, start, and end.",
      parameters: {
        type: "object",
        properties: {
          start: { type: "string", description: "Range start as an RFC3339 timestamp." },
          end: { type: "string", description: "Range end as an RFC3339 timestamp." },
        },
        required: ["start", "end"],
      },
    },

    async run(args) {
      const { data } = await calendar.events.list({
        calendarId: "primary",
        timeMin: String(args.start ?? ""),
        timeMax: String(args.end ?? ""),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: MAX_EVENTS,
      });

      const events = data.items ?? [];
      return events.map<CalendarEventSummary>((e) => ({
        id: e.id ?? "",
        title: e.summary ?? "",
        start: whenOf(e.start),
        end: whenOf(e.end),
      }));
    },
  };
}

/** An open slot shaped for the model, as RFC3339 timestamps. */
export interface FreeSlot {
  start: string;
  end: string;
}

/** Format an hour as a two-digit string for building an RFC3339 timestamp. */
function utcAt(date: string, hour: number): Date {
  return new Date(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
}

/**
 * `find_free_time(date, duration)` — return the open slots on a given day (in
 * 09:00–17:00 UTC working hours) that are at least `duration` minutes long. Free
 * time is computed from the calendar's free/busy blocks, so a clear day yields
 * the whole window.
 */
export function findFreeTimeTool(calendar: CalendarApi): Tool {
  return {
    definition: {
      name: "find_free_time",
      description:
        "Find open time slots of at least `duration` minutes on a given date (YYYY-MM-DD), " +
        "within 09:00–17:00 UTC working hours. Returns each slot's start and end.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "The day to check, as YYYY-MM-DD." },
          duration: { type: "number", description: "Minimum slot length in minutes." },
        },
        required: ["date", "duration"],
      },
    },

    async run(args) {
      const date = String(args.date ?? "");
      const durationMs = Number(args.duration ?? 0) * 60_000;
      const windowStart = utcAt(date, WORK_START_HOUR);
      const windowEnd = utcAt(date, WORK_END_HOUR);

      const { data } = await calendar.freebusy.query({
        requestBody: {
          timeMin: windowStart.toISOString(),
          timeMax: windowEnd.toISOString(),
          items: [{ id: "primary" }],
        },
      });

      const busy = (data.calendars?.primary?.busy ?? []).map<Interval>((b) => ({
        start: Date.parse(b.start ?? ""),
        end: Date.parse(b.end ?? ""),
      }));

      const slots = freeSlots(busy, windowStart.getTime(), windowEnd.getTime(), durationMs);
      return slots.map<FreeSlot>((s) => ({
        start: new Date(s.start).toISOString(),
        end: new Date(s.end).toISOString(),
      }));
    },
  };
}
