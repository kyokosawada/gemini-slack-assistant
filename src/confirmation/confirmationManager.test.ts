import { describe, it, expect } from "bun:test";
import { createConfirmationManager, type Preview } from "./confirmationManager";

const draft: Preview = { kind: "email", to: "jane@acme.com", subject: "Hi", body: "hey" };

describe("createConfirmationManager", () => {
  it("parks a proposed action without executing it", () => {
    const manager = createConfirmationManager();
    let ran = false;

    const key = manager.propose({ preview: draft, execute: async () => void (ran = true) });

    expect(typeof key).toBe("string");
    expect(manager.pendingCount).toBe(1);
    expect(ran).toBe(false);
  });

  it("runs the action exactly once on confirm, then clears it", async () => {
    const manager = createConfirmationManager();
    let runs = 0;
    const key = manager.propose({ preview: draft, execute: async () => void runs++ });

    const first = await manager.confirm(key);

    expect(first).toEqual({ status: "executed", preview: draft });
    expect(runs).toBe(1);
    expect(manager.pendingCount).toBe(0);

    // A second confirm finds nothing and never re-runs the action.
    const second = await manager.confirm(key);
    expect(second).toEqual({ status: "not_found" });
    expect(runs).toBe(1);
  });

  it("discards a parked action on cancel without executing it", async () => {
    const manager = createConfirmationManager();
    let ran = false;
    const key = manager.propose({ preview: draft, execute: async () => void (ran = true) });

    expect(manager.cancel(key)).toBe(true);
    expect(manager.pendingCount).toBe(0);
    expect(ran).toBe(false);

    // Nothing left to confirm afterwards.
    expect(await manager.confirm(key)).toEqual({ status: "not_found" });
    expect(ran).toBe(false);
  });

  it("treats confirm/cancel of an unknown key as a safe no-op", async () => {
    const manager = createConfirmationManager();

    // e.g. a button clicked after a process restart wiped in-memory state.
    expect(await manager.confirm("stale-key")).toEqual({ status: "not_found" });
    expect(manager.cancel("stale-key")).toBe(false);
  });

  it("reports a failure and keeps the action parked for retry", async () => {
    const manager = createConfirmationManager();
    let attempts = 0;
    const key = manager.propose({
      preview: draft,
      execute: async () => {
        attempts++;
        if (attempts === 1) throw new Error("smtp down");
      },
    });

    const failed = await manager.confirm(key);
    expect(failed).toEqual({ status: "failed", preview: draft, error: "smtp down" });
    expect(manager.pendingCount).toBe(1); // still parked, so the user can retry

    const retried = await manager.confirm(key);
    expect(retried).toEqual({ status: "executed", preview: draft });
    expect(attempts).toBe(2);
    expect(manager.pendingCount).toBe(0);
  });

  it("replaces a parked draft on update, then confirms the updated one", async () => {
    const manager = createConfirmationManager();
    const sent: Preview[] = [];
    const key = manager.propose({ preview: draft, execute: async () => void sent.push(draft) });

    const shorter: Preview = { kind: "email", to: "jane@acme.com", subject: "Hi", body: "hey (shorter)" };
    const updated = manager.update(key, {
      preview: shorter,
      execute: async () => void sent.push(shorter),
    });

    expect(updated).toBe(true);
    expect(manager.pendingCount).toBe(1); // edited in place, not stacked

    const outcome = await manager.confirm(key);
    expect(outcome).toEqual({ status: "executed", preview: shorter });
    expect(sent).toEqual([shorter]); // only the edited draft went out

    // Editing a key that isn't parked reports failure rather than parking one.
    expect(manager.update("stale-key", { preview: draft, execute: async () => {} })).toBe(false);
  });
});
