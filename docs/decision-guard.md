# Decision Guard

Decision Guard suggests unreviewed decisions from stored source excerpts. A model response or merged pull request cannot approve policy. Start with the [README](../README.md) or [public repository setup](public-evidence-workspace.md).

## Use the local workflow

1. Start the intended workspace and open `http://127.0.0.1:3050/settings/meta`. Enter a key in the masked form, choose an existing agent principal and save. The agent needs contributor and current repository access; selecting it grants no permissions.
2. Sign in as a human, open a project and choose **Decision Guard: suggest decisions with Meta**. Select a readable repository, exact branch, UTC validity interval and revision-pinned sources. Optional comparison decisions must have identical active applicability.
3. Click **Extract with Meta**. This explicit action sends selected text to the provider. Inspect each suggestion, supporting quotation and possible-conflict hint. Reloading a saved run makes no new model request.
4. Choose a new decision or explicit replacement target and **Save pending proposal**. The configured agent authors the proposal; the requesting human owns it. A conflict hint alone never chooses a replacement.
5. An authorized human who authored none of the proposal's revisions approves or rejects the exact version. Pending and rejected proposals do not retire approved guidance.

## Validation and provenance

Input and responses are bounded and validated against strict schemas. Supporting quotes must match exact UTF-16 `[start,end)` spans in the selected source text. Conflict hints may reference only supplied approved IDs and revisions. Exact quotations establish that text exists; human review must assess whether it supports the suggestion.

Runs retain immutable source/scope snapshots, prompt/input/output hashes, provider/model identifiers and usage when reported. Requester and agent access are checked before dispatch and persistence. All model-context sources remain access dependencies, including uncited sources and evidence behind comparison decisions.

Publishing a candidate creates an agent-authored pending proposal. Model-linked proposals cannot be edited to remove provenance dependencies; reject and regenerate corrections. Repeating the same publication selection is idempotent. Scoped drafts retain the reviewed repository, branch and validity interval; legacy unscoped records remain excluded from [scoped agent context](agent-context.md).

## Credentials and request limits

The settings form keeps the key in server memory until exit; it never returns the key or writes it to browser storage or the database. Saving configuration makes no request. **Forget key** prevents future dispatch and withholds in-flight output if configuration changed; it cannot retract data already sent.

Optional startup configuration uses `MODEL_API_KEY`, `MEMORYNET_META_AGENT_ID` and `MEMORYNET_META_MAX_REQUESTS`. `npm run app` reads ignored `.env.local` when present. The request allowance is an integer from 1 to 20, default 5, and counts failed dispatches. Key changes do not refill it; restart creates a new allowance. It is neither durable billing enforcement nor a monetary cap.

Completion allowance is 2,048 tokens by default, with an explicit 4,096 option. A blank key retains existing configuration when changing this limit. The adapter has a timeout, bounded response size, redirect refusal, exact-model validation and no automatic retries. Token exhaustion, refusal, malformed envelopes and citation failures are reported separately.

The local runtime uses the endpoint and model configured in `src/decision-guard/openai-compatible-meta.ts` and `runtime.ts`. Source content and tool arguments cannot override credentials, endpoint or model. The library adapter is disabled unless explicitly enabled; the web runtime enables extraction after operator configuration. Verify provider availability, pricing and data-use terms before sending permitted public or synthetic material.

Failure diagnostics contain only allowed codes, safe identifiers and timing/remaining-attempt metadata. They omit prompts, raw responses, credentials and exception causes. Unknown usage or cost remains unknown.

## Check the implementation

```sh
npm run check
```

Provider tests inject HTTP responses and make no live model requests. The app remains a local prototype; see [security boundaries](../SECURITY.md).
