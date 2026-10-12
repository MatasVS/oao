import assert from "node:assert/strict";
import test from "node:test";
import type { FlueObservation } from "@flue/runtime";
import { runtimeTesting } from "../src/index.js";

function turn(
  submissionId: string | undefined,
  content: readonly Record<string, unknown>[],
  overrides: { readonly purpose?: string; readonly isError?: boolean } = {},
): FlueObservation {
  return {
    v: 3,
    eventIndex: 0,
    timestamp: "2026-10-11T12:00:00.000Z",
    type: "turn",
    turnId: `turn-${Math.random()}`,
    purpose: overrides.purpose ?? "agent",
    durationMs: 1,
    request: {},
    response: { output: { role: "assistant", content } },
    isError: overrides.isError ?? false,
    ...(submissionId ? { submissionId } : {}),
  } as unknown as FlueObservation;
}

const call = (id: string) => ({ type: "toolCall", id, name: "update_rule" });

test("a gated call claims the run's uncommitted text, joined like the reply", async () => {
  const pending = runtimeTesting.createPendingAssistantText();
  pending.observe(
    turn("submission-1", [
      { type: "text", text: "Let me read the rule." },
      { type: "toolCall", id: "call-read", name: "get_rules" },
    ]),
  );
  pending.observe(
    turn("submission-1", [
      { type: "thinking", thinking: "private scratch" },
      { type: "text", text: "Now: EUR → After: CHF for Example Corp." },
      call("call-update"),
    ]),
  );

  const claim = await pending.take("call-update");
  assert.equal(
    claim?.text,
    "Let me read the rule.\n\nNow: EUR → After: CHF for Example Corp.",
  );
  claim?.settle(true);
  assert.equal(await pending.take("call-update"), undefined);

  pending.observe(
    turn("submission-1", [
      { type: "text", text: "Second change." },
      call("call-second"),
    ]),
  );
  assert.equal((await pending.take("call-second"))?.text, "Second change.");
});

test("parallel gates from one turn never claim the same text twice", async () => {
  const pending = runtimeTesting.createPendingAssistantText();
  pending.observe(
    turn("submission-2", [
      { type: "text", text: "Two changes follow." },
      call("gate-a"),
      call("gate-b"),
    ]),
  );
  const claimed = await Promise.all([
    pending.take("gate-a"),
    pending.take("gate-b"),
  ]);
  assert.deepEqual(
    claimed.map((claim) => claim?.text),
    ["Two changes follow.", undefined],
  );
});

test("text from a publication that rolled back stays available", async () => {
  const pending = runtimeTesting.createPendingAssistantText();
  pending.observe(
    turn("submission-3", [{ type: "text", text: "First." }, call("failed")]),
  );
  const failed = await pending.take("failed");
  assert.equal(failed?.text, "First.");
  failed?.settle(false);

  pending.observe(
    turn("submission-3", [{ type: "text", text: "Second." }, call("next")]),
  );
  // The next gate commits the released explanation with its own.
  assert.equal((await pending.take("next"))?.text, "First.\n\nSecond.");
});

test("an unknown publication outcome keeps the text reserved", async () => {
  const { withPendingAssistantText } = runtimeTesting;
  const gate = (flueToolCallId: string) =>
    ({ approval: "always", flueToolCallId }) as Parameters<
      typeof withPendingAssistantText
    >[1];
  const pending = runtimeTesting.createPendingAssistantText();
  const published: (string | undefined)[] = [];
  const publish = async (obligation: ReturnType<typeof gate>) => {
    published.push(obligation.pendingAssistantText);
  };

  // The publication may have saved the text, but the check could not tell.
  pending.observe(
    turn("submission-6", [{ type: "text", text: "First." }, call("unknown")]),
  );
  await withPendingAssistantText(
    { hasPendingAssistantText: () => Promise.reject(new Error("lost")) },
    gate("unknown"),
    undefined,
    publish,
    pending,
  );
  // A known rollback releases the text to the next gate.
  pending.observe(
    turn("submission-6", [{ type: "text", text: "Second." }, call("failed")]),
  );
  await assert.rejects(
    withPendingAssistantText(
      { hasPendingAssistantText: async () => false },
      gate("failed"),
      undefined,
      () => Promise.reject(new Error("rolled back")),
      pending,
    ),
    /rolled back/,
  );
  pending.observe(
    turn("submission-6", [{ type: "text", text: "Third." }, call("next")]),
  );
  await withPendingAssistantText(
    { hasPendingAssistantText: async () => true },
    gate("next"),
    undefined,
    publish,
    pending,
  );

  assert.deepEqual(published, ["First.", "Second.\n\nThird."]);
});

test("a call waits briefly for its turn observation", async () => {
  const pending = runtimeTesting.createPendingAssistantText();
  const claim = pending.take("late-call");
  pending.observe(
    turn("submission-4", [
      { type: "text", text: "Explained before the gate." },
      call("late-call"),
    ]),
  );
  assert.equal((await claim)?.text, "Explained before the gate.");

  const aborted = new AbortController();
  const unknown = pending.take("never-observed", aborted.signal);
  aborted.abort();
  assert.equal(await unknown, undefined);
});

test("scratch, failed, unscoped, and settled turns contribute nothing", async () => {
  const pending = runtimeTesting.createPendingAssistantText();
  pending.observe(
    turn("submission-5", [{ type: "text", text: "summary" }, call("c1")], {
      purpose: "compaction",
    }),
  );
  pending.observe(
    turn("submission-5", [{ type: "text", text: "partial" }, call("c2")], {
      isError: true,
    }),
  );
  pending.observe(turn(undefined, [{ type: "text", text: "x" }, call("c3")]));
  pending.observe(
    turn("submission-5", [{ type: "text", text: "kept" }, call("c4")]),
  );
  pending.observe({
    v: 3,
    eventIndex: 1,
    timestamp: "2026-10-11T12:00:01.000Z",
    type: "submission_settled",
    submissionId: "submission-5",
    outcome: "completed",
  } as unknown as FlueObservation);

  const aborted = AbortSignal.abort();
  for (const id of ["c1", "c2", "c3", "c4"])
    assert.equal(await pending.take(id, aborted), undefined);
});

test("the settled reply drops text already committed ahead of gates", () => {
  const { replyAfterCommittedText } = runtimeTesting;
  const reply =
    "Let me read the rule.\n\nNow: EUR → After: CHF.\n\nThe change was not applied.";
  assert.equal(replyAfterCommittedText(reply, []), reply);
  assert.equal(
    replyAfterCommittedText(reply, [
      "Let me read the rule.\n\nNow: EUR → After: CHF.",
    ]),
    "The change was not applied.",
  );
  assert.equal(
    replyAfterCommittedText(reply, [
      "Let me read the rule.",
      "Now: EUR → After: CHF.",
    ]),
    "The change was not applied.",
  );
  assert.equal(
    replyAfterCommittedText("Only the gate text.", ["Only the gate text."]),
    "",
  );
  // An unexpected layout keeps every word instead of risking a loss.
  assert.equal(replyAfterCommittedText(reply, ["Something else."]), reply);
});
