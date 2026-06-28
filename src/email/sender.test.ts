import { describe, it, expect } from "bun:test";
import { createEmailSender } from "./sender";

interface SentMail {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
}

/** A transport that records what it was asked to send — no real SMTP. */
function fakeTransport() {
  const sent: SentMail[] = [];
  return {
    sent,
    sendMail: async (mail: SentMail) => {
      sent.push(mail);
      return { messageId: "fake-id" };
    },
  };
}

describe("createEmailSender", () => {
  it("sends the draft from the configured Gmail address", async () => {
    const transport = fakeTransport();
    const sender = createEmailSender({
      user: "me@gmail.com",
      appPassword: "app-pw",
      transport,
    });

    await sender.send({ to: "jane@acme.com", subject: "Hello", body: "Hi Jane" });

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      from: "me@gmail.com",
      to: "jane@acme.com",
      subject: "Hello",
      text: "Hi Jane",
    });
  });

  it("surfaces a clear error when the transport fails", async () => {
    const sender = createEmailSender({
      user: "me@gmail.com",
      appPassword: "app-pw",
      transport: {
        sendMail: async () => {
          throw new Error("535 auth failed");
        },
      },
    });

    await expect(
      sender.send({ to: "jane@acme.com", subject: "Hi", body: "hey" }),
    ).rejects.toThrow(/failed to send email.*535 auth failed/i);
  });
});
