import { describe, it, expect } from "bun:test";
import { handleIncomingMessage } from "./messageHandler";

describe("handleIncomingMessage", () => {
  it("replies by echoing the user's text", async () => {
    const said: string[] = [];
    const say = async (text: string) => {
      said.push(text);
    };

    await handleIncomingMessage({ text: "hello there" }, say);

    expect(said).toEqual(["got it: hello there"]);
  });

  it("strips a leading bot mention before echoing (app_mention text)", async () => {
    const said: string[] = [];
    const say = async (text: string) => {
      said.push(text);
    };

    await handleIncomingMessage({ text: "<@U07ABC123> book a meeting" }, say);

    expect(said).toEqual(["got it: book a meeting"]);
  });

  it("delegates reply generation to an injected responder (agent-loop seam)", async () => {
    const said: string[] = [];
    const say = async (text: string) => {
      said.push(text);
    };
    const seen: string[] = [];
    const respond = async (text: string) => {
      seen.push(text);
      return `LOOP:${text}`;
    };

    await handleIncomingMessage({ text: "<@U1> hi" }, say, respond);

    expect(seen).toEqual(["hi"]); // responder receives normalized text
    expect(said).toEqual(["LOOP:hi"]); // say posts the responder's output
  });

  it("nudges instead of echoing an empty body when the message has no text", async () => {
    const said: string[] = [];
    const say = async (text: string) => {
      said.push(text);
    };

    await handleIncomingMessage({ text: "<@U07ABC123>" }, say);

    expect(said).toEqual(["got it — what can I help you with?"]);
  });
});
