import nodemailer from "nodemailer";

/** A ready-to-send email. */
export interface EmailDraft {
  to: string;
  subject: string;
  body: string;
}

/** Sends a drafted email. The single irreversible Gmail action (see PRD). */
export interface EmailSender {
  send(draft: EmailDraft): Promise<void>;
}

/**
 * The bit of nodemailer we actually use. Both the real Gmail SMTP transport
 * and the test fake satisfy this, so {@link createEmailSender} can be driven
 * without touching the network.
 */
export interface MailTransport {
  sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<unknown>;
}

/**
 * Build an {@link EmailSender} backed by Gmail SMTP — reuses bot #1's proven
 * `nodemailer` + app-password path, so mail goes out from your own address with
 * no OAuth send scope. Pass a `transport` to send through a fake in tests.
 */
export function createEmailSender(opts: {
  user: string;
  appPassword: string;
  transport?: MailTransport;
}): EmailSender {
  const transport = opts.transport ?? defaultTransport(opts.user, opts.appPassword);

  return {
    async send(draft) {
      try {
        await transport.sendMail({
          from: opts.user,
          to: draft.to,
          subject: draft.subject,
          text: draft.body,
        });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`Failed to send email: ${reason}`, { cause });
      }
    },
  };
}

/** The real Gmail SMTP transport (untested glue, like the Gemini provider). */
function defaultTransport(user: string, appPassword: string): MailTransport {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass: appPassword },
  });
}
