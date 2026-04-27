# Live E2E Playbooks

These are Codex-operated live acceptance tests. They are intentionally separate from `npm run test` and CI because they need a real Codex thread and the local bridge running against live Codex state.

Use them when a bridge behavior needs proof from the full stack instead of a mocked integration test.

There are two verification surfaces:

- `store`: default. Verifies Codex -> bridge -> SQLite using a local provider, without Discord API inspection.
- `discord`: full-stack. Verifies Codex -> bridge -> SQLite -> Discord rendering through the Discord API.

## Human Input Contract

Group metadata in `manifest.json` is the source of truth for what the user must provide. `npm run e2e-live -- groups` prints each group with its required input, possible approvals, and what is not required.

Default local-store groups should not require follow-up messages, Discord inspection, browser use, manual channel IDs, or Discord API approval. They may still require local process approval because starting the bridge spawns `codex app-server`.

Use `start-local-current` for group runs. `prepare` updates `tmp/live-e2e/current-run.json`, so that command string stays stable across scenarios. If Codex asks for approval, choose session approval for `npm run e2e-live -- start-local-current` to reduce the local-store group to one start approval instead of one approval per scenario. `stop-current` is also stable if your sandbox asks for process-stop approval.

Discord-surface groups may require sandbox approval for networked Discord API calls, for starting the real bridge, and for cleanup. For Discord-surface runs, `prepare --surface discord` records a scoped Codex thread ID and writes `discovery.allowedThreadIds` into the temp config so the run-scoped bridge only discovers the runner thread. It also adds an e2e scope marker to Discord channels created by that run. Cleanup means `cleanup-current`: it stops the run-scoped bridge and runs mapped-only cleanup with that run's temp config/store and scope marker. `stop-current` only stops the process and leaves Discord categories/channels behind.

The `discord-basic` group intentionally covers only mechanically triggered actions: command summaries and file-edit summaries. `basic-message.commentary-*` scenarios are still available as individual checks, but they are not part of the fire-and-forget Discord group because Codex must emit the generated marker in an exact commentary update before verification.

The `approval-requests` group verifies response-control mirroring only. It uses subagents for command approval cards and proposed-plan controls; do not approve, reject, accept, or send feedback through the controls. The parent turn verifies the rendered Discord output, closes the subagent if needed, and then runs cleanup. The command-approval scenario does not require Discord buttons because Desktop subagent cards can be read-only, and already-resolved cards intentionally have no components.

## Contract For Codex

When asked to run a live e2e scenario:

1. read this file, `manifest.json`, and the scenario playbook
2. prepare the scenario with a unique run ID; for Discord-surface runs, confirm the output includes `Discovery scope`
3. use the stable current-run helper commands printed by `prepare`
4. start the bridge before performing the scenario action
5. run `npm run e2e-live -- verify ... --run-id <run-id>`
6. use `npm run e2e-live -- inspect-discord <run-id>` only for Discord-surface debugging or a manual channel override
7. run the cleanup command printed by `prepare`: `stop-current` for store-surface runs, `cleanup-current` for Discord-surface runs
8. report the scenario ID, run ID, marker, temp config path, temp store path, selected store thread or Discord channel/thread, inspect evidence, pass/fail result, and cleanup status

If the user asks to run tests only, report helper failures as they happen and do not debug them unless the user explicitly asks. Run the printed cleanup command before reporting the failure. Do not retry, inspect unrelated state, or run ad hoc diagnostic commands during a run-only pass.

Do not claim a scenario passed without inspect evidence from the helper.

Only `initial-user-message` scenarios accept a custom `--marker` from the user's initial request. For commentary, command, file-edit, subagent, and approval-request scenarios, do not pass `--marker` to `prepare`; use the generated marker printed by `prepare` and perform the scenario action with that exact marker.

Do not set `BRIDGE_CONFIG_PATH` or `STORE_PATH` by hand for live e2e runs. Do not use `Start-Process`. The helper starts child processes with the temp config/store and sanitizes duplicate Windows `Path`/`PATH` environment keys.

The helper also starts the bridge with `CODEX_MOBILE_LIVE_E2E_IGNORE_HELPER_COMMANDS=1`. That keeps `npm run e2e-live -- verify`, `inspect-discord`, `stop-current`, `cleanup-current`, and simple wait commands such as `Start-Sleep -Seconds 10` from being counted as scenario command activity while the bridge is under test.

For command and file-edit visibility scenarios, keep the bridge-observed window clean. Extra Codex shell commands or file edits while the bridge is running can change counts such as `Ran 2 commands` or `Created 1 file, ran 1 command`. If a scenario fails and the user only asked to run tests, run the printed cleanup command and report the helper output instead of debugging in the watched window.

For commentary scenarios, emit the generated marker as a standalone commentary update after the bridge is running. If the marker is missing from the helper evidence, report that the required commentary action was not observed; do not treat it as a Discord rendering failure without store evidence.

## Commands

List scenarios:

