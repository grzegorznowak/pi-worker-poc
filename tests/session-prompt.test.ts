import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSessionPrompter } from "../.pi/extensions/worker-poc/session-prompt.ts";

const options = { timeout: 2_000 };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fake() {
  type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
  type FakeModel = { provider: string; id: string; authHeader?: boolean };
  const handlers = new Map<string, Set<Handler>>();
  const state = {
    idle: true,
    queued: false,
    sessionId: "same-session",
    model: { provider: "test", id: "model" } as FakeModel | undefined,
    auth: async (): Promise<unknown> => ({ auth: { apiKey: "fake-host-only-key" } }),
    authCalls: 0,
    aborts: 0,
    waits: 0,
    sent: [] as string[],
    onSend: (_text: string) => {},
  };
  // Incomplete objects and lifecycle messages are cast only at this fake API boundary.
  const ctx = {
    get model() { return state.model; },
    sessionManager: { getSessionId: () => state.sessionId },
    modelRegistry: {
      getProviderAuth: (provider: string) => {
        assert.equal(provider, "test");
        state.authCalls++;
        return state.auth();
      },
    },
    isIdle: () => state.idle,
    hasPendingMessages: () => state.queued,
    abort: () => { state.aborts++; },
    waitForIdle: async () => { state.waits++; },
  } as unknown as ExtensionContext;
  const pi = {
    on(name: string, handler: Handler) {
      let entries = handlers.get(name);
      if (!entries) handlers.set(name, entries = new Set());
      entries.add(handler);
      return () => { entries.delete(handler); };
    },
    sendUserMessage(text: string) {
      state.sent.push(text);
      state.onSend(text);
    },
  } as unknown as ExtensionAPI;
  const controller = new AbortController();
  const prompt = createSessionPrompter(pi);
  function emit(name: string, payload: object = {}, eventCtx = ctx) {
    for (const handler of [...(handlers.get(name) ?? [])]) {
      assert.equal(handler({ type: name, ...payload }, eventCtx), undefined, "lifecycle callbacks must be synchronous");
    }
  }
  function start() { state.idle = false; emit("agent_start"); }
  function end(messages: object[]) { emit("agent_end", { messages }); }
  function settle(aborted = false) { state.idle = true; emit("agent_settled", { aborted }); }
  function complete(text = "answer") {
    start();
    end([assistant(text)]);
    settle();
  }
  function clean() {
    assert.equal([...handlers.values()].reduce((sum, entries) => sum + entries.size, 0), 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
  return { state, ctx, controller, prompt, emit, start, end, settle, complete, clean };
}

function assistant(text: string, stopReason = "stop", errorMessage?: string) {
  return {
    role: "assistant", content: [{ type: "text", text }], stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

test("delayed startup does not resolve through waitForIdle or stale settlement", options, async () => {
  const f = fake();
  let resolved = false;
  const reply = f.prompt(f.ctx, "hello", f.controller.signal).then((value) => { resolved = true; return value; });
  await flush();
  assert.deepEqual(f.state.sent, ["hello"]);
  assert.equal(f.state.idle, true, "startup has not happened yet; waitForIdle would return too early");
  f.end([assistant("stale")]);
  f.settle();
  await flush();
  assert.equal(resolved, false);
  assert.equal(f.state.waits, 0);
  f.complete("hello back");
  assert.deepEqual(await reply, {
    sessionId: "same-session", text: "hello back", stopReason: "stop", aborted: false,
  });
  f.clean();
});

test("intermediate agent_end is not final; use the last assistant and text blocks only", options, async () => {
  const f = fake();
  let resolved = false;
  const reply = f.prompt(f.ctx, "hello", f.controller.signal).then((value) => { resolved = true; return value; });
  await flush();
  f.start();
  f.end([assistant("retry", "error", "temporary provider failure")]);
  await flush();
  assert.equal(resolved, false);
  f.start();
  f.end([
    { role: "user", content: "hello" },
    assistant("earlier assistant"),
    { role: "assistant", content: [
      { type: "thinking", thinking: "private" },
      { type: "text", text: "first" },
      { type: "toolCall", id: "call", name: "irrelevant", arguments: {} },
      { type: "text", text: "second" },
    ], stopReason: "length" },
    { role: "toolResult", content: [{ type: "text", text: "not the answer" }] },
  ]);
  await flush();
  assert.equal(resolved, false);
  f.settle();
  assert.deepEqual(await reply, {
    sessionId: "same-session", text: "first\nsecond", stopReason: "length", aborted: false,
  });
  f.clean();
});

test("reject busy, queued, missing-model and already-aborted calls before auth or send", options, async (t) => {
  for (const kind of ["busy", "queued", "model", "aborted"]) {
    await t.test(kind, async () => {
      const f = fake();
      if (kind === "busy") f.state.idle = false;
      if (kind === "queued") f.state.queued = true;
      if (kind === "model") f.state.model = undefined;
      if (kind === "aborted") f.controller.abort();
      await assert.rejects(f.prompt(f.ctx, "hello", f.controller.signal),
        kind === "model" ? /No active model/ : kind === "aborted" ? /aborted/ : /busy or has queued/);
      assert.equal(f.state.authCalls, 0);
      assert.deepEqual(f.state.sent, []);
      assert.equal(f.state.aborts, 0);
      f.clean();
    });
  }
});

test("reject missing auth, but allow an explicit authHeader:false model", options, async () => {
  const f = fake();
  f.state.auth = async () => undefined;
  await assert.rejects(f.prompt(f.ctx, "hello", f.controller.signal), /No authentication for provider "test"/);
  assert.deepEqual(f.state.sent, []);
  f.clean();
  f.state.model = { provider: "test", id: "model", authHeader: false };
  const reply = f.prompt(f.ctx, "local", f.controller.signal);
  await flush();
  f.complete("local answer");
  assert.equal((await reply).text, "local answer");
  f.clean();
});

test("auth failure cleans up and permits a later operation", options, async () => {
  const f = fake();
  f.state.auth = async () => { throw new Error("auth refresh failed"); };
  await assert.rejects(f.prompt(f.ctx, "hello", f.controller.signal), /auth refresh failed/);
  f.clean();
  f.state.auth = async () => ({ auth: {} });
  const reply = f.prompt(f.ctx, "retry", f.controller.signal);
  await flush();
  f.complete();
  assert.equal((await reply).text, "answer");
  assert.deepEqual(f.state.sent, ["retry"]);
  f.clean();
});

test("recheck busy, queue, session and model after asynchronous auth", options, async (t) => {
  for (const kind of ["busy", "queued", "session", "model"]) {
    await t.test(kind, async () => {
      const f = fake();
      const auth = deferred<unknown>();
      f.state.auth = () => auth.promise;
      const reply = f.prompt(f.ctx, "hello", f.controller.signal);
      const rejected = assert.rejects(reply, kind === "session" ? /session changed/
        : kind === "model" ? /model changed/ : /busy or has queued/);
      // An unrelated run during auth must not become our owned activity.
      f.emit("agent_start");
      if (kind === "busy") f.state.idle = false;
      if (kind === "queued") f.state.queued = true;
      if (kind === "session") f.state.sessionId = "replacement";
      if (kind === "model") f.state.model = undefined;
      auth.resolve({ auth: {} });
      await rejected;
      assert.deepEqual(f.state.sent, []);
      assert.equal(f.state.aborts, 0);
      f.clean();
    });
  }
});

test("provider failures are reply data, not transport failures", options, async () => {
  const f = fake();
  const reply = f.prompt(f.ctx, "hello", f.controller.signal);
  await flush();
  f.start();
  f.end([assistant("partial", "error", "provider unavailable")]);
  f.settle();
  assert.deepEqual(await reply, {
    sessionId: "same-session", text: "partial", stopReason: "error", aborted: false,
    errorMessage: "provider unavailable",
  });
  f.clean();
});

test("settlement and assistant abort metadata are preserved", options, async (t) => {
  for (const kind of ["settled", "assistant", "no-message"]) {
    await t.test(kind, async () => {
      const f = fake();
      const reply = f.prompt(f.ctx, "hello", f.controller.signal);
      await flush();
      f.start();
      if (kind !== "no-message") f.end([assistant("partial", kind === "assistant" ? "aborted" : "stop")]);
      f.settle(kind !== "assistant");
      assert.deepEqual(await reply, {
        sessionId: "same-session", text: kind === "no-message" ? "" : "partial",
        stopReason: kind === "settled" ? "stop" : "aborted", aborted: true,
      });
      assert.equal(f.state.aborts, 0, "host must not issue an extra abort after normal settlement");
      f.clean();
    });
  }
});

test("the default no-event deadline is 60000ms and does not abort an unstarted run", options, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fake();
  let finished = false;
  const rejected = assert.rejects(f.prompt(f.ctx, "handled input", f.controller.signal), /timed out after 60000ms/)
    .then(() => { finished = true; });
  await flush();
  t.mock.timers.tick(59_999);
  await flush();
  assert.equal(finished, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(f.state.aborts, 0);
  f.clean();
});

test("deadline bounds unresolved auth; late auth cannot send or capture another operation", options, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fake();
  const auth = deferred<unknown>();
  f.state.auth = () => auth.promise;
  const rejected = assert.rejects(f.prompt(f.ctx, "expired", f.controller.signal, 20), /timed out after 20ms/);
  t.mock.timers.tick(20);
  await rejected;
  assert.deepEqual(f.state.sent, []);
  f.clean();
  f.state.auth = async () => ({ auth: {} });
  const reply = f.prompt(f.ctx, "new operation", f.controller.signal, 20);
  await flush();
  auth.resolve({ auth: {} });
  await flush();
  assert.deepEqual(f.state.sent, ["new operation"]);
  f.complete();
  assert.equal((await reply).text, "answer");
  t.mock.timers.tick(100);
  assert.equal(f.state.aborts, 0, "completed operation's deadline was cleared");
  f.clean();
});

test("timeout aborts only a started run in the same session", options, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const replaced of [false, true]) {
    const f = fake();
    const rejected = assert.rejects(f.prompt(f.ctx, "hello", f.controller.signal, 20), /timed out/);
    await flush();
    f.start();
    if (replaced) f.state.sessionId = "replacement";
    t.mock.timers.tick(20);
    await rejected;
    assert.equal(f.state.aborts, replaced ? 0 : 1);
    f.clean();
  }
});

test("AbortSignal during auth cleans up and suppresses a late send", options, async () => {
  const f = fake();
  const auth = deferred<unknown>();
  f.state.auth = () => auth.promise;
  const rejected = assert.rejects(f.prompt(f.ctx, "hello", f.controller.signal), /aborted/);
  f.controller.abort();
  await rejected;
  assert.equal(f.state.aborts, 0);
  f.clean();
  auth.resolve({ auth: {} });
  await flush();
  assert.deepEqual(f.state.sent, []);
  f.clean();
});

test("AbortSignal after send but before startup does not abort unrelated activity", options, async () => {
  const f = fake();
  const rejected = assert.rejects(f.prompt(f.ctx, "hello", f.controller.signal), /aborted/);
  await flush();
  f.controller.abort();
  await rejected;
  assert.equal(f.state.aborts, 0);
  f.clean();
  // Public sendUserMessage cannot retract a prompt still in input/auth preparation.
  f.complete("late unowned answer");
  assert.equal(f.state.aborts, 0);
});

test("AbortSignal aborts owned activity once and removes every listener and timer", options, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fake();
  const rejected = assert.rejects(f.prompt(f.ctx, "hello", f.controller.signal, 20), /aborted/);
  await flush();
  f.start();
  f.controller.abort();
  await rejected;
  f.clean();
  f.end([assistant("late")]);
  f.settle();
  t.mock.timers.tick(100);
  assert.equal(f.state.aborts, 1);
});

