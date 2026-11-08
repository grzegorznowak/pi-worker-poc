import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { RpcPeer, type Message } from "../.pi/extensions/worker-poc/rpc.ts";

type API = Record<string, { params: unknown; result: unknown }>;
type Handlers<T extends API> = {
  [K in keyof T]: (params: T[K]["params"]) => T[K]["result"] | Promise<T[K]["result"]>;
};
type EchoAPI = { echo: { params: string; result: string } };
const channel = "pi-worker-poc/1";
const timeout = 500;
const options = { timeout: 2_000 };

function pair<Host extends API, Worker extends API>(
  t: TestContext, hostHandlers: Handlers<Host>, workerHandlers: Handlers<Worker>,
) {
  const fromHost: Message[] = [];
  const fromWorker: Message[] = [];
  let host: RpcPeer<Worker, Host>;
  let worker: RpcPeer<Host, Worker>;
  host = new RpcPeer((message) => {
    fromHost.push(message);
    queueMicrotask(() => worker.receive(message));
  }, hostHandlers);
  worker = new RpcPeer((message) => {
    fromWorker.push(message);
    queueMicrotask(() => host.receive(message));
  }, workerHandlers);
  t.after(() => { host.close(); worker.close(); });
  return { host, worker, fromHost, fromWorker };
}

test("worker can await an asynchronous host callback while the host awaits the worker", options, async (t) => {
  type Host = { context: { params: string; result: string } };
  type Worker = { run: { params: string; result: string } };
  const events: string[] = [];
  let hostSettled = false;
  const { host, worker } = pair<Host, Worker>(t, {
    context: async (input) => {
      events.push("host callback started");
      await Promise.resolve();
      assert.equal(hostSettled, false);
      events.push("host callback finished");
      return `context:${input}`;
    },
  }, {
    run: async (input): Promise<string> => {
      events.push("worker started");
      const context = await worker.call("context", input, timeout);
      events.push("worker finished");
      return `result:${context}`;
    },
  });

  const result = await host.call("run", "nested", timeout).finally(() => { hostSettled = true; });
  assert.equal(result, "result:context:nested");
  assert.equal(hostSettled, true);
  assert.deepEqual(events, [
    "worker started", "host callback started", "host callback finished", "worker finished",
  ]);
});

test("simultaneous directions keep overlapping request IDs and out-of-order replies separate", options, async (t) => {
  function echo(prefix: string) {
    return async (input: string) => {
      if (input === "first") {
        await Promise.resolve();
        await Promise.resolve();
      }
      return `${prefix}:${input}`;
    };
  }
  const { host, worker, fromHost, fromWorker } = pair<EchoAPI, EchoAPI>(t,
    { echo: echo("host") }, { echo: echo("worker") });

  const results = await Promise.all([
    host.call("echo", "first", timeout),
    worker.call("echo", "first", timeout),
    host.call("echo", "second", timeout),
    worker.call("echo", "second", timeout),
  ]);
  assert.deepEqual(results, ["worker:first", "host:first", "worker:second", "host:second"]);
  for (const messages of [fromHost, fromWorker]) {
    assert.deepEqual(messages.filter((m) => m.kind === "request").map((m) => m.id), ["1", "2"]);
    assert.deepEqual(messages.filter((m) => m.kind === "response").map((m) => m.id), ["2", "1"]);
  }
});

test("remote throws reject the caller without closing the connection", options, async (t) => {
  type Worker = {
    fail: { params: "error" | "string"; result: never };
    echo: EchoAPI["echo"];
  };
  const cause = new TypeError("worker failed");
  const { host } = pair<{}, Worker>(t, {}, {
    fail: (kind) => { throw kind === "error" ? cause : "plain failure"; },
    echo: (input) => input,
  });

  await assert.rejects(host.call("fail", "error", timeout), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "worker failed");
    assert.notEqual(error, cause);
    return true;
  });
  await assert.rejects(host.call("fail", "string", timeout), { message: "plain failure" });
  assert.equal(await host.call("echo", "still connected", timeout), "still connected");
});

test("unknown and inherited methods receive explicit error replies", options, async (t) => {
  const replies: Message[] = [];
  const peer = new RpcPeer<{}, {}>((message) => { replies.push(message); }, {});
  t.after(() => peer.close());

  for (const method of ["missing", "toString"]) {
    peer.receive({ channel, kind: "request", id: method, method, params: null });
  }
  await Promise.resolve();
  assert.deepEqual(replies, ["missing", "toString"].map((method) => ({
    channel, kind: "response", id: method, ok: false, error: `Unknown RPC method: ${method}`,
  })));
});

