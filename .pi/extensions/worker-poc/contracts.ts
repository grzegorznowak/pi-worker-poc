// Only plain JSON data crosses the process boundary. Pi objects stay in index.ts.
export type SessionSnapshot = { cwd: string; sessionId: string };
export type HostReceipt = SessionSnapshot & { hostPid: number; token: string };
export type PromptReply = {
  sessionId: string;
  text: string;
  stopReason: string;
  aborted: boolean;
  errorMessage?: string;
};

export type HostAPI = {
  progress: {
    params: { workerPid: number; message: string };
    result: HostReceipt;
  };
  prompt: {
    params: { text: string };
    result: PromptReply;
  };
};

export type WorkerAPI = {
  run: {
    params: {
      text: string;
      snapshot: SessionSnapshot;
      mode: "normal" | "fail" | "timeout" | "crash" | "prompt";
    };
    result: {
      workerPid: number;
      snapshot: SessionSnapshot;
      receipt: HostReceipt;
      output: string;
      promptReply?: PromptReply;
    };
  };
};
