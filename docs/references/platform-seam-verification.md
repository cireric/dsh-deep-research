# Platform-Seam Verification — `dsh-deep-research-hybrid`

Independent re-verification of the spec's platform-API claims against the actual
DeepSeek Harness source at `D:\Project\source\__TEST__\deepseek-harness`.
Every claim is checked against real source lines. **No source or spec file was modified.**

Verdict legend: **HOLDS** (claim correct), **NEEDS-REVISION** (claim wrong/outdated),
**CANNOT-DETERMINE** (source insufficient to judge).

---

## 1. Service names & injection: `['tools', 'workflowEngine', 'jobs']`

**Verdict: HOLDS**

- (a) `ctx.workflowEngine` is the real service name — NOT `ctx.workflows`.
  - `packages/workflow/workflow/src/index.ts:31-34` — `interface Context { workflowEngine: WorkflowEngine }`.
  - `packages/workflow/workflow/src/index.ts:159` — `super(ctx, 'workflowEngine')`.
- (b) `ctx.jobs` is a real service.
  - `packages/jobs/jobs/src/index.ts:29-32` — `interface Context { jobs: JobRegistry }`; `:70` `super(ctx, 'jobs')`.
- (c) `ctx.tools` is real (used by every tool plugin as `inject: ['tools', ...]`).
  - `packages/workflow/tool-workflow/src/index.ts:30` — `export const inject = ['tools', 'workflowEngine', 'systemPrompt']`.
  - `packages/jobs/tool-jobs/src/index.ts:22` — `export const inject = ['tools', 'jobs', 'systemPrompt']`.
  - `packages/web/tool-web/src/index.ts:24` — `export const inject = ['tools', 'web', 'systemPrompt']`.

Note: the spec itself already corrects the upstream `ctx.workflows` mistake
(spec line 18, 75, 265). The plugin's `inject: ['tools', 'workflowEngine', 'jobs']`
is valid.

---

## 2. `ctx.workflowEngine.start(...)` signature & return shape