test("a deadline rejects the call and late replies cannot settle a newer call", options, async (t) => {
  const sent: Message[] = [];
  const peer = new RpcPeer<EchoAPI, {}>((message) => { sent.push(message); }, {});
  t.after(() => peer.close());

  await assert.rejects(peer.call("echo", "expired", 20), { message: "RPC timeout: echo after 20ms" });
  let settled = false;
  const current = peer.call("echo", "current", timeout).then(
    (value) => { settled = true; return { value }; },
    (error: unknown) => { settled = true; return { error }; },
  );
  const [expiredRequest, currentRequest] = sent;
  assert.notEqual(expiredRequest.id, currentRequest.id);
  assert.doesNotThrow(() => {
    peer.receive({ channel, kind: "response", id: expiredRequest.id, ok: true, result: "too late" });
    peer.receive({ channel, kind: "response", id: expiredRequest.id, ok: false, error: "also too late" });
  });
  await Promise.resolve();
  assert.equal(settled, false);
  peer.receive({ channel, kind: "response", id: currentRequest.id, ok: true, result: "fresh" });
  assert.deepEqual(await current, { value: "fresh" });
});

test("close rejects all outstanding and subsequent calls with the first close reason", options, async (t) => {
  const sent: Message[] = [];
  const peer = new RpcPeer<EchoAPI, {}>((message) => { sent.push(message); }, {});
  t.after(() => peer.close());
  const reason = new Error("connection closed");
  const first = assert.rejects(peer.call("echo", "first", timeout), (error) => error === reason);
  const second = assert.rejects(peer.call("echo", "second", timeout), (error) => error === reason);

  peer.close(reason);
  peer.close(new Error("must not replace the first reason"));
  await Promise.all([first, second]);
  await assert.rejects(peer.call("echo", "after close", timeout), (error) => error === reason);
  peer.receive({ channel, kind: "request", id: "incoming", method: "missing", params: null });
  assert.equal(sent.length, 2);
});

for (const failure of [new Error("transport failed"), "transport failed"]) {
  test(`synchronous transport failure closes pending calls (${typeof failure})`, options, async (t) => {
    let sends = 0;
    const peer = new RpcPeer<EchoAPI, {}>(() => {
      if (++sends === 2) throw failure;
    }, {});
    t.after(() => peer.close());
    const matchesFailure = (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "transport failed");
      if (failure instanceof Error) assert.equal(error, failure);
      return true;
    };
    const first = assert.rejects(peer.call("echo", "outstanding", timeout), matchesFailure);
    const second = assert.rejects(peer.call("echo", "send fails", timeout), matchesFailure);

    await Promise.all([first, second]);
    await assert.rejects(peer.call("echo", "closed", timeout), matchesFailure);
    assert.equal(sends, 2);
  });
}

test("malformed envelopes are ignored without dispatching or settling a pending call", options, async (t) => {
  const sent: Message[] = [];
  let handled = 0;
  const peer = new RpcPeer<EchoAPI, EchoAPI>((message) => { sent.push(message); }, {
    echo: (input) => { handled++; return input; },
  });
  t.after(() => peer.close());
  let settled = false;
  const result = peer.call("echo", "pending", timeout).then(
    (value) => { settled = true; return { value }; },
    (error: unknown) => { settled = true; return { error }; },
  );
  const id = sent[0].id;
  const malformed: unknown[] = [
    undefined, null, false, 1, "message", [], {},
    { channel: "other-channel", kind: "request", id, method: "echo", params: "ignored" },
    { channel: "other-channel", kind: "response", id, ok: true, result: "ignored" },
    { kind: "response", id, ok: true, result: "ignored" },
    { channel, kind: "response", id: 1, ok: true, result: "ignored" },
    { channel, kind: "request", id, method: null },
    { channel, kind: "request", id },
    { channel, kind: "response", id, ok: "true", result: "ignored" },
    { channel, kind: "response", id, ok: false, error: 123 },
    { channel, kind: "response", id },
    { channel, kind: "other", id, method: "echo", ok: true },
  ];
  for (const message of malformed) assert.doesNotThrow(() => peer.receive(message));
  await Promise.resolve();
  assert.equal(handled, 0);
  assert.equal(sent.length, 1);
  assert.equal(settled, false);

  peer.receive({ channel, kind: "response", id, ok: true, result: "valid" });
  assert.deepEqual(await result, { value: "valid" });
});
