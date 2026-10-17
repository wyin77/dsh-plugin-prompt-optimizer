// Load-time verification for the DSH prompt-optimizer plugin (no app needed).
//
//  1. Host half: import lib/index.js, check the SRC marker, the published
//     namespace, and the exact parameter names the Typert gateway will parse.
//  2. Client half: execute lib/client.js in a stubbed module loader and check
//     the exported { inject, apply } shape and that registration reaches the
//     conversation.input.right list slot.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const log = [];
let failed = 0;
function check(name, ok, detail = "") {
  log.push(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : ` - ${detail}`}`);
  if (!ok) failed += 1;
}

// ---------------------------------------------------------------- host half
const hostPath = path.join(root, "lib", "index.js");
const host = await import(`file://${hostPath.replace(/\\/g, "/")}`);
check("host exports name", host.name === "promptOptimizer", String(host.name));
check("host exports apply", typeof host.apply === "function");

const granted = [];
const injected = [];
const fakeCtx = {
  get(key) {
    if (key === "llm") {
      return {
        stream(options) {
          granted.push(options);
          return (async function* () {
            yield { type: "text-delta", text: "hello " };
            yield { type: "text-delta", text: "world" };
            yield { type: "finish", reason: { kind: "stop" } };
          })();
        },
      };
    }
    if (key === "agents") return { get: () => undefined };
    return undefined;
  },
  provide(key, value) {
    injected.push([key, value]);
  },
};
host.apply(fakeCtx);
check("apply provides the service", injected.length === 1 && injected[0][0] === "promptOptimizer");
const service = injected[0]?.[1];
check("service has optimize()", typeof service?.optimize === "function");
check(
  "service publishes typertRemote binding",
  service?.typertRemote?.namespace === "promptOptimizer" && service.typertRemote.service === service,
);

const MARKER = "@deepseek-ai/dsh-typert-protocol/remote-methods";
const proto = Object.getPrototypeOf(service);
const descriptor = proto[MARKER];
check("SRC marker version is 1", descriptor?.version === 1);
check(
  "SRC marker lists optimize as direct",
  descriptor?.methods?.length === 1 &&
    descriptor.methods[0].method === "optimize" &&
    descriptor.methods[0].invocation?.kind === "direct",
);

// The gateway parses Function.prototype.toString() and requires unique plain
// identifiers with `signal` last.
const signature = proto.optimize.toString();
const params = signature.slice(signature.indexOf("(") + 1, signature.indexOf(")")).split(",").map((s) => s.trim());
check("optimize parameter names are plain identifiers", params.join(",") === "request,signal", params.join(","));

// Behavioral check of one shot.
const result = await service.optimize({ text: "fix the bug", kind: "optimize", provider: "p", model: "m" });
check("optimize returns the assembled text", result.text === "hello world", JSON.stringify(result));
check("request carries provider/model/system", granted[0]?.provider === "p" && granted[0]?.model === "m" && typeof granted[0]?.system === "string");
check("request has no closed-union purpose", granted[0]?.purpose === undefined);
check("request messages are plain role/content objects", granted[0]?.messages?.[0]?.role === "user" && granted[0]?.messages?.[0]?.content?.[0]?.type === "text");

for (const [request, code] of [
  [{ text: "   ", provider: "p", model: "m" }, "prompt-optimizer/empty-draft"],
  [{ text: "x", kind: "nope", provider: "p", model: "m" }, "prompt-optimizer/invalid-request"],
  [{ text: "x" }, "prompt-optimizer/no-model"],
]) {
  let caught;
  try {
    await service.optimize(request);
  } catch (error) {
    caught = error;
  }
  check(`rejects invalid request (${code})`, caught?.code === code, String(caught?.code));
}

// -------------------------------------------------------------- client half
const clientSource = fs.readFileSync(path.join(root, "lib", "client.js"), "utf8");
check("client bundle declares the loader id", clientSource.includes('id: "dsh-plugin-prompt-optimizer"'));
check("client bundle has no top-level import/export", !/^\s*(import|export)\s/m.test(clientSource));

const loaded = [];
let registration;
const disposers = [];
const stubCtx = {
  remote: { async $mount(contribution) { loaded.push(contribution); return async () => {}; } },
  get(key) {
    if (key === "remote.promptOptimizer") return { async optimize() { return { ok: true, value: { text: "t" } }; } };
    return undefined;
  },
  effect(fn) { disposers.push(fn); return () => {}; },
  inject(services, callback) {
    check("client injects slots/locale/sessions", services.join(",") === "slots,sessions,locale,connection", services.join(","));
    callback({
      root: stubCtx,
      locale: { register: () => () => {}, bind: () => (key) => key },
      slots: {
        inject(name, body) { check("slots.inject targets the right slot", name === "conversation.input.right", name); body(); },
        register(descriptor, component) { registration = { descriptor, component }; },
      },
      effect: () => () => {},
    });
    return { dispose: async () => {} };
  },
};

const React = { createElement: (...args) => ({ args }), useState: () => [undefined, () => {}], useRef: () => ({ current: false }), useCallback: (fn) => fn };
const primitives = {
  Button: () => null,
  Tooltip: () => null,
  IconSparkleMedium: () => null,
  IconRefreshOutlineMedium: () => null,
  IconLoadingOutlineMedium: () => null,
};
const sandbox = {
  window: { __ModuleLoader__: { load: (contribution) => loaded.push(contribution) } },
  document: undefined,
  console,
};
sandbox.globalThis = sandbox;
const vm = await import("node:vm");
vm.createContext(sandbox);
vm.runInContext(clientSource, sandbox, { filename: "client.js" });

const contribution = loaded[0];
check("loader received one contribution", loaded.length === 1);
check("contribution id matches the package name", contribution?.id === "dsh-plugin-prompt-optimizer", String(contribution?.id));
const clientExports = contribution.factory((specifier) => {
  if (specifier === "react") return React;
  if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
  throw new Error(`unexpected require ${specifier}`);
});
check("client exports inject", Array.isArray(clientExports.inject), JSON.stringify(clientExports.inject));
check(
  "client inject list is the service names",
  clientExports.inject.join(",") === "remote,slots,locale,sessions,connection",
  clientExports.inject.join(","),
);
check("client exports apply", typeof clientExports.apply === "function");

await clientExports.apply(stubCtx);
check("remote contribution declared for $mount", loaded.length === 2 || loaded.some((entry) => entry?.package === "dsh-plugin-prompt-optimizer"));
const mounted = loaded.find((entry) => entry?.package === "dsh-plugin-prompt-optimizer");
const mountedDescriptor = mounted?.descriptors?.[0];
check("descriptor endpoint is promptOptimizer/optimize", mountedDescriptor?.id === "remote.promptOptimizer" && mountedDescriptor?.method === "optimize", String(mountedDescriptor?.id));
check("descriptor cancellation is the final signal", mountedDescriptor?.cancellation?.parameter === "signal");
check("every parameter codec is strict", mountedDescriptor?.parameters?.every((p) => p.codec?.mode === "strict"));
check("mounted descriptor carries a parse-able codec", typeof mountedDescriptor?.parameters?.[0]?.codec?.create?.().parse === "function");
check("slot registration received an id", registration?.descriptor?.id === "prompt-optimizer", String(registration?.descriptor?.id));
check("slot registration carries the service share", typeof registration?.descriptor?.inject === "function" && typeof registration.descriptor.inject().service === "function");
check("slot occupant is a component", typeof registration?.component === "function");

console.log(log.join("\n"));
console.log(`\n${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`} (${log.length} total)`);
process.exit(failed === 0 ? 0 : 1);
