# dsh-jev-router

Optional Cordis plugin that chooses a concrete session model, then a reasoning effort for each main request, through the official `typesafe-ai/jev` evaluate API. Mount its bundle beside the Harness profile's model adapter, Session Controller, AgentLoop, and credentials plugins. The patch ships disabled. Enable it with a profile override and set `credentialRefs` to a Harness credential reference for a Vercel AI Gateway Bearer token. The plugin never reads an environment variable directly and never registers a generation adapter.

Terms are in [CONTEXT.md](CONTEXT.md) (Chinese). v1 scope is in [ROADMAP.md](ROADMAP.md). Host install, rollback, and acceptance are in [P0 acceptance](docs/p0-acceptance.md). Chinese prose is in [README.zh.md](README.zh.md).

## Host

Upstream DeepSeek Harness does not provide the selector events or the `configuration-update` block this plugin uses. Run it against [wendyeq/deepseek-harness](https://github.com/wendyeq/deepseek-harness) branch `local/jev-host` at `737a4c131e` or a descendant of that commit. Tests import the sibling checkout `../deepseek-harness`. Local tests do not replace a credentialed host smoke test.

## Shared effort policy

Automatic effort for `gpt-6-astra`, `gpt-6-luna`, and `gpt-6.1-sol` comes from the sibling `../jev-router-policy/src/index.ts`. Source files import that relative path. There is no `package.json` dependency and no machine-absolute path. `npm run build` copies the imported source into `dist/index.js`. The host loads that bundle, not the sibling directory. Editing the policy does nothing until the next build and the next process start. Pi loads the same file when its extension loads; this plugin does not.

## Selection

The model list adds `auto/jev`. The effort list adds `自动` (`auto/jev` internally).

On the first main request, automatic routing asks Jev to choose a session model among the configured automatic models that are registered right now, then asks for the lowest sufficient effort that exact model supports. After both succeed, the session model stays for that Session. Later main requests choose effort only. Selecting `auto/jev` again drops the previous session model. Changing task descriptions alone does not. A specified model stays as chosen, whether its effort is automatic or specified.

A child session does not choose its own session model. It uses the parent's concrete model and the parent's effort-selection method. An automatic parent that has not chosen a session model yet cannot supply one, and the child request fails. The session model and selection method are restored from an atomic per-Session sidecar. An evaluated effort is not a specified effort.

The first effort for a model route is the request-level effort (`reasoning.effort` on Responses, `reasoning_effort` on Chat Completions) and is kept in the sidecar. A later change on that same route appends one `configuration_update` before the next user message and does not rewrite the request-level effort, so the prefix before that item can still hit. The new effort stays in effect until the next update. Two updates are never placed next to each other. After compaction removes the previous one, the next request records a fresh update. Chat Completions has no `configuration_update` item, so a later effort is sent as a new `reasoning_effort`. Switching the concrete model starts a new cache context and a new request-level effort.

The first main request records an automatic-effort `model/selection` so the UI does not treat the concrete request effort as a fixed user choice. Older sessions record it on their next main request.

### What Jev sees

Only main requests ask Jev. Title and compaction are bypass requests: they use the concrete session model and that adapter's default effort, they do not ask Jev, and they do not choose a session model. With no session model they fail. Request headers and provider calls contain real registered routes, never selector ids.

Model selection sees at most the latest eight user and assistant text bodies. Effort selection may also include tool-result text, 1600 characters per result. System and developer prompts, tool arguments, reasoning blocks, and images are excluded. If the body would exceed its limit, the oldest whole messages are dropped first, never the latest user message. If that message alone still does not fit, its head and tail are kept and the middle is replaced with a marker stating how many of how many characters were omitted. The diagnostic log records only the number of dropped messages and omitted characters.

Effort selection also reports the effort last in effect for the same model route in this Session, when it is still offered. Jev can keep that effort unless there is a clear reason to change, and increase it for repeated failures, unresolved uncertainty, or a difficult next decision. This is the effort before the current decision, not its result. With no usable previous effort (usually the first main request), the field is omitted. Model selection never receives it. This does not change temporary-failure fallback.

### Failure, retry, and effort fallback

An empty user body, no usable automatic model or effort, an invalid answer, a missing credential, timeout, cancellation, or input that still does not fit after shortening (for example because an option description is too long) fails that request. The body limit is 28,000 UTF-8 bytes. A sole option is used without calling Jev.

Temporary failures wait one second and retry at most twice more (three calls total): HTTP 408, 429, 500, 502, 503, and 504, network errors, and an attempt timeout. Each attempt allows at most 5 seconds; the first attempt includes credential lookup. With the two waits, the ceiling is 17 seconds. A stalled credential lookup is not retried. Other HTTP 4xx responses, invalid answers, and a missing credential are not retried. A failed model selection does not switch to another model.

Effort falls back only after three temporary failures: use the last valid effort actually sent for that same model, or the adapter's supported default when there is no previous effort. If that default is below the configured floor, the floor is used. If no usable effort remains, the request fails. Effort fallback does not drop a session model that was already chosen.

## Configuration

`enabled` defaults to `false`. Enabling requires at least one `candidates` entry with `model` and `description` (optionally `provider`). That field name is the config key; these docs call the entries automatic models. Model ids are not fixed in code.

`effortDescriptions` maps a model id, or a more specific `provider/model`, to descriptions keyed by adapter effort id. Only levels the current adapter supports are offered. A level with no configured description uses the adapter's own description or name.

`effortFloors` uses the same keys for the lowest automatic effort. The adapter lists efforts from low to high; only that floor and the levels after it are offered. If only one remains, it is used without asking Jev. A floor the model does not support fails the request instead of being ignored. A specified effort is not affected.

Copy [`examples/jev-policy.patch.yml`](examples/jev-policy.patch.yml) into a private profile overlay, set a Harness credential reference, then set `enabled: true`. A dsh patch replaces the whole config, so overriding only `enabled` drops the policy. Description edits affect later evaluations only. They do not re-choose an existing session model.

`logDecisions` defaults to `false`. In a test profile, `true` logs the Session id, question, attempt, HTTP status, duration, chosen effort, temporary-failure reason, and fallback source through the Harness logger. It does not record message text, request bodies, or credentials, and it does not write the Session log. An absolute `diagnosticLogFile` appends the same redacted events as JSONL (new files are mode `0600`). The file is not rotated; delete it after triage. A write error warns and does not fail generation.

`credentialRefs` defaults to an empty list. More than one option requires at least one reference. `stateDirectory` defaults to `~/.dsh-jev-router/sessions` and must be absolute. `maxBodyBytes` and `timeoutMs` may be lowered, not raised past the v1 ceilings. Keep a Session's sidecar with its Session log. Installations that reuse Session ids should not share a state directory.

## Inspection and cost

The plugin appends a private `<session-id>.ledger.jsonl` (mode `0600`) per Session in the state directory. Each Jev evaluation records its question, outcome, chosen model or effort, attempts, duration, token counts, and gateway-reported cost. Each effort fallback gets its own record. It never records conversation text, request bodies, or credentials. Write errors warn without failing generation. Set `ledger: false` to disable it. On start, the plugin writes the automatic models, effort descriptions, and floors actually in use to `_policy.json`.

A successful evaluation also records gateway choice probabilities in `probabilities`. `probabilityStatus` is `available`, `missing`, or `invalid`. A distribution is kept only when it covers exactly the offered keys, every value is in 0–1, and the sum is within a two-decimal rounding tolerance. It is not renormalized. Missing or invalid probabilities do not change the choice and do not cause a retry. Older ledger lines without probabilities count as missing. A single option skips evaluation and has no probabilities. `show`'s `probabilityDecisions` lists each successful evaluation's distribution, top choice, runner-up, and `margin`. These figures are for inspection only. They are not a task success rate and they do not raise or lower effort.

The repository ships the `dsh-jev-router-inspect` skill. It reads these files and the Harness session log to show a Session's selection, effort distribution, fallbacks, failure reasons, and cost, and it can ask Jev on demand whether to keep the current model or open a new session with another. It only suggests; it never switches models. Install it into `~/.agents/skills` (which dsh also reads):

```bash
npx skills add wendyeq/dsh-jev-router --skill dsh-jev-router-inspect -g
```

The on-demand switch check needs `AI_GATEWAY_API_KEY` and costs one evaluation. Reading compressed session logs needs the `zstd` command.

## Generation

The first automatic route is two small Jev evaluate calls. Each later main request is one effort call. A sole option needs no call. These calls use the user's gateway quota, not the selected model's provider tokens. Generation uses the selected adapter and its normal token accounting and KV cache. Switching the concrete model starts a new provider cache context. A later effort change keeps the request-level effort, and on Responses adds a `configuration_update`, so the prefix before that item can still hit. Selector values never reach the adapter.

## Limits

This version does not watch for a better model in the background (the skill checks on demand), auto-load skills, split an oversized evaluation into pieces and merge them, retry more than twice, or share one time budget across evaluations. Per-Session sidecars need shared durable storage when a Session moves to another host. Session selection and provider-call headers are durable in Harness. Task-description updates affect future evaluations only.
