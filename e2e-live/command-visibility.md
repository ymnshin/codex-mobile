# Command Visibility Live E2E

This playbook covers command visibility config without testing every unrelated visibility toggle.

## Setup

1. Run `npm run e2e-live -- prepare <scenario-id> --run-id <unique-run-id>`.
2. Start the local-store bridge with `npm run e2e-live -- start-local-current`.
3. Verify with `npm run e2e-live -- verify <scenario-id> --run-id <unique-run-id>`.
4. Keep the bridge process running until verification and cleanup are complete.

Do not set temp environment variables by hand, and do not use `Start-Process`. The live e2e helper owns the temp config/store environment. `prepare` updates `tmp/live-e2e/current-run.json`, so `start-local-current` stays stable across scenarios for session approval. Use `prepare --surface discord` only when you explicitly need Discord API/rendering proof.

If the user asked to run tests only, do not debug a failure while the bridge is still running. Stop the run-scoped bridge and report the helper output. Extra shell commands during this playbook change the command count and can invalidate the scenario.

## Command Actions

Run commands through Codex tool execution, not manually in an outside terminal. The bridge needs to observe Codex command events.

For normal command scenarios, run two separate Codex shell tool calls:

```powershell
Write-Output "<marker> command-one"
```

```powershell
Write-Output "<marker> command-two"
```

For `commands.full-details`, use two separate Codex shell tool calls with longer command text:

```powershell
Write-Output "<marker> command-one with enough trailing text to force truncation"
```

```powershell
Write-Output "<marker> command-two with enough trailing text to force truncation"
```

## Scenarios

### `commands.off`

Purpose: prove command events are suppressed when `visibility.commands` is `false`.

Pass: the scoped channel contains neither the marker nor `Ran 2 commands` for the full timeout.

### `commands.summary`

Purpose: prove command events collapse to a count when `visibility.commands` is `true` and `ui.commandDisplayMode` is `summary`.

Pass: the scoped channel contains `Ran 2 commands` and does not contain the raw marker or `Cmd 1`.

### `commands.full`

Purpose: prove full mode mirrors raw command previews without details when `enableCommandDetails` is `false`.

Pass: the scoped channel contains the marker and `Write-Output`, and does not contain `Ran 2 commands` or `Cmd 1`.

### `commands.full-details`

Purpose: prove long command previews expose command detail buttons when full mode and details are enabled.

Pass: the scoped channel contains `Write-Output` and a `Cmd 1` component, and does not contain `Ran 2 commands`.
