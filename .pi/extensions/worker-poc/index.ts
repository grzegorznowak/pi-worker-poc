import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HostAPI, HostReceipt, WorkerAPI } from "./contracts.ts";
import { RpcPeer } from "./rpc.ts";
import { createSessionPrompter } from "./session-prompt.ts";

export default function workerPoc(pi: ExtensionAPI) {
  const promptSession = createSessionPrompter(pi);
  const active = new Set<() => Promise<void>>();
  pi.on("session_shutdown", async () => {
    await Promise.all([...active].map((stop) => stop()));
  });

  pi.registerCommand("worker-poc", {
    description: "Worker IPC demo; 'prompt' sends hello world to this Pi session (uses the active model)",
    handler: async (args, ctx) => {
      const text = args.trim() || "hello";
      const mode = text === "fail" || text === "timeout" || text === "crash" || text === "prompt" ? text : "normal";
      const controller = new AbortController();
      let callback: HostReceipt | undefined;
      const child = fork(fileURLToPath(new URL("./worker.ts", import.meta.url)), [], {
        // jiti loads this extension, NOT the child. Node runs erasable TS itself.
        execArgv: [],
        cwd: ctx.cwd,
        // Worker stdout must not corrupt Pi's RPC stdout.
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      const rpc = new RpcPeer<WorkerAPI, HostAPI>(
        (message) => child.send(message, (error) => { if (error) rpc.close(error); }),
        {
          progress({ workerPid, message }) {
            // Real host-side Pi APIs run here; neither ctx nor pi crossed IPC.
            callback = {
              hostPid: process.pid,
              cwd: ctx.cwd,
              sessionId: ctx.sessionManager.getSessionId(),
              token: randomUUID(),
            };
            if (ctx.hasUI) {
              ctx.ui.setStatus("worker-poc", `worker ${workerPid}: callback received`);
              ctx.ui.notify(`WORKER_POC_PROGRESS ${JSON.stringify({ workerPid, message, ...callback })}`, "info");
            }
            return callback;
          },
          prompt({ text }) {
            // Use this live session, not an SDK-created session or a second Pi.
            return promptSession(ctx, text, controller.signal);
          },
        },
      );
      child.on("message", rpc.receive);
      child.on("disconnect", () => rpc.close(new Error("Worker IPC disconnected")));
      const finished = new Promise<void>((resolve) => {
        // Node may omit `close` after host-initiated IPC disconnect. There are
        // no output pipes to drain, so `exit` is the completion boundary.
        child.once("exit", (code, signal) => {
          rpc.close(new Error(`Worker exited (code=${code}, signal=${signal})`));
          resolve();
        });
        child.once("error", (error) => {
          rpc.close(error);
          if (child.pid === undefined) resolve(); // Spawn failed; no exit follows.
        });
      });
      let stopping: Promise<void> | undefined;
      const stop = (): Promise<void> => stopping ??= (async () => {
        controller.abort();
        rpc.close();
        // The child exits on IPC disconnect, including when the parent dies.
        if (child.connected) {
          try { child.disconnect(); }
          catch { child.kill("SIGKILL"); }
        }
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 750);
        try { await finished; }
        finally {
          clearTimeout(killTimer);
          active.delete(stop);
          child.off("message", rpc.receive);
        }
      })();
      active.add(stop);
      let report: Record<string, unknown>;
      try {
        if (ctx.hasUI) ctx.ui.setStatus("worker-poc", `calling worker ${child.pid}`);
        const result = await rpc.call("run", {
          text,
          mode,
          snapshot: { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() },
        }, mode === "timeout" ? 750 : mode === "prompt" ? 70_000 : 5000);
        const reply = result.promptReply;
        const ok = !reply || (!reply.aborted && !["error", "aborted", "unknown"].includes(reply.stopReason));
        report = { ok, hostPid: process.pid, workerPid: child.pid, callback, result };
      } catch (error) {
        report = {
          ok: false, hostPid: process.pid, workerPid: child.pid, callback,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        await stop();
        if (ctx.hasUI) ctx.ui.setStatus("worker-poc", undefined);
      }
      if (ctx.hasUI) {
        ctx.ui.notify(`WORKER_POC_RESULT ${JSON.stringify(report)}`, report.ok ? "info" : "error");
      }
    },
  });
}
