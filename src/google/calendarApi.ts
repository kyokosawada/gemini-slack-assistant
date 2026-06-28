import { google } from "googleapis";
import type { CalendarApi } from "../tools/calendar";
import type { GoogleOAuthClient } from "./auth";

/**
 * Adapt the real googleapis Calendar client to the narrow {@link CalendarApi}
 * the tools depend on. Thin on purpose — the tools stay testable against a fake
 * of the same shape, and this is the only spot that touches the SDK.
 */
export function createCalendarApi(auth: GoogleOAuthClient): CalendarApi {
  const calendar = google.calendar({ version: "v3", auth });
  return {
    events: {
      list: (params) => calendar.events.list(params),
    },
    freebusy: {
      query: (params) => calendar.freebusy.query(params),
    },
  };
}
