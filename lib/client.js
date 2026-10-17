// Client half of the DSH prompt optimizer.
//
// It occupies the `conversation.input.right` list slot, which the composer bar
// renders immediately to the LEFT of the model selector, and it calls the Host
// half over the existing authenticated Remote connection. No provider access,
// no direct model calls, no state outside this module.
window.__ModuleLoader__.load({
  id: "dsh-plugin-prompt-optimizer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const Button = primitives.Button;
    const Tooltip = primitives.Tooltip;
    const IconSparkleMedium = primitives.IconSparkleMedium;
    const IconRefreshOutlineMedium = primitives.IconRefreshOutlineMedium;
    const IconLoadingOutlineMedium = primitives.IconLoadingOutlineMedium;

    const NS = "prompt-optimizer";
    const SLOT = "conversation.input.right";
    const ENTRY_ID = "prompt-optimizer";
    const REMOTE_KEY = "remote.promptOptimizer";
    const CONTRACT_PACKAGE = "dsh-plugin-prompt-optimizer";

    // ---------------------------------------------------------------------
    // CSS: one idempotent <style> tag, hashed class names, --dsw-* tokens.
    // ---------------------------------------------------------------------
    const CSS = [
      ".DshPo_root{flex:none;align-items:center;display:flex;gap:2px}",
      ".DshPo_btn{flex:none;width:28px;height:28px;min-width:28px;padding:0;border:none;",
      "border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);",
      "cursor:pointer;outline:none;align-items:center;justify-content:center;display:inline-flex}",
      ".DshPo_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".DshPo_btn:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}",
      ".DshPo_btn:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
    ].join("");
    const CSS_TAG_ID = CONTRACT_PACKAGE + "/PromptOptimizer.module.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = CONTRACT_PACKAGE;
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ---------------------------------------------------------------------
    // Remote contract. The client declares the same SRC descriptor the Host
    // publishes. Only `codec.mode === 'strict'` is validated at mount time, so
    // a tiny validating parser is enough - no generated schema is needed.
    // ---------------------------------------------------------------------
    const JSON_CODEC = {
      mode: "strict",
      typeSymbol: "dsh-plugin-prompt-optimizer#JsonValue",
      create: () => ({ parse: (value) => value }),
    };
    const RESULT_CODEC = {
      mode: "strict",
      typeSymbol: "dsh-plugin-prompt-optimizer#OptimizeResult",
      create: () => ({ parse: (value) => value }),
    };

    const TYPERT_REMOTE = {
      package: CONTRACT_PACKAGE,
      descriptors: [
        {
          id: CONTRACT_PACKAGE + "#promptOptimizer/optimize",
          service: "promptOptimizer",
          namespace: "promptOptimizer",
          method: "optimize",
          invocation: { kind: "direct" },
          // Only the business parameter is a wire field. The trailing `signal`
          // is the cancellation parameter: the gateway appends the caller's
          // AbortSignal itself and counts it OUTSIDE `parameters`, so listing it
          // here would make prepareInvocation expect one argument too many.
          parameters: [{ name: "request", wire: "request", source: "json", codec: JSON_CODEC }],
          cancellation: { parameter: "signal" },
          result: RESULT_CODEC,
        },
      ],
    };

    // ---------------------------------------------------------------------
    // Dictionaries.
    // ---------------------------------------------------------------------
    const DICTS = {
      zh: {
        "optimize.label": "优化提示词",
        "optimize.pending": "正在优化…",
        "optimize.empty": "请先输入要优化的内容",
        "optimize.error": "优化失败：{message}",
        "optimize.done": "已优化（原文已保存，可继续调整）",
        "reoptimize.label": "重新优化",
        "reoptimize.pending": "正在重新优化…",
        "reoptimize.done": "已重新优化",
        "service.missing": "远程服务尚未就绪，请刷新页面后重试",
        "remote.missing": "未连接到后台服务，请检查连接后重试",
      },
      en: {
        "optimize.label": "Optimize prompt",
        "optimize.pending": "Optimizing…",
        "optimize.empty": "Type something to optimize first",
        "optimize.error": "Optimization failed: {message}",
        "optimize.done": "Optimized (the original is kept)",
        "reoptimize.label": "Re-optimize",
        "reoptimize.pending": "Re-optimizing…",
        "reoptimize.done": "Re-optimized",
        "service.missing": "The remote service is not ready yet - refresh the page and retry",
        "remote.missing": "Not connected to the host - check the connection and retry",
      },
    };

    // ---------------------------------------------------------------------
    // Helpers.
    // ---------------------------------------------------------------------
    function textOf(error) {
      if (error !== null && typeof error === "object" && typeof error.message === "string" && error.message !== "") {
        return error.message;
      }
      return String(error);
    }

    /**
     * The model the requesting session is actually using, read from the
     * session's own modelSelection projection - the same source the composer's
     * model selector renders from.
     */
    function activeModel(sessions, sessionId) {
      try {
        if (sessions === undefined || sessions === null || typeof sessions.binding !== "function") return undefined;
        const binding = sessions.binding(sessionId);
        const projection = binding?.session?.projections?.faceOf?.("modelSelection");
        const snapshot = projection?.getSnapshot?.();
        return snapshot?.next ?? snapshot?.lastUsed;
      } catch {
        return undefined;
      }
    }

    // ---------------------------------------------------------------------
    // The occupant component.
    // ---------------------------------------------------------------------
    function PromptOptimizer(props) {
      const useInput = props.useInput;
      const inputActions = props.inputActions;
      const sessionId = props.sessionId;
      const sessions = props.sessions;
      const getService = props.service;
      const t = typeof props.t === "function" ? props.t : (key) => key;

      const input = useInput((state) => state);
      const phase = input === undefined || input === null ? undefined : input.phase;
      const draft = input !== undefined && input !== null && typeof input.draft === "string" ? input.draft : "";
      const busyPhase = phase === "submitting" || phase === "adjudicating";

      const statusState = React.useState("idle");
      const status = statusState[0];
      const setStatus = statusState[1];
      const messageState = React.useState("");
      const message = messageState[0];
      const setMessage = messageState[1];
      const originalState = React.useState(undefined);
      const original = originalState[0];
      const setOriginal = originalState[1];
      const optimizedState = React.useState(undefined);
      const optimized = optimizedState[0];
      const setOptimized = optimizedState[1];
      const runningRef = React.useRef(false);

      const running = status === "running";
      const canOptimize = !running && !busyPhase && draft.trim() !== "";
      const canReoptimize = !running && !busyPhase && draft.trim() !== "" && original !== undefined && optimized !== undefined;

      const run = React.useCallback(
        async (kind) => {
          if (runningRef.current) return;
          const text = draft;
          if (text.trim() === "") {
            setStatus("error");
            setMessage(t("optimize.empty"));
            return;
          }
          runningRef.current = true;
          setStatus("running");
          setMessage("");

          const model = activeModel(sessions, sessionId);
          const request = {
            text: text,
            kind: kind,
            ...(model === undefined || model === null
              ? {}
              : {
                  provider: model.provider,
                  model: model.model,
                  ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
                }),
            ...(sessionId === undefined || sessionId === null ? {} : { sessionId: String(sessionId) }),
          };
          if (kind === "refine") request.previous = original;

          try {
            let remote;
            try {
              remote = getService();
            } catch (error) {
              throw new Error(t("service.missing"));
            }
            if (remote === undefined || remote === null || typeof remote.optimize !== "function") {
              throw new Error(t("service.missing"));
            }
            const result = await remote.optimize(request);
            if (result === null || typeof result !== "object" || result.ok !== true) {
              const failure = result === null || typeof result !== "object" ? undefined : result.error;
              if (failure !== undefined && failure !== null && failure.code === "gateway/cancelled") {
                setStatus("idle");
                setMessage("");
                return;
              }
              throw new Error(failure !== undefined && failure !== null && typeof failure.message === "string" ? failure.message : t("remote.missing"));
            }
            const value = result.value;
            if (value === null || typeof value !== "object" || typeof value.text !== "string" || value.text.trim() === "") {
              throw new Error(t("remote.missing"));
            }
            if (kind === "optimize") setOriginal(text);
            setOptimized(value.text);
            inputActions.setDraft(value.text);
            setStatus("done");
            setMessage(t(kind === "refine" ? "reoptimize.done" : "optimize.done"));
          } catch (error) {
            setStatus("error");
            setMessage(t("optimize.error", { message: textOf(error) }));
          } finally {
            runningRef.current = false;
          }
        },
        [draft, getService, inputActions, original, sessionId, sessions, t, setMessage, setOptimized, setOriginal, setStatus],
      );

      const label = running ? t("optimize.pending") : t("optimize.label");
      const reLabel = running ? t("reoptimize.pending") : t("reoptimize.label");
      const feedback = status === "idle" ? "" : message;

      const children = [];

      if (original !== undefined && optimized !== undefined) {
        children.push(
          h(
            Tooltip,
            { key: "reoptimize", portal: true, label: reLabel, side: "bottom", delayMs: 400 },
            h(
              Button,
              {
                className: "DshPo_btn",
                type: "button",
                size: "sm",
                variant: "ghost",
                disabled: !canReoptimize,
                "aria-label": reLabel,
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => {
                  run("refine");
                },
              },
              running && status === "running" ? h(IconLoadingOutlineMedium, { size: 16 }) : h(IconRefreshOutlineMedium, { size: 16 }),
            ),
          ),
        );
      }

      children.push(
        h(
          Tooltip,
          { key: "optimize", portal: true, label: label, side: "bottom", delayMs: 400 },
          h(
            Button,
            {
              className: "DshPo_btn",
              type: "button",
              size: "sm",
              variant: "ghost",
              disabled: !canOptimize,
              "aria-label": label,
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => {
                run("optimize");
              },
            },
            running ? h(IconLoadingOutlineMedium, { size: 16 }) : h(IconSparkleMedium, { size: 16 }),
          ),
        ),
      );

      return h(
        "div",
        {
          className: "DshPo_root",
          "data-prompt-optimizer": status,
          title: feedback === "" ? undefined : feedback,
        },
        children,
      );
    }

    // ---------------------------------------------------------------------
    // Wiring.
    // ---------------------------------------------------------------------
    /**
     * Resolve the mounted Remote namespace lazily, at click time. The namespace
     * only exists after `$mount`, so it must never be captured at registration.
     */
    function makeServiceGetter(root) {
      return () => {
        const remote = root.get(REMOTE_KEY);
        if (remote === undefined || remote === null || typeof remote.optimize !== "function") {
          throw new Error("prompt-optimizer: remote namespace is not mounted");
        }
        return remote;
      };
    }

    async function mountPromptOptimizer(rootCtx) {
      const disposeRemote = await rootCtx.remote.$mount(TYPERT_REMOTE);
      const root = rootCtx.root ?? rootCtx;
      const fiber = rootCtx.inject(["slots", "sessions", "locale", "connection"], (scope) => {
        scope.effect(() => scope.locale.register(NS, DICTS), "prompt-optimizer.dictionaries");
        const t = scope.locale.bind(NS);
        scope.slots.inject(SLOT, () =>
          scope.slots.register(
            {
              name: SLOT,
              id: ENTRY_ID,
              order: 40,
              label: () => t("optimize.label"),
              inject: () => ({ service: makeServiceGetter(root) }),
            },
            PromptOptimizer,
          ),
        );
        return undefined;
      });
      return async () => {
        try {
          await fiber?.dispose?.();
        } catch {
          /* already disposed */
        }
        await disposeRemote();
      };
    }

    exports.inject = ["remote", "slots", "locale", "sessions", "connection"];
    exports.apply = async function apply(ctx) {
      const dispose = await mountPromptOptimizer(ctx);
      ctx.effect(() => dispose, "prompt-optimizer.boundary");
    };
    return module.exports;
  },
});