```powershell
npm run e2e-live -- groups
npm run e2e-live -- list
```

Print an autonomous group runbook:

```powershell
npm run e2e-live -- group autonomous-basic
```

Prepare a scenario:

```powershell
npm run e2e-live -- prepare basic-message.commentary-on --run-id 20260424-001
```

Prepare a full Discord check instead of the default store check:

```powershell
npm run e2e-live -- prepare basic-message.commentary-on --run-id 20260424-001 --surface discord
```

For Discord-surface runs, `prepare` auto-detects the current Codex thread from recent local Codex session files. If it cannot, it refuses to prepare an unscoped Discord run; pass `--thread-id <codex-thread-id>` only as an explicit fallback.

The helper writes:

- `tmp/live-e2e/<run-id>/bridge.config.json`
- `tmp/live-e2e/<run-id>/bridge.sqlite`
- `tmp/live-e2e/<run-id>/run.json`
- `tmp/live-e2e/current-run.json`

It copies only non-secret approval allowlist fields from the root `bridge.config.json`. Discord secrets stay in `.env`.

Start the bridge for the default local-store run:

```powershell
npm run e2e-live -- start-local-current
```

For a Discord-surface run, start the real Discord bridge:

```powershell
npm run e2e-live -- start-current
```

Verify the prepared run. For the default store surface, this reads only the temp SQLite store:

```powershell
npm run e2e-live -- verify basic-message.commentary-on --run-id 20260424-001
```

For a Discord-surface run, `verify` auto-selects the latest matching parent channel or child thread from the temp store, then inspects only that scoped Discord location. If auto-selection cannot identify the intended location, inspect mappings and pass the channel explicitly:

```powershell
npm run e2e-live -- inspect-discord 20260424-001
npm run e2e-live -- verify basic-message.commentary-on --run-id 20260424-001 --channel <discord-channel-or-thread-id>
```

## Cleanup

Stop the run-scoped bridge process:

```powershell
npm run e2e-live -- stop-current
```

Clean a Discord-surface run:

```powershell
npm run e2e-live -- cleanup-current
```

`stop-current` is process-only. It is correct for local-store scenarios, but it does not delete Discord categories/channels. `cleanup-current` stops the run-scoped bridge, then runs `clean --mapped-only` with the temp config and store from `run.json`. Mapped-only cleanup deletes only Discord channels inside the run's recorded e2e categories that carry the run's e2e scope marker, plus safe empty scoped categories; it does not delete normal live bridge channels even if a stale temp store contains one of their IDs.

To remove leftovers from previously prepared Discord-surface live e2e runs:

```powershell
npm run e2e-live -- cleanup-discord-runs
```

Most scenarios are isolated by temp config and store paths. Do not run cleanup against the normal store unless the scenario explicitly says to use existing state.

## Negative Assertions

Negative scenarios wait the configured timeout before passing. This catches late bridge updates. A negative scenario fails immediately if forbidden content appears in the scoped channel or thread.

Assertions are scoped to the channel or thread passed to `verify`; never scan the whole guild for a marker.

## User Message Scenarios

The `basic-message.user-*` scenarios use the initial user request that started the live test. They do not require a second user follow-up.

When preparing those scenarios, set `--marker` to an exact distinctive substring from the initial request, such as the group ID or a short phrase the user typed. The scenario enables startup backfill so the bridge can import that already-existing user message after it starts.

Do not use the initial request as the marker for `basic-message.commentary-*`, `commands.*`, `file-edits.*`, or `approvals.*`; those scenarios require the generated marker from `prepare`.

Example:

```powershell
npm run e2e-live -- prepare basic-message.user-on --run-id user-on-001 --marker autonomous-basic
```

Use a fresh Codex thread for group runs so the initial prompt is easy to identify and startup backfill stays small.

## Discord Inspection And Network Approval

The default store surface does not inspect Discord and should not need Discord API approval. It may still need local process approval for `npm run e2e-live -- start-local-current`, because that starts the bridge and the bridge starts `codex app-server`.

The Discord surface uses the Discord API. Its inspect and verify helpers are read-only with respect to Discord content, but they still perform network requests and launch the local Node inspect command. In a sandboxed Codex environment, `npm run e2e-live -- start-current`, `npm run e2e-live -- inspect-discord`, and Discord-surface `npm run e2e-live -- verify` may require network or local process approval.

Discord-surface `verify` still uses the temp SQLite store first. It waits for marker evidence in the run-scoped store, uses that to choose the exact Codex thread/channel, and when available requires the Discord message ID recorded for the current rendered item. The Discord API check is only the final rendered-output proof, not the primary scoping mechanism.

When approval is required, prefer session approval for the stable `npm run e2e-live` command family. Do not approve one-off commands that embed `$env:BRIDGE_CONFIG_PATH`, `$env:STORE_PATH`, or `Start-Process`; those are not the live e2e contract.

Do not use a browser, web search, or the Discord UI for normal verification. Use the helper commands and approve their Discord API network access when prompted.
