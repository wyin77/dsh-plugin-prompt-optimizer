// Host half of the DSH prompt optimizer.
//
// It owns exactly one job: turn a draft prompt into an optimized prompt using
// the model that the requesting session is already using. The client half never
// talks to a model provider directly - it calls this method over the existing
// authenticated Remote connection.
//
// The method is exposed as a hand-written SRC Remote: a marker on the service
// prototype plus the `typertRemote` binding on the instance. The Typert gateway
// reads the JS parameter names straight off the prototype method, so `optimize`
// must keep exactly two identifier parameters and `signal` must stay last.

const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";

const SERVICE_KEY = "promptOptimizer";
const METHOD = "optimize";

const MAX_DRAFT_CHARS = 20000;
const MAX_OUTPUT_TOKENS = 4000;

const SYSTEM_COMMON = [
  "You rewrite a user's draft prompt into a clearly better prompt for an AI coding assistant.",
  "",
  "Rules:",
  "- Output ONLY the improved prompt. No preamble, no commentary, no quotes, no code fence around the whole answer.",
  "- Keep the user's language, intent, scope, names, paths, commands and numbers exactly as given. Never invent requirements.",
  "- Preserve every explicit constraint; make implicit ones explicit only when the draft implies them.",
  "- Make the request concrete and actionable: state the goal, the relevant context, the expected output, and how to verify it.",
  "- If the draft is a question, keep it a question but sharpen it.",
  "- If the draft is already good, improve it only marginally.",
].join("\n");

const SYSTEM_FIRST = [
  SYSTEM_COMMON,
  "",
  "This is a first optimization pass.",
].join("\n");

const SYSTEM_REFINE = [
  SYSTEM_COMMON,
  "",
  "This is a RE-OPTIMIZATION pass over a prompt that was already improved once.",
  "Use any revision notes provided. Move it further toward explicit, verifiable, self-contained instructions without changing what the user wants.",
].join("\n");

/** Text of a message content block list, tolerating the string shorthand. */
function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let text = "";
    for (const block of content) {
      if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        text += block.text;
      }
    }
    return text;
  }
  return "";
}

/** Join the history of one request so the rewrite keeps every constraint. */
function historyText(messages) {
  let text = "";
  for (const message of messages) {
    const role = message.role === "assistant" ? "ASSISTANT" : "USER";
    const body = contentText(message.content);
    if (body.length === 0) continue;
    text += `${role}:\n${body}\n\n`;
  }
  return text.trim();
}

function failureMessage(failure, fallback) {
  if (failure !== undefined && failure !== null && typeof failure.message === "string" && failure.message !== "") {
    return failure.message;
  }
  return fallback;
}

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Resolve the model endpoint from the request, then from the live Agent the
 * session belongs to. The client sends the same selection the composer shows;
 * the Agent header is the authoritative fallback on the host.
 */
