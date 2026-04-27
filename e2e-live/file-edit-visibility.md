# File Edit Visibility Live E2E

This playbook covers file edit visibility branches. Edits must target ignored temp files under `tmp/live-e2e/<run-id>/` so the test does not dirty tracked source files.

## Setup

1. Run `npm run e2e-live -- prepare <scenario-id> --run-id <unique-run-id>`.
2. Start the local-store bridge with `npm run e2e-live -- start-local-current`.
3. Verify with `npm run e2e-live -- verify <scenario-id> --run-id <unique-run-id>`.
4. Keep the bridge process running until verification and cleanup are complete.

Do not set temp environment variables by hand, and do not use `Start-Process`. The live e2e helper owns the temp config/store environment. `prepare` updates `tmp/live-e2e/current-run.json`, so `start-local-current` stays stable across scenarios for session approval. Use `prepare --surface discord` only when you explicitly need Discord API/rendering proof.

If the user asked to run tests only, do not debug a failure while the bridge is still running. Stop the run-scoped bridge and report the helper output. Extra shell commands or file edits during this playbook change the activity summary and can invalidate the scenario.

## File Edit Action

Create or update this ignored file through Codex file editing:

```text
tmp/live-e2e/<run-id>/file-edit-<marker>.txt
```

Write the marker into the file body. Do not edit tracked files for these scenarios.

For `file-edits.summary-with-command`, also run this command through Codex:

```powershell
Write-Output "<marker> file-edit-command"
```

## Scenarios

### `file-edits.off`

Purpose: prove file edits are suppressed when `visibility.fileEdits` is `false`.

Pass: the scoped channel contains neither the marker nor `file-edit` for the full timeout.

### `file-edits.full`

Purpose: prove file edit entries mirror when `visibility.fileEdits` is `true` and command summaries are disabled.

Pass: the scoped channel contains the marker and `file-edit`, and does not contain `Ran 1 command`.

### `file-edits.summary-with-command`

Purpose: prove file edits and commands fold into the activity summary when both surfaces are visible and `ui.commandDisplayMode` is `summary`.

Pass: the scoped channel contains `Created 1 file, ran 1 command` and does not contain the raw marker.
