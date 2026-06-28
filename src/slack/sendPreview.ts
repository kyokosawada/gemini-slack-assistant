import type { KnownBlock } from "@slack/types";
import type { EmailDraft } from "../email/sender";

/**
 * Block Kit rendering for the gated send (see PRD). The bot posts this preview
 * instead of sending; the buttons carry the confirmation key so the click
 * resolves back to the parked draft. Same Approve/Deny button pattern proven in
 * bot #1.
 */

/** `action_id`s the Slack handler matches on. Stable — buttons reference them. */
export const CONFIRM_ACTION_ID = "confirm_send";
export const CANCEL_ACTION_ID = "cancel_send";

export function buildSendPreview(key: string, draft: EmailDraft): KnownBlock[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "*Draft email* — review before sending:" },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*To:*\n${draft.to}` },
        { type: "mrkdwn", text: `*Subject:*\n${draft.subject}` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: draft.body },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: CONFIRM_ACTION_ID,
          style: "primary",
          text: { type: "plain_text", text: "Send" },
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
