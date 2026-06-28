import type { KnownBlock } from "@slack/types";
import type { EventDraft } from "../calendar/booker";
import { CONFIRM_ACTION_ID, CANCEL_ACTION_ID } from "./sendPreview";

/**
 * Block Kit rendering for the gated `create_event` (see PRD). Like the send
 * preview, the bot posts this instead of booking; the buttons carry the
 * confirmation key so the click resolves back to the parked proposal. Reuses
 * the send preview's Confirm/Cancel `action_id`s, so the same Slack button
 * handlers resolve both an email draft and an event proposal by their key.
 */
export function buildEventPreview(key: string, draft: EventDraft): KnownBlock[] {
  const attendees = draft.attendees.length > 0 ? draft.attendees.join(", ") : "none";
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "*Proposed event* — review before booking:" },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Title:*\n${draft.title}` },
        { type: "mrkdwn", text: `*When:*\n${draft.start}` },
        { type: "mrkdwn", text: `*Duration:*\n${draft.durationMin} min` },
        { type: "mrkdwn", text: `*Attendees:*\n${attendees}` },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: CONFIRM_ACTION_ID,
          style: "primary",
          text: { type: "plain_text", text: "Confirm" },
          value: key,
        },
        {
          type: "button",
          action_id: CANCEL_ACTION_ID,
          style: "danger",
          text: { type: "plain_text", text: "Cancel" },
          value: key,
        },
      ],
    },
  ];
}
