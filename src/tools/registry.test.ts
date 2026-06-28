import { describe, it, expect } from "bun:test";
import { createToolRegistry, type Tool } from "./registry";
import type { ToolDefinition } from "../model/provider";

function fakeTool(name: string, run: Tool["run"]): Tool {
  const definition: ToolDefinition = {
    name,
    description: `the ${name} tool`,
    parameters: { type: "object", properties: {} },
  };
  return { definition, run };
}

describe("createToolRegistry", () => {
  it("advertises every tool's definition to the model", () => {
    const a = fakeTool("search_emails", async () => []);
    const b = fakeTool("read_email", async () => ({}));

    const registry = createToolRegistry([a, b]);

    expect(registry.definitions).toEqual([a.definition, b.definition]);
  });

  it("dispatches a call to the matching tool and returns its value", async () => {
    const seen: Record<string, unknown>[] = [];
    const search = fakeTool("search_emails", async (args) => {
      seen.push(args);
      return [{ id: "m1" }];
    });
    const registry = createToolRegistry([search, fakeTool("read_email", async () => null)]);

    const outcome = await registry.execute({ name: "search_emails", args: { query: "leads" } });

    expect(outcome).toEqual({ ok: true, value: [{ id: "m1" }] });
    expect(seen).toEqual([{ query: "leads" }]); // the model's args reached the tool
  });

  it("fails clearly when the model names a tool that isn't registered", async () => {
    const registry = createToolRegistry([fakeTool("search_emails", async () => [])]);

    const outcome = await registry.execute({ name: "delete_everything", args: {} });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("delete_everything");
  });

  it("captures a tool that throws as a failure carrying the cause", async () => {
    const boom = fakeTool("search_emails", async () => {
      throw new Error("Gmail API 401: invalid_grant");
    });
    const registry = createToolRegistry([boom]);

    const outcome = await registry.execute({ name: "search_emails", args: {} });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("invalid_grant");
  });
});
