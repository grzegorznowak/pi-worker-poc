/**
 * TEST ONLY. A local, canned provider for prompt-integration.mjs.
 * Load explicitly with -e; never install this as a discovered extension.
 * There is no HTTP client, fetch call, OAuth flow, or network implementation.
 */
import assert from "node:assert/strict";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const reply = "Hello world from the running Pi session!";

function streamHello(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const user = context.messages.findLast((message) => message.role === "user");
  assert.ok(user, "TEST ONLY provider requires a user prompt");
  const text = typeof user.content === "string" ? user.content : user.content.map((block) => {
    assert.equal(block.type, "text", "TEST ONLY provider accepts text only");
    return block.type === "text" ? block.text : "";
  }).join("\n");
  assert.equal(text, "hello world", "worker must send the exact hello world prompt");

  // Import the native stream through Pi's extension loader, not a local shim.
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    timestamp: Date.now(),
    stopReason: "pending",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  queueMicrotask(() => {
    try {
      options?.signal?.throwIfAborted();
      // No request is sent and no HTTP response exists, so transport hooks do not apply.
      stream.push({ type: "start", partial: output });
      const block = { type: "text" as const, text: "" };
      output.content.push(block);
      stream.push({ type: "text_start", contentIndex: 0, partial: output });
      block.text = reply;
      stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: output });
      stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: output });
      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
    } finally {
      stream.end();
    }
  });
  return stream;
}

export default function helloProvider(pi: ExtensionAPI) {
  assert.equal(process.env.PI_WORKER_POC_TEST_PROVIDER, "1", "TEST ONLY provider must be explicitly enabled");
  pi.registerProvider("worker-poc-test-only", {
    name: "Worker PoC TEST ONLY (no network)",
    baseUrl: "https://test-only.invalid",
    // Pi's normal prompt preflight requires configured auth. This is not a credential.
    apiKey: "test-only-dummy-not-a-real-key",
    api: "worker-poc-test-only-api",
    models: [{
      id: "hello",
      name: "TEST ONLY canned hello",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 1024,
    }],
    streamSimple: streamHello,
  });
}
