// Small, symmetric typed SDK: either peer can call while servicing a request.
// Contracts are compile-time checks, not runtime validation or a security boundary.
type API = Record<string, { params: unknown; result: unknown }>;
type Handlers<T extends API> = {
  [K in keyof T]: (params: T[K]["params"]) => T[K]["result"] | Promise<T[K]["result"]>;
};
const channel = "pi-worker-poc/1";
export type Message =
  | { channel: typeof channel; kind: "request"; id: string; method: string; params: unknown }
  | { channel: typeof channel; kind: "response"; id: string; ok: true; result: unknown }
  | { channel: typeof channel; kind: "response"; id: string; ok: false; error: string };

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  if (m.channel !== channel || typeof m.id !== "string") return false;
  return (m.kind === "request" && typeof m.method === "string") ||
    (m.kind === "response" && (m.ok === true || (m.ok === false && typeof m.error === "string")));
}

export class RpcPeer<Remote extends API, Local extends API> {
  #nextId = 0;
  #closed: Error | undefined;
  #send: (message: Message) => void;
  #handlers: Handlers<Local>;
  #pending = new Map<string, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(send: (message: Message) => void, handlers: Handlers<Local>) {
    this.#send = send;
    this.#handlers = handlers;
  }

  call<K extends keyof Remote & string>(
    method: K, params: Remote[K]["params"], timeoutMs = 3000,
  ): Promise<Remote[K]["result"]> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = String(++this.#nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`RPC timeout: ${method} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#transmit({ channel, kind: "request", id, method, params });
    }) as Promise<Remote[K]["result"]>;
  }

  receive = (value: unknown): void => {
    if (this.#closed || !isMessage(value)) return;
    if (value.kind === "request") {
      void this.#respond(value);
      return;
    }
    const pending = this.#pending.get(value.id);
    if (!pending) return; // Includes replies that arrive after a deadline.
    this.#pending.delete(value.id);
    clearTimeout(pending.timer);
    if (value.ok) pending.resolve(value.result);
    else pending.reject(new Error(value.error));
  };

  close(error = new Error("RPC closed")): void {
    if (this.#closed) return;
    this.#closed = error;
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
  }

  #transmit(message: Message): void {
    if (this.#closed) return;
    try { this.#send(message); }
    catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); }
  }

  async #respond(request: Extract<Message, { kind: "request" }>): Promise<void> {
    try {
      if (!Object.hasOwn(this.#handlers, request.method)) {
        throw new Error(`Unknown RPC method: ${request.method}`);
      }
      const result = await this.#handlers[request.method](request.params);
      this.#transmit({ channel, kind: "response", id: request.id, ok: true, result });
    } catch (error) {
      this.#transmit({ channel, kind: "response", id: request.id, ok: false,
        error: error instanceof Error ? error.message : String(error) });
    }
  }
}
