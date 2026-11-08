import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extension = resolve(project, ".pi/extensions/worker-poc/index.ts");
const fixture = resolve(project, "tests/fixtures/hello-provider.ts");
const expectedText = "Hello world from the running Pi session!";
const provider = "worker-poc-test-only";
const progressPrefix = "WORKER_POC_PROGRESS ";
const resultPrefix = "WORKER_POC_RESULT ";

// Do not inherit provider credentials, NODE_OPTIONS, or global Pi configuration.
// Generated configuration stays project-local, as in pi-integration.mjs.
const agentDir = await mkdtemp(resolve(project, ".test-agent-"));
const child = spawn("pi", [
  "--offline", "--approve", "--no-session", "--mode", "rpc",
  "--provider", provider, "--model", "hello",
  "--no-mcp", "--no-tools", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
  // Only the TEST fixture is explicit. The project extension MUST auto-discover.
  "-e", fixture,
], {
  cwd: project,
  env: {
    PATH: process.env.PATH,
    HOME: agentDir,
    PI_CODING_AGENT_DIR: agentDir,
    PI_TELEMETRY: "0",
    PI_WORKER_POC_TEST_PROVIDER: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

const records = [];
const pending = new Map();
const workerPids = new Set();
let nextId = 0;
let buffer = "";
let stderr = "";
let fatalError;
let hasClosed = false;
const fail = (error) => {
  fatalError ??= error;
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
};
child.on("error", fail);
child.stdin.on("error", fail);
const closed = new Promise((resolveClose) => child.once("close", (code, signal) => {
  hasClosed = true;
  fail(new Error(`Pi exited: ${code}/${signal}\n${stderr}`));
  resolveClose({ code, signal });
}));
child.stderr.setEncoding("utf8").on("data", (chunk) => {
  stderr = (stderr + chunk).slice(-10000);
});
// Install the output listener before any requests: a local provider can settle immediately.
child.stdout.setEncoding("utf8").on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    // Split on LF only; Unicode line separators are legal inside JSON strings.
    const line = buffer.slice(0, end).replace(/\r$/, "");
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
      if (record.type === "extension_ui_request" && record.method === "notify") {
        for (const prefix of [progressPrefix, resultPrefix]) {
          if (record.message.startsWith(prefix)) {
            const report = JSON.parse(record.message.slice(prefix.length));
            if (Number.isSafeInteger(report.workerPid) && report.workerPid > 0) workerPids.add(report.workerPid);
          }
        }
      }
    } catch (error) {
      fail(new Error(`Invalid JSONL record: ${line}`, { cause: error }));
      child.kill("SIGKILL");
      return;
    }
    records.push(record);
    if (record.type === "response" && pending.has(record.id)) {
      const request = pending.get(record.id);
      pending.delete(record.id);
      clearTimeout(request.timer);
      record.success ? request.resolve(record.data) : request.reject(new Error(record.error));
    }
  }
});

function request(type, fields = {}) {
  return new Promise((resolveRequest, reject) => {
    if (fatalError || hasClosed) {
      reject(fatalError ?? new Error("Pi is closed"));
      return;
    }
    const id = String(++nextId);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Pi ${type} deadline exceeded\n${stderr}`));
    }, 15000);
    pending.set(id, { resolve: resolveRequest, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`, (error) => {
      if (error) fail(error);
    });
  });
}

function textOf(message) {
  return typeof message.content === "string" ? message.content : message.content
    .filter((block) => block.type === "text").map((block) => block.text).join("");
}

function assertReaped(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "worker PID must be positive");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "worker must be reaped");
}