**Verdict: HOLDS** (spec's shape is correct; actual return also carries `agentsStarted` + optional `error`)

- Request shape matches the spec exactly:
  - `packages/workflow/workflow/src/runtime-types.ts:19-34` —
    `interface WorkflowStartRequest { script; meta; args?; subagentProvider?; maxTotalAgents?; parent: Agent; signal? }`.
    Spec's `{ script, meta, args, parent, signal, subagentProvider?, maxTotalAgents? }` is a perfect match.
- Return shape:
  - `packages/workflow/workflow/src/runtime-types.ts:40-49` —
    `interface WorkflowRun { readonly result: Promise<WorkflowResult>; cancel(reason?): void; dispose(): Promise<void> }`.
  - `packages/workflow/workflow/src/types.ts:72-87` —
    `interface WorkflowResult { value: unknown; stopReason: WorkflowStopReason; error?; agentsStarted: number }`.
    Spec claims `result` resolves to `{ stopReason, value }` — both fields exist; the run also exposes `agentsStarted` and an optional `error`. `WorkflowStopReason = 'completed' | 'cancelled' | 'error'` (types.ts:63).

---

## 3. Script sandbox globals (`agent / parallel / pipeline / phase / log / args`, NO fs/network/Node)

**Verdict: HOLDS**

- `packages/workflow/workflow-worker-thread/src/runtime.ts:98-113` — the `vm.createContext` globals object:
  ```js
  const globals = { agent, parallel, pipeline, phase, log, args }
  ```
  These are the ONLY globals placed on the contextified global; no `fs`, `net`, `http`, `fetch`, `process`, `Buffer`, `setTimeout`, or any Node module is injected.
- `packages/workflow/tool-workflow/src/index.ts:150` — the model-facing contract states:
  "no filesystem, network, timers, or Node.js APIs are provided — the agents do the work, the script only coordinates them."
- Sandbox is explicitly containment, not a security boundary, but for the purpose of the claim (the script cannot itself read disk / call web tools) it HOLDS.

---

## 4. `agent()` call options: `{ label, phase, schema, provider, model }`; `effort`/`isolation`/`agentType` NOT supported

**Verdict: HOLDS**

- `packages/workflow/workflow-worker-thread/src/runtime.ts:39-41`:
  ```js
  const SUPPORTED_AGENT_OPTIONS = new Set(['label', 'phase', 'schema', 'provider', 'model'])
  const DEFERRED_AGENT_OPTIONS = new Set(['effort', 'isolation', 'agentType'])
  ```
- `:368-374` — validation rejects unknown/deferred options:
  ```js
  if (DEFERRED_AGENT_OPTIONS.has(key)) {
    throw new WorkflowError(`agent() option "${key}" is deferred and not supported by this engine ...`, 'UNSUPPORTED_OPTION')
  }
  throw new WorkflowError(`agent() option "${key}" is not recognized ...`, 'UNSUPPORTED_OPTION')
  ```
- `:379-397` — readAgentOptions returns only `{ label, phase, provider, model, schema }`.
- The model-facing tool description (`tool-workflow/src/index.ts:143`) repeats: "Anything else (`effort`/`isolation`/`agentType`) is rejected loudly."

---

## 5. `maxItemsPerCall` / `ITEM_CAP` hard cap on a single `parallel()`/`pipeline()` call

**Verdict: HOLDS**

- Config knob + default value:
  - `packages/workflow/workflow-worker-thread/src/index.ts:39-40` — `maxItemsPerCall?: number` ("Items accepted by a single `parallel()`/`pipeline()` call").
  - `:119` — `maxItemsPerCall: z.natural().min(1).default(4096)`.
  - `packages/workflow/workflow-worker-thread/src/types.ts:21-22` — `maxItemsPerCall: number` in `WorkerLimits`.
- Enforcement + fatal error:
  - `packages/workflow/workflow-worker-thread/src/runtime.ts:406` (`parallel`) and `:433` (`pipeline`) both call `this.assertItemCap(...)`.
  - `:460-467`:
    ```js
    private assertItemCap(length, hook) {
      if (length > this.limits.maxItemsPerCall) {
        throw new WorkflowError(`${hook} received ${length} items — over the per-call cap (${this.limits.maxItemsPerCall}) ...`, 'ITEM_CAP')
      }
    }
    ```
  - `ITEM_CAP` is a fatal `WorkflowErrorCode` (`packages/workflow/workflow/src/index.ts:115`) and fatal errors re-throw through combinators (`:124-139`, `isFatalWorkflowError`).
  - Constant name + value: **config field `maxItemsPerCall`, default `4096`**; **error code `ITEM_CAP`** (from `WorkflowErrorCode`).
- This confirms the spec's batching design (spec §健壮性/状态机: slice size = `min(maxParallel, maxItemsPerCall)`).

---

## 6. `ctx.jobs.start(...)` shape: `run: () => JobHooks` where `JobHooks ≈ { cancel, done, readOutput }`, plus `kind`, `label`, `owner`

**Verdict: HOLDS** (`readOutput` is optional, `owner` must be the live registered agent)

- `packages/jobs/jobs/src/types.ts:46-69` — `interface JobStart { kind: JobKind; label: string; outputLimitBytes?; owner?: Agent; run(): JobHooks }`.
- `:72-91` — `interface JobHooks { cancel(reason?): void; done: Promise<JobOutcome>; readOutput?(): string }`.
  Note: `readOutput` is OPTIONAL (the spec writes `readOutput()` — correct as optional).
- `owner` must be a LIVE registered agent:
  - `packages/jobs/jobs-local/src/index.ts:448-456` — `ensureOwnerCleanup`:
    ```js
    const agents = this.selfCtx.get('agents')
    if (agents === undefined) throw new Error('background job ownership requires the agent registry ...')
    if (agents.get(ownerId) !== owner) throw new Error(`agent "${ownerId}" is not the registered agent instance ...`)
    ```
  - Spec's `owner: exec.agent` (spec line 121) is correct as long as `exec.agent` is the live registered instance.

---

## 7. `JobKindMap` declaration merging → `kind: 'deep-research'` + `deep-research-N` id

**Verdict: HOLDS** (spec's module path `@deepseek-ai/dsh-jobs` is correct)

- `JobKindMap` exists and is merge-extensible:
  - `packages/jobs/jobs/src/types.ts:23-29` —
    ```ts
    export interface JobKindMap { bash: 'bash'; subagent: 'subagent' }
    export type JobKind = JobKindMap[keyof JobKindMap]
    ```
- The spec's augmentation path matches the convention used by every real producer plugin:
  - `packages/shell/tool-pwsh/src/index.ts:42-46` —
    ```ts
    declare module '@deepseek-ai/dsh-jobs' {
      interface JobKindMap { pwsh: 'pwsh' }
    }
    ```
  - Same pattern in `packages/terminal/tool-terminal/src/index.ts:18`, `packages/jobs/jobs-local/tests/jobs.spec.ts:12`, `packages/examples/agent-spine-demo/tests/agent-core.spec.ts:34`.
  - `@deepseek-ai/dsh-jobs` re-exports `JobKindMap` (`packages/jobs/jobs/src/index.ts:18-20`), so augmenting `@deepseek-ai/dsh-jobs` merges correctly.
- Id prefix `deep-research-N`:
  - `packages/jobs/jobs-local/src/index.ts:151-153` —
    ```js
    const count = (this.counters.get(spec.kind) ?? 0) + 1
    const id = JobId(`${spec.kind}-${count}`)
    ```
  With `kind: 'deep-research'`, the id is `deep-research-1`, `deep-research-2`, … (spec's `deep-research-N` is correct).

**Minor correction (not a failure):** the interface is *declared* in `@deepseek-ai/dsh-jobs/types` and *re-exported* by `@deepseek-ai/dsh-jobs`. Augmenting `@deepseek-ai/dsh-jobs` (as the spec does) works because of that re-export, so the spec's `declare module '@deepseek-ai/dsh-jobs'` is correct. (Do NOT change it to `@deepseek-ai/dsh-jobs/types` — every shipped producer uses the main module path.)

---

## 8. Background job notification & `readOutput` (open item ①)

**Verdict: HOLDS**

- Completion notification is delivered to the owning session via the `onJobDone` listener, which the job *controller* plugin (`tool-jobs`) installs — NOT via a workflow event:
  - `packages/jobs/tool-jobs/src/index.ts:279-300` —
    ```js
    ctx.jobs.onJobDone((snapshot, owner) => {
      if (snapshot.reported || owner === undefined) return
      const message = createUserMessage({ ... source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice', ... } })
      ... owner.followup(message)   // idle owner → opens a turn
      ... owner.inject(message)     // busy owner → injected into next step
    })
    ```
  - i.e. completion reaches the owner as a session message (notice); under default `wakeup` delivery an idle owner is woken.
- Settlement also fires `onJobsChanged` / the registry's `settle()` (jobs-local `:416-440`) which notifies listeners then.
- `readOutput` returns accumulated progress text:
  - `packages/jobs/jobs/src/types.ts:85-90` — `readOutput?(): string` ("Consume output produced since the previous call").
  - `packages/jobs/jobs-local/src/index.ts:205-213` — `read()`:
    ```js
    const text = job.readOutput !== undefined ? job.readOutput() : isTerminal(job.status) ? job.output ?? '' : ''
    ```
    So for a stream job it returns the producer's accumulated delta; for a final-output job it returns the terminal `output`.
  - Spec's `readOutput: () => drainProgressBuffer()` (fed by `workflow/phase|log`) is a valid producer-side implementation; the spec's recorder pattern (`deep-research/*` session events) is a separate plugin-side choice and is also supported (tool-jobs/tool-workflow show the event-recording pattern).

---

## 9. Subagent tool world & `web_fetch` availability (open item ②)

**Verdict: HOLDS — `web_fetch`/`web_search` ARE available to workflow sub-agents by default; adding tools is a provider/composition concern, not a script concern**

- A workflow `agent()` call bridges to the host subagent provider with ONLY `{ prompt, parent, signal, outputSchema?, agentOptions?{provider?,model?} }` — it passes **no `toolFilter`**:
  - `packages/workflow/workflow-worker-thread/src/host.ts:349-365` — `startChild` builds the request with no `toolFilter`.
- A workflow child therefore inherits the provider's default tool world. In-process providers (`spawn`, `fork`) compose the child from the *parent's preset* and apply a tool restriction ONLY when one is supplied:
  - `packages/subagent/agent/src/child-agent.ts:168` — `childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx)`.
  - `:174` — `if (composition.toolFilter !== undefined) childCtx.tools.restrict(composition.toolFilter)`.
  - Since the workflow engine never sets `toolFilter`, no restriction is applied → the child sees the parent's full global tool registry.
- Global tools registered in the host composition (e.g. `web_search`/`web_fetch` from `tool-web`, `packages/web/tool-web/src/index.ts:24,91-94`) are therefore visible to workflow sub-agents **by default**, provided `tool-web` is loaded in the composition.
- To ADD a writable tool for `rawNotes`: it cannot be done from inside the workflow script (the script has no tool surface). It must be configured at the composition level — either the provider's default world already includes it, or via a `tool-subagent` instance's `toolFilter`/`agentOptions` config (`packages/subagent/tool-subagent/src/index.ts:59-68, 94-97, 392`). The workflow engine does not forward any such filter, so the workflow author controls tool availability only indirectly (by choosing `subagentProvider` and by what that provider's composition exposes).
- Consequence for spec B1: the verifier sub-agent WILL have `web_fetch` if `tool-web` is loaded in the composition (the common deployment). The spec's `rawNotes` enhancement likewise depends on the provider default world, not on the script. This matches the spec's own open-item-② analysis (spec lines 194-196, 274).

---

## 10. `jobs-local` provides the `ctx.jobs` implementation (dependency)

**Verdict: HOLDS**

- `@deepseek-ai/dsh-jobs-local` registers `ctx.jobs`:
  - `packages/jobs/jobs-local/src/index.ts:91` — `export class LocalJobRegistry extends JobRegistry`.
  - `:123-128` — `constructor(ctx, config) { super(ctx); ... ctx.effect(() => () => this.disposeAll(), 'jobs teardown') }`. `super(ctx)` → `JobRegistry` → `super(ctx, 'jobs')` (jobs/index.ts:70).
- The abstract `@deepseek-ai/dsh-jobs` refuses to load on its own:
  - `packages/jobs/jobs/src/index.ts:67-69` — throws "load an implementation such as @deepseek-ai/dsh-jobs-local instead".
- If `jobs-local` (or another `JobRegistry` impl) is NOT loaded, `ctx.jobs` is absent:
  - `packages/subagent/tool-subagent/src/index.ts:409-412` — background mode guards with `const jobs = ctx.get('jobs'); if (jobs === undefined) throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')`.
  - `packages/jobs/jobs-local/src/index.ts:132-134` — `start()` throws "no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)" when no controller is attached (so even a producer needs `tool-jobs` mounted to serve its owner).
  - Spec's Out-of-Scope (lines 230, 253) requiring the composition to load `jobs-local` (and `tool-jobs`) is correct; the deep-research plugin must degrade to foreground or error when `ctx.jobs` is absent.

---

## 11. NEW discrepancies / outdated platform assumptions in the spec

**Verdict: NEEDS-REVISION (minor items) — most claims are correct; the following are clarifications/corrections**

1. **`readOutput` is optional, not required.** Spec writes `readOutput: () => drainProgressBuffer()` as if required (spec lines 129, 134). Source: `JobHooks.readOutput?(): string` (jobs/types.ts:90). It is correct to provide it, but a producer may omit it (a final-output job does). No code change needed, but the spec wording should not imply mandatory.

2. **`done` produces `JobOutcome`, whose `status` is `'completed' | 'killed' | 'failed'`.** Spec line 128 maps `run.result.stopReason` (`'completed'|'cancelled'|'error'`) into `JobOutcome.status` (`'completed'|'killed'|'failed'`). This is a valid producer-side mapping, but note there is NO `'cancelled'` terminal status in `JobStatus`/`JobOutcome.status` — cancelled runs surface as `killed` (jobs/types.ts:17, 33-34). The spec's suggestion to "extend to `cancelled`" (spec line 109) is NOT supported by the type union; a cancelled research job settles as `killed` (or the producer maps `cancelled`→`killed`). **The spec should drop the optional `cancelled` `status` value and use `killed`.**

3. **Job `status` lifecycle words differ from the spec's payload `status`.** `JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'` (jobs/types.ts:17). The spec's compact payload uses `completed|degraded|failed` (+ optional `cancelled`) — these are the plugin's OWN vocabulary layered on top, which is fine, but the mapping from `jobs` lifecycle to payload must go `killed`→(`failed` or `degraded`/`cancelled` as the plugin prefers); the plugin must not assume a `cancelled` status exists in `ctx.jobs`.

4. **`owner` is not "owner id" — it is the live `Agent` instance.** Spec line 121 `owner: exec.agent` is correct, but the spec's prose ("owner 销毁即取消/结算", "owner 域 fence") should be read as *the live agent instance*, not an id string. `JobStart.owner?: Agent` (jobs/types.ts:62). The registry fences by `owner.id` (session id) and requires the exact registered instance (jobs-local `:454-456`).

5. **`subagentProvider` default is `'spawn'`.** Spec relies on the workflow engine's provider; the engine default is `spawn` (`packages/workflow/workflow-worker-thread/src/index.ts:116` — `provider: z.string().default('spawn')`). If a deployment uses a different provider name, the deep-research plugin must pass `subagentProvider` explicitly or the engine throws `AGENT_START` ("no subagent provider registered", worker-thread/index.ts:85-87). Confirm the target composition actually registers `spawn`.

6. **`WorkflowResult.value` is `null` for a valueless script**, not `undefined`** (types.ts:73-74). The spec's return contract is fine, but any host-side check should test `value === null`, not `value === undefined`.

7. **No `tools` surface inside the workflow script** (claim 3) means the spec's `rawNotes` writable-tool enhancement for research sub-agents (spec line 159) is achievable ONLY if the chosen `subagentProvider`'s composition already exposes a writable tool — the workflow script cannot grant it. This is consistent with claim 9, and the spec already flags it as open. No contradiction, but reaffirm: tool availability for children is a composition-level fact, not script-controlled.

---

# SUMMARY

**HOLD (correct as written):**
- Claim 1 — service names `workflowEngine` / `jobs` / `tools` are real; `workflowEngine` (not `workflows`) confirmed.
- Claim 2 — `start({ script, meta, args, parent, signal, subagentProvider?, maxTotalAgents? })` and `WorkflowRun { result, cancel, dispose }` confirmed.
- Claim 3 — script sandbox exposes only `agent/parallel/pipeline/phase/log/args`; no fs/network/Node APIs.
- Claim 4 — `agent()` supports `label/phase/schema/provider/model`; `effort/isolation/agentType` are rejected (`UNSUPPORTED_OPTION`).
- Claim 5 — hard `ITEM_CAP` cap; config `maxItemsPerCall` default **4096**; error code `ITEM_CAP` (fatal).
- Claim 6 — `JobStart { run(): JobHooks }`, `JobHooks { cancel, done, readOutput? }`, `owner` required to be live registered agent.
- Claim 7 — `JobKindMap` merge-extensible at `@deepseek-ai/dsh-jobs`; `kind: 'deep-research'` → id `deep-research-N` (spec's module path is correct).
- Claim 8 — completion delivered to owner via `onJobDone` (session notice); `readOutput()` returns accumulated stream text.
- Claim 9 — `web_fetch`/`web_search` available to workflow sub-agents by default (no `toolFilter` passed); adding tools is composition/provider-level, not script-level.
- Claim 10 — `jobs-local` registers `ctx.jobs`; absent → plugin must degrade/error (needs `tool-jobs` controller too).

**NEED REVISION (corrections to apply):**
- (11.2 / spec line 109) There is **no `'cancelled'` terminal status** in `JobStatus`/`JobOutcome.status`; cancelled runs settle as `killed`. Drop the optional `cancelled` `status` value from the payload contract; map engine `cancelled` → `killed` (or the plugin's own `failed`/`degraded`).
- (11.1) `readOutput` is **optional**, not required — soften the spec's wording.
- (11.4) `owner` is the **live `Agent` instance** (fenced by session id + exact-instance check), not an id string.
- (11.5) Confirm the target composition registers the `spawn` provider (engine default) or pass `subagentProvider` explicitly, else `start()` throws `AGENT_START`.
- (11.6) `WorkflowResult.value` is `null` (not `undefined`) for a valueless script.

**CANNOT DETERMINE:**
- None. Every claim was resolvable from the cited source.
