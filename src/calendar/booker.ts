import type { CalendarApi, CalendarEventInput } from "../tools/calendar";

/**
 * A proposed calendar event, shaped for the confirmation preview and the
 * `events.insert` call. Carries `kind: "event"` so it can flow through the
 * confirmation gate alongside an email draft and be told apart at the Slack
 * layer (see the `Preview` union in the confirmation manager).
 */
export interface EventDraft {
  kind: "event";
  title: string;
  /** Event start as an RFC3339 timestamp. */
  start: string;
  /** Duration in minutes; the end time is derived from start + duration. */
  durationMin: number;
  /** Attendee email addresses to add to the invite. */
  attendees: string[];
}

/**
 * Creates a calendar event. The single irreversible Calendar action — gated
 * behind a confirmation exactly like {@link EmailSender}, and only ever run from
 * a parked `execute` thunk after the user clicks Confirm (see PRD).
 */
export interface EventBooker {
  book(draft: EventDraft): Promise<void>;
}

/** One minute in milliseconds — keeps the end-time math readable. */
const MINUTE = 60_000;

/**
 * Build an {@link EventBooker} backed by the Calendar API. Derives the event's
 * end from `start + durationMin`, maps each named attendee onto the invite, and
 * creates the event on the user's primary calendar. Pass a fake `calendar` in
 * tests so booking is exercised without the network or real credentials.
 */
export function createEventBooker(calendar: CalendarApi): EventBooker {
  return {
    async book(draft) {
      const end = new Date(Date.parse(draft.start) + draft.durationMin * MINUTE).toISOString();
      const requestBody: CalendarEventInput = {
        summary: draft.title,
        start: { dateTime: draft.start },
        end: { dateTime: end },
        attendees: draft.attendees.map((email) => ({ email })),
      };
      try {
        await calendar.events.insert({ calendarId: "primary", requestBody });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`Failed to create event: ${reason}`, { cause });
      }
    },
  };
}
