import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PromptReply } from "./contracts.ts";

/**
 * Observe one prompt in the existing session; never await this from an agent event or tool.
 * Events have no request ID, so external steering/continuations are not isolated.
 * Cancellation before agent_start cannot retract a prompt already sent for preparation.
 */
export function createSessionPrompter(pi: ExtensionAPI): (
  ctx: ExtensionContext, text: string, signal: AbortSignal, timeoutMs?: number,
) => Promise<PromptReply> {
  let inFlight = false;

  return async (ctx, text, signal, timeoutMs = 60_000) => {
    if (inFlight) throw new Error("A session prompt is already in flight");
    inFlight = true;
    try {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("Prompt timeout must be a positive finite number");
      }
      if (signal.aborted) throw new Error("Session prompt aborted");
      if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Pi session is busy or has queued messages");
      const model = ctx.model;
      if (!model) throw new Error("No active model for session prompt");
      const sessionId = ctx.sessionManager.getSessionId();

      return await new Promise<PromptReply>((resolve, reject) => {
        let done = false;
        let sent = false;
        let started = false;
        let assistant: Omit<PromptReply, "sessionId" | "aborted"> | undefined;
        const unsubscribers: (() => void)[] = [];
        const sameSession = (eventCtx = ctx) => {
          try {
            return ctx.sessionManager.getSessionId() === sessionId
              && eventCtx.sessionManager.getSessionId() === sessionId;
          } catch {
            return false; // A replaced extension context can already be invalid.
          }
        };
        const finish = (reply: PromptReply | undefined, error?: unknown, abort = false) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          for (const unsubscribe of unsubscribers) unsubscribe();
          // There is no public request/run ID. Do not abort anything before our start.
          if (abort && started && sameSession()) {
            try { ctx.abort(); } catch { /* Preserve the original failure. */ }
          }
          if (reply) resolve(reply);
          else reject(error);
        };
        const onAbort = () => finish(undefined, new Error("Session prompt aborted"), true);
        const timer = setTimeout(() => {
          finish(undefined, new Error(`Session prompt timed out after ${timeoutMs}ms`), true);
        }, timeoutMs);
        signal.addEventListener("abort", onAbort, { once: true });

        try {
          // Subscribe before sendUserMessage: it returns void, and startup can be delayed.
          unsubscribers.push(pi.on("agent_start", (_event, eventCtx) => {
            if (!done && sent && sameSession(eventCtx)) started = true;
          }));
          unsubscribers.push(pi.on("agent_end", (event, eventCtx) => {
            if (done || !started || !sameSession(eventCtx)) return;
            for (let i = event.messages.length - 1; i >= 0; i--) {
              const message = event.messages[i];
              if (message.role !== "assistant") continue;
              assistant = {
                text: message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"),
                stopReason: message.stopReason,
                ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
              };
              break;
            }
          }));
          unsubscribers.push(pi.on("agent_settled", (event, eventCtx) => {
            if (done || !started || !sameSession(eventCtx)) return;
            finish({
              sessionId,
              text: assistant?.text ?? "",
              stopReason: assistant?.stopReason ?? (event.aborted ? "aborted" : "unknown"),
              aborted: event.aborted || assistant?.stopReason === "aborted",
              ...(assistant?.errorMessage === undefined ? {} : { errorMessage: assistant.errorMessage }),
            });
          }));
          unsubscribers.push(pi.on("session_shutdown", (_event, eventCtx) => {
            if (sameSession(eventCtx)) finish(undefined, new Error("Session shut down during prompt"), true);
          }));
          if (signal.aborted) { onAbort(); return; }

          // The timer bounds auth too. Auth resolution itself has no public signal parameter.
          void (async () => {
            const auth = await ctx.modelRegistry.getProviderAuth(model.provider);
            if (done) return;
            if (signal.aborted) { onAbort(); return; }
            if (!sameSession()) throw new Error("Pi session changed during prompt preflight");
            if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Pi session is busy or has queued messages");
            if (ctx.model?.provider !== model.provider || ctx.model.id !== model.id) {
              throw new Error("Active model changed during prompt preflight");
            }
            // Older/runtime model objects can carry this flag; the public Model type does not.
            if (auth === undefined && !("authHeader" in model && model.authHeader === false)) {
              throw new Error(`No authentication for provider "${model.provider}"`);
            }
            sent = true;
            pi.sendUserMessage(text);
          })().catch((error: unknown) => finish(undefined, error));
        } catch (error) {
          finish(undefined, error);
        }
      });
    } finally {
      inFlight = false;
    }
  };
}