test("only one operation is in flight per factory; settle permits recovery", options, async () => {
  const f = fake();
  const first = f.prompt(f.ctx, "first", f.controller.signal);
  await assert.rejects(f.prompt(f.ctx, "second", f.controller.signal), /already in flight/);
  await flush();
  f.complete("one");
  assert.equal((await first).text, "one");
  f.clean();
  const next = f.prompt(f.ctx, "next", f.controller.signal);
  await flush();
  f.complete("two");
  assert.equal((await next).text, "two");
  assert.deepEqual(f.state.sent, ["first", "next"]);
  f.clean();
});

test("lifecycle events from another session cannot provide the reply", options, async () => {
  const f = fake();
  const other = fake();
  other.state.sessionId = "other-session";
  let resolved = false;
  const reply = f.prompt(f.ctx, "hello", f.controller.signal).then((value) => { resolved = true; return value; });
  await flush();
  f.start();
  f.emit("agent_end", { messages: [assistant("wrong session")] }, other.ctx);
  f.emit("agent_settled", { aborted: false }, other.ctx);
  await flush();
  assert.equal(resolved, false);
  f.end([assistant("right session")]);
  f.settle();
  assert.equal((await reply).text, "right session");
  f.clean();
});

test("synchronous lifecycle from sendUserMessage is observed", options, async () => {
  const f = fake();
  f.state.onSend = () => f.complete("synchronous");
  assert.equal((await f.prompt(f.ctx, "hello", f.controller.signal)).text, "synchronous");
  f.clean();
});

test("synchronous send failure removes subscriptions and releases the gate", options, async () => {
  const f = fake();
  f.state.onSend = () => { throw new Error("stale extension runtime"); };
  await assert.rejects(f.prompt(f.ctx, "hello", f.controller.signal), /stale extension runtime/);
  f.clean();
  f.state.onSend = () => f.complete();
  assert.equal((await f.prompt(f.ctx, "retry", f.controller.signal)).text, "answer");
  f.clean();
});

test("session shutdown rejects and cleans up while auth or model work is active", options, async (t) => {
  for (const started of [false, true]) {
    await t.test(started ? "started" : "auth", async () => {
      const f = fake();
      const auth = deferred<unknown>();
      if (!started) f.state.auth = () => auth.promise;
      const rejected = assert.rejects(f.prompt(f.ctx, "hello", f.controller.signal), /Session shut down/);
      await flush();
      if (started) f.start();
      f.emit("session_shutdown", { reason: "quit" });
      await rejected;
      assert.equal(f.state.aborts, started ? 1 : 0);
      f.clean();
      auth.resolve({ auth: {} });
      await flush();
      assert.equal(f.state.sent.length, started ? 1 : 0);
    });
  }
});
