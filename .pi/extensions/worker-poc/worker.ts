import { RpcPeer } from "./rpc.ts";
import type { HostAPI, WorkerAPI } from "./contracts.ts";

if (!process.send) throw new Error("Start worker.ts with child_process.fork (IPC required)");

const rpc: RpcPeer<HostAPI, WorkerAPI> = new RpcPeer<HostAPI, WorkerAPI>(
  (message) => process.send!(message, (error: Error | null) => {
    if (error) rpc.close(error);
  }),
  {
    async run({ text, snapshot, mode }) {
      // This awaits a NEW request to the host while the host awaits run().
      const receipt = await rpc.call("progress", {
        workerPid: process.pid,
        message: `Worker received ${JSON.stringify(text)}; requesting live Pi session data`,
      });
      if (mode === "fail") throw new Error("Intentional worker failure");
      if (mode === "crash") process.exit(7);
      if (mode === "timeout") return await new Promise<never>(() => {});
      const promptReply = mode === "prompt"
        ? await rpc.call("prompt", { text: "hello world" }, 65_000)
        : undefined;
      return {
        workerPid: process.pid,
        snapshot,
        receipt,
        output: promptReply ? promptReply.text : `${text.toUpperCase()} (host callback token: ${receipt.token})`,
        ...(promptReply ? { promptReply } : {}),
      };
    },
  },
);
process.on("message", rpc.receive);
process.on("disconnect", () => {
  rpc.close();
  process.exit(0);
});
