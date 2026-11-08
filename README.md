# Pi ↔ TypeScript worker PoC

> **⚠️ This is an experiment.** A small proof of concept for exploring how a
> [Pi](https://github.com/earendil-works/pi) extension can talk to a separate
> Node.js process over typed IPC and ask the *same running Pi session* to answer
> a prompt. It is not production infrastructure and is not a security boundary.
> Expect rough edges, missing features, and behavior that may change.

A project-local Pi extension calls a separate Node process. That worker calls back into Pi **while Pi is still waiting for the original request**, then returns its result. Shared TypeScript contracts type both directions.

## Run

Requires Pi on `PATH` and Node >=22.19. Tested with Pi 1.5.0 and Node 24.14.0. No build or `npm install` is needed.

```sh
cd /path/to/pi-worker-poc
pi --approve
```

In Pi:

```text
/worker-poc hello
```

`--approve` trusts this project's resources for this process only. It does not save a global trust decision. The extension is already installed by placement under `.pi/extensions/worker-poc/index.ts`; no `-e` flag or global installation is needed.

The command shows progress and a `WORKER_POC_RESULT` JSON notification with:

- Different `hostPid` and `workerPid` values.
- A session snapshot supplied by Pi.
- A receipt created by the host callback from live Pi session data.
- The host-generated random token in the worker's final output, proving that the callback reply returned to the worker.

Other cases:

```text
/worker-poc fail
/worker-poc timeout
/worker-poc crash
/worker-poc hello again
```

Each command starts one worker and waits for its cleanup before reporting. Failures do not disable subsequent commands. The commands above do not request model completions.

## Ask the running Pi session

```text
/worker-poc prompt
```

If Pi is already running in this project, use `/reload` first to load the updated extension.

The worker now calls `rpc.call("prompt", { text: "hello world" })`. The host submits that exact user message with `pi.sendUserMessage()` in the **same session**, using its current model, credentials, tools, and conversation history. It does not start another Pi process or create an SDK session. This command makes a real model request during normal use and can incur the usual provider cost.

Pi displays the model response normally. The adapter waits for `agent_settled`, then sends the assistant text back to the worker. The final `WORKER_POC_RESULT` includes `result.promptReply` (`sessionId`, `text`, `stopReason`, `aborted`, optional `errorMessage`); `result.output` is that assistant text. Errors and aborted replies set the report's `ok` to `false`.

Only one worker-driven prompt is allowed at a time, and the session must be idle with no queued messages. Missing model/authentication is reported instead of starting another session. The host has a 60-second deadline, inside the worker's 65-second RPC deadline and the original request's 70-second deadline.

## Layout

```text
.pi/extensions/worker-poc/
  index.ts       Pi adapter: command, fork, host callbacks, cleanup
  contracts.ts   Serializable request/result types for both directions
  rpc.ts         Symmetric typed RPC peer with IDs, errors, and deadlines
  session-prompt.ts  Same-session prompt submission and lifecycle observation
  worker.ts      Separate TypeScript program; no Pi runtime import
```

Pi discovers only `index.ts` in this directory. Helper files are imported normally; they are not loaded as extension factories. The root `package.json` declares ESM so Node can run the child `.ts` files directly. Pi's jiti loader is not inherited by the worker.

## Round trip

```mermaid
sequenceDiagram
    autonumber
    participant Pi as Pi (extension host)
    participant W as Node worker (different PID)

    Pi->>W: run(text, snapshot)
    activate W
    W->>Pi: progress(message)
    activate Pi
    Note over Pi: read live Pi session ID\ncreate token; show progress
    Pi-->>W: callback receipt
    deactivate Pi
    Note over W: use receipt in output
    W-->>Pi: run result
    deactivate W
    Pi->>W: disconnect IPC; await worker exit
```

The host uses `RpcPeer<WorkerAPI, HostAPI>`; the worker uses `RpcPeer<HostAPI, WorkerAPI>`. `call()` checks method names, parameter types, and result types at compile time. Incoming requests are handled asynchronously, not blocked behind outgoing calls.

In `prompt` mode, the worker makes another host callback after progress: `prompt("hello world")`. The host waits for the current session's assistant response and returns it over that callback before the worker finishes `run()`.

This is a small custom remote API, **not** a transparent proxy for the entire Pi SDK. Pi objects and functions stay in the host adapter. To expose another operation, add a data-only contract and an explicit host handler.

## Verify

```sh
cd /path/to/pi-worker-poc
npm test
```

Tests use Node's built-in test runner and the actual `pi` CLI in RPC mode. No real API keys are passed. The new prompt test explicitly loads `tests/fixtures/hello-provider.ts`, a local test provider with a dummy key and a fixed reply. It makes no network request and is not loaded during normal use. `npm run test:prompt` runs only this integration test. Test Pi configuration is isolated in ignored `.test-agent-*` directories inside this project; no global Pi settings or trust files are changed.

Checks include:

- 41 unit tests (including subtests) for RPC and prompt lifecycle handling: callbacks, concurrent requests, errors, deadlines, retries, cancellation, and listener cleanup.
- Actual project auto-discovery, including reported project scope and extension path.
- Trust refusal preventing extension loading.
- Callback receipt and final token matching across different PIDs.
- Worker failure, timeout, crash, and subsequent recovery.
- No model runs in the original IPC-only cases; one local-provider agent run for the new prompt case, with no external model calls.
- Unchanged session ID, exact `hello world` user message and assistant reply in the transcript, and matching reply data returned through the worker.
- No unexpected extension errors, worker PIDs gone, and clean Pi shutdown on stdin EOF.

The source and unit tests also passed strict TypeScript 5.9.3 checking against the installed Pi declarations. That local verification configuration is in `.test-agent-typecheck/tsconfig.json` and uses the machine's installed package paths. It is ignored by git and is not part of the published repository.

## Limits

- Child-process isolation is **not a security sandbox**. The worker inherits the host's environment and OS permissions.
- Contracts are compile-time checks. Only RPC envelopes receive basic runtime validation; this is a trusted local PoC, not an untrusted-client protocol.
- A deadline rejects a pending RPC call; it does not itself cancel remote work. The Pi adapter then disconnects the per-command worker and uses a kill fallback if necessary.
- The prompt adapter aborts a run it has observed starting when its deadline expires or the worker is stopped. Pi's public send API cannot retract a submitted prompt during preparation before `agent_start`.
- Agent lifecycle events have no request IDs. The idle/exclusive guard is sufficient for this PoC, but human steering or other extensions can affect the observed response. This is not strict per-request isolation.
- `session_shutdown` also stops active workers. The worker exits when IPC disconnects, including if the host dies.
- Command output uses Pi UI notifications (interactive or RPC mode), not print-mode output or model-visible tool results.
