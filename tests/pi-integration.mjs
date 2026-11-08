import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extension = resolve(project, ".pi/extensions/worker-poc/index.ts");

async function verify(approved) {
  // Keep all generated Pi state project-local; do not read global auth/settings.
  const agentDir = await mkdtemp(resolve(project, ".test-agent-"));
  const child = spawn("pi", [
    "--offline", approved ? "--approve" : "--no-approve", "--no-session", "--mode", "rpc",
    "--provider", "anthropic", "--model", "claude-haiku-4-5-20251001",
    "--no-mcp", "--no-tools", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
  ], {
    cwd: project,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: "0", NODE_DISABLE_COMPILE_CACHE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const records = [];
  const pending = new Map();
  let stderr = "";
  let buffer = "";
  let nextId = 0;
  const workerPids = new Set();
  const rejectPending = (error) => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  };
  child.on("error", rejectPending);
  child.stdin.on("error", rejectPending);
  const closed = new Promise((resolveClose) => child.once("close", (code, signal) => {
    rejectPending(new Error(`Pi exited: ${code}/${signal}\n${stderr}`));
    resolveClose({ code, signal });
  }));
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-10000); });
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); }
      catch { rejectPending(new Error(`Non-JSON Pi stdout: ${line}`)); child.kill("SIGKILL"); return; }
      records.push(record);
      if (record.type === "extension_ui_request" && record.method === "notify" &&
          record.message.startsWith("WORKER_POC_PROGRESS ")) {
        workerPids.add(JSON.parse(record.message.slice("WORKER_POC_PROGRESS ".length)).workerPid);
      }
      if (record.type === "response" && pending.has(record.id)) {
        const p = pending.get(record.id);
        pending.delete(record.id);
        clearTimeout(p.timer);
        record.success ? p.resolve(record.data) : p.reject(new Error(record.error));
      }
    }
  });
  const request = (type, fields = {}) => new Promise((resolveRequest, reject) => {
    const id = String(++nextId);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Pi ${type} deadline exceeded\n${stderr}`));
    }, 15000);
    pending.set(id, { resolve: resolveRequest, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 40000);
  try {
    const { commands } = await request("get_commands");
    const command = commands.find((c) => c.name === "worker-poc");
    if (!approved) {
      assert.equal(command, undefined, "unapproved project must not load extension");
      console.log("PASS project trust refusal prevents discovery");
    } else {
      assert.ok(command, "project extension was auto-discovered");
      assert.equal(command.source, "extension");
      assert.equal(command.sourceInfo.scope, "project");
      assert.equal(command.sourceInfo.path, extension);
      console.log(`PASS auto-discovered project extension: ${command.sourceInfo.path}`);
      // Recovery after failures is checked by the final normal command.
      for (const text of ["hello", "fail", "timeout", "crash", "prompt", "hello again"]) {
        const start = records.length;
        const response = await request("prompt", { message: `/worker-poc ${text}` });
        assert.equal(response.disposition, "handled", "must never enter a model run");
        const messages = records.slice(start).filter((r) => r.type === "extension_ui_request" && r.method === "notify");
        const readReport = (prefix) => {
          const matches = messages.filter((r) => r.message.startsWith(prefix));
          assert.equal(matches.length, 1, `${text}: one ${prefix} notification`);
          return JSON.parse(matches[0].message.slice(prefix.length));
        };
        const progress = readReport("WORKER_POC_PROGRESS ");
        const report = readReport("WORKER_POC_RESULT ");
        workerPids.add(report.workerPid);
        assert.equal(report.hostPid, child.pid);
        assert.notEqual(report.workerPid, report.hostPid);
        assert.equal(progress.workerPid, report.workerPid);
        assert.deepEqual(report.callback, {
          hostPid: child.pid, cwd: project, sessionId: progress.sessionId, token: progress.token,
        });
        assert.equal(typeof report.callback.token, "string");
        assert.ok(report.callback.token.length > 0);
        const expectedErrors = {
          fail: /Intentional worker failure/,
          timeout: /RPC timeout: run after 750ms/,
          crash: /Worker (IPC disconnected|exited \(code=7)/,
          prompt: /No authentication for provider "anthropic"/,
        };
        if (Object.hasOwn(expectedErrors, text)) {
          assert.equal(report.ok, false);
          assert.match(report.error, expectedErrors[text]);
        } else {
          assert.equal(report.ok, true);
          assert.equal(report.result.workerPid, report.workerPid);
          assert.deepEqual(report.result.receipt, report.callback);
          assert.deepEqual(report.result.snapshot, { cwd: project, sessionId: progress.sessionId });
          assert.equal(report.result.output, `${text.toUpperCase()} (host callback token: ${progress.token})`);
        }
        assert.throws(() => process.kill(report.workerPid, 0), { code: "ESRCH" }, "worker must be reaped");
        console.log(`PASS ${text}: host=${report.hostPid} worker=${report.workerPid}; callback + cleanup verified`);
      }
    }
    assert.equal(records.some((r) => r.type === "agent_start"), false, "no model runs");
    assert.deepEqual(records.filter((r) => r.type === "extension_error"), []);
  } catch (error) {
    if (stderr) console.error(stderr);
    console.error("Recent Pi records:", JSON.stringify(records.slice(-6), null, 2));
    throw error;
  } finally {
    child.stdin.end(); // Documented RPC graceful shutdown, not SIGTERM.
    const shutdownTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const result = await closed;
      assert.deepEqual(result, { code: 0, signal: null }, "Pi must shut down cleanly on EOF");
      for (const pid of workerPids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      clearTimeout(shutdownTimer);
      clearTimeout(watchdog);
      rejectPending(new Error("Test finished"));
    }
  }
}

await verify(true);
await verify(false);
console.log("PASS real Pi CLI integration; no model runs or global configuration changes");