const watchdog = setTimeout(() => {
  fail(new Error("Prompt integration watchdog exceeded 40s"));
  child.kill("SIGKILL");
}, 40000);
try {
  const { commands } = await request("get_commands");
  const command = commands.find((entry) => entry.name === "worker-poc");
  assert.ok(command, "worker-poc project extension must auto-discover");
  assert.equal(command.source, "extension");
  assert.equal(command.sourceInfo.scope, "project");
  assert.equal(command.sourceInfo.path, extension);

  const before = await request("get_state");
  assert.equal(typeof before.sessionId, "string");
  assert.ok(before.sessionId.length > 0);
  assert.equal(before.model.provider, provider, "only the local TEST provider may run");
  assert.equal(before.model.id, "hello");
  assert.equal(before.isStreaming, false);
  assert.equal(before.pendingMessageCount, 0);
  const initial = await request("get_messages");
  assert.deepEqual(initial.messages.filter((message) => ["user", "assistant"].includes(message.role)), []);
  // A fixture mismatch must fail promptly instead of entering automatic retries.
  await request("set_auto_retry", { enabled: false });

  const response = await request("prompt", { message: "/worker-poc prompt" });
  assert.equal(response.disposition, "handled", "slash command handles its request while awaiting its worker");
  const notification = (prefix) => {
    const matches = records.filter((record) => record.type === "extension_ui_request" &&
      record.method === "notify" && record.message.startsWith(prefix));
    assert.equal(matches.length, 1, `expected exactly one ${prefix}notification`);
    return JSON.parse(matches[0].message.slice(prefix.length));
  };
  const progress = notification(progressPrefix);
  const report = notification(resultPrefix);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.ok(report.result?.promptReply, "/worker-poc prompt must return result.promptReply (implementation may not be ready)");
  assert.equal(report.error, undefined);
  assert.equal(report.hostPid, child.pid);
  assert.notEqual(report.workerPid, report.hostPid);
  assert.notEqual(report.workerPid, process.pid);
  assert.equal(progress.workerPid, report.workerPid);
  assert.equal(progress.sessionId, before.sessionId);
  assert.equal(typeof progress.token, "string");
  assert.ok(progress.token.length > 0);
  assert.deepEqual(report.callback, {
    hostPid: child.pid, cwd: project, sessionId: before.sessionId, token: progress.token,
  });
  assert.equal(report.result.workerPid, report.workerPid);
  assert.deepEqual(report.result.receipt, report.callback);
  assert.deepEqual(report.result.snapshot, { cwd: project, sessionId: before.sessionId });
  assert.deepEqual(report.result.promptReply, {
    sessionId: before.sessionId, text: expectedText, stopReason: "stop", aborted: false,
  });
  assert.equal(report.result.output, report.result.promptReply.text);
  assertReaped(report.workerPid);

  const after = await request("get_state");
  assert.equal(after.sessionId, before.sessionId, "the running Pi session must not be replaced");
  assert.equal(after.sessionId, report.result.promptReply.sessionId);
  assert.equal(after.sessionId, report.result.snapshot.sessionId);
  assert.equal(after.model.provider, provider);
  assert.equal(after.model.id, "hello");
  assert.equal(after.isStreaming, false);
  assert.equal(after.pendingMessageCount, 0);

  const { messages } = await request("get_messages");
  const users = messages.filter((message) => message.role === "user");
  const assistants = messages.filter((message) => message.role === "assistant");
  assert.equal(users.length, 1, "only the injected user prompt belongs in the conversation");
  assert.equal(textOf(users[0]), "hello world");
  assert.equal(assistants.length, 1);
  assert.equal(textOf(assistants[0]), expectedText);
  assert.equal(assistants[0].provider, provider);
  assert.equal(assistants[0].model, "hello");
  assert.equal(assistants[0].stopReason, "stop");
  const { entries } = await request("get_entries");
  const transcript = entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
  assert.deepEqual(transcript.filter((message) => message.role === "user").map(textOf), ["hello world"]);
  assert.deepEqual(transcript.filter((message) => message.role === "assistant").map(textOf), [expectedText]);

  assert.equal(records.filter((record) => record.type === "agent_start").length, 1, "one real Pi agent run");
  assert.equal(records.filter((record) => record.type === "agent_end").length, 1);
  const settled = records.filter((record) => record.type === "agent_settled");
  assert.equal(settled.length, 1, "one settled run, not merely an agent_end");
  assert.equal(settled[0].aborted, false);
  assert.deepEqual(records.filter((record) => record.type === "extension_error"), []);
} catch (error) {
  if (stderr) console.error(stderr);
  console.error("Recent Pi records:", JSON.stringify(records.slice(-6), null, 2));
  throw error;
} finally {
  child.stdin.end(); // Documented graceful RPC shutdown, not SIGTERM.
  const shutdownTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    assert.deepEqual(await closed, { code: 0, signal: null }, "Pi must shut down cleanly on stdin EOF");
    assert.equal(buffer, "", "stdout must end at an LF record boundary");
    for (const pid of workerPids) assertReaped(pid);
  } finally {
    clearTimeout(shutdownTimer);
    clearTimeout(watchdog);
    fail(new Error("Test finished"));
  }
}
console.log("PASS real Pi CLI same-session worker prompt; local TEST provider, one run, transcript + callback + cleanup verified");