function resolveRoute(ctx, request) {
  let provider = typeof request.provider === "string" && request.provider !== "" ? request.provider : undefined;
  let model = typeof request.model === "string" && request.model !== "" ? request.model : undefined;
  let reasoningEffort =
    typeof request.reasoningEffort === "string" && request.reasoningEffort !== "" ? request.reasoningEffort : undefined;

  if ((provider === undefined || model === undefined) && typeof request.sessionId === "string" && request.sessionId !== "") {
    const agents = ctx.get("agents");
    const agent = agents !== undefined && typeof agents.get === "function" ? agents.get(request.sessionId) : undefined;
    if (agent !== undefined && agent !== null) {
      let headerConfig;
      try {
        headerConfig = agent.session.requestHeader()?.config;
      } catch {
        headerConfig = undefined;
      }
      if (headerConfig !== undefined && headerConfig !== null) {
        if (provider === undefined && typeof headerConfig.provider === "string") provider = headerConfig.provider;
        if (model === undefined && typeof headerConfig.model === "string") model = headerConfig.model;
        if (reasoningEffort === undefined && typeof headerConfig.reasoningEffort === "string") {
          reasoningEffort = headerConfig.reasoningEffort;
        }
      }
      if (provider === undefined && agent.options !== undefined && agent.options !== null) {
        if (typeof agent.options.provider === "string") provider = agent.options.provider;
        if (model === undefined && typeof agent.options.model === "string") model = agent.options.model;
      }
    }
  }

  if (provider === undefined || model === undefined) {
    throw errorWithCode("prompt-optimizer: no active model for this session", "prompt-optimizer/no-model");
  }

  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

/** Detect misuse of the two-argument contract before building anything. */
function validateRequest(request) {
  if (request === null || typeof request !== "object") {
    throw errorWithCode("prompt-optimizer: request must be an object", "prompt-optimizer/invalid-request");
  }
  if (typeof request.text !== "string" || request.text.trim() === "") {
    throw errorWithCode("prompt-optimizer: there is nothing in the composer to optimize", "prompt-optimizer/empty-draft");
  }
  if (request.text.length > MAX_DRAFT_CHARS) {
    throw errorWithCode(
      `prompt-optimizer: the draft is ${request.text.length} characters; the limit is ${MAX_DRAFT_CHARS}`,
      "prompt-optimizer/draft-too-long",
    );
  }
  const kind = request.kind === undefined ? "optimize" : request.kind;
  if (kind !== "optimize" && kind !== "refine") {
    throw errorWithCode(`prompt-optimizer: unsupported kind ${JSON.stringify(kind)}`, "prompt-optimizer/invalid-request");
  }
  return kind;
}

/**
 * The published Host Service. Keep the public surface to this one Remote
 * method; everything else stays local to the closure.
 */
class PromptOptimizerService {
  async optimize(request, signal) {
    const kind = validateRequest(request);
    const route = resolveRoute(this.ctx, request);

    const draft = request.text;
    const parts = [`CURRENT PROMPT TO IMPROVE:\n${draft}`];

    if (kind === "refine" && typeof request.previous === "string" && request.previous !== "" && request.previous !== draft) {
      parts.push(`PREVIOUS IMPROVED VERSION:\n${request.previous}`);
    }
    if (typeof request.note === "string" && request.note !== "") {
      parts.push(`REVISION NOTES:\n${request.note}`);
    }
    const history = typeof request.history === "string" && request.history !== "" ? request.history : undefined;
    if (history !== undefined) {
      parts.push(`CONVERSATION SO FAR (context only; do not continue it):\n${history}`);
    }

    const options = {
      provider: route.provider,
      model: route.model,
      messages: [{ role: "user", content: [{ type: "text", text: parts.join("\n\n") }] }],
      system: kind === "refine" ? SYSTEM_REFINE : SYSTEM_FIRST,
      maxTokens: MAX_OUTPUT_TOKENS,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      ...(typeof request.sessionId === "string" && request.sessionId !== ""
        ? { sessionId: request.sessionId }
        : {}),
      ...(signal === undefined ? {} : { signal }),
    };

    const llm = this.ctx.get("llm");
    if (llm === undefined || typeof llm.stream !== "function") {
      throw errorWithCode("prompt-optimizer: the llm service is not available", "prompt-optimizer/no-llm");
    }

    let text = "";
    let finish;
    let usage;
    const stream = llm.stream(options);
    for await (const chunk of stream) {
      if (chunk === null || typeof chunk !== "object") continue;
      switch (chunk.type) {
        case "text-delta": {
          const delta = chunk.text;
          if (typeof delta === "string") text += delta;
          else if (delta !== null && typeof delta === "object" && typeof delta.text === "string") text += delta.text;
          break;
        }
        case "finish": {
          finish = chunk.reason;
          break;
        }
        case "usage": {
          usage = chunk.usage;
          break;
        }
        default:
          break;
      }
    }

    if (finish !== undefined && finish !== null) {
      if (finish.kind === "error") {
        throw errorWithCode(
          failureMessage(finish.failure, "prompt-optimizer: the model request failed"),
          finish.failure?.code ?? "prompt-optimizer/model-error",
        );
      }
      if (finish.kind === "aborted") {
        throw errorWithCode(
          failureMessage(finish.failure, "prompt-optimizer: the model request was aborted"),
          "prompt-optimizer/aborted",
        );
      }
      if (finish.kind === "max-tokens") {
        throw errorWithCode(
          "prompt-optimizer: the rewritten prompt reached the output token limit",
          "prompt-optimizer/max-tokens",
        );
      }
    }

    let result = text.trim();
    if (result.startsWith("```")) {
      result = result.replace(/^```[A-Za-z0-9_-]*\s*\n/, "").replace(/\n?```\s*$/, "").trim();
    }
    if (result === "") {
      throw errorWithCode("prompt-optimizer: the model returned an empty prompt", "prompt-optimizer/empty-result");
    }
    return usage === undefined ? { text: result, kind } : { text: result, kind, usage };
  }
}

// Hand-written SRC Remote marker. `version: 1` and a methods array are the
// entire contract the gateway and the Typert protocol inspect.
Object.defineProperty(PromptOptimizerService.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: {
    version: 1,
    methods: [{ method: METHOD, invocation: { kind: "direct" } }],
  },
});

export const name = "promptOptimizer";

export function apply(ctx) {
  const service = new PromptOptimizerService();
  service.ctx = ctx;
  service.typertRemote = Object.freeze({
    service,
    serviceKey: SERVICE_KEY,
    namespace: SERVICE_KEY,
  });
  ctx.provide(SERVICE_KEY, service);
}
