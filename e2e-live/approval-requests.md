# Approval Response Live E2E

This playbook verifies that Codex requests for a user response are mirrored into Discord. It does not verify pressing Discord buttons.

The response request must come from a spawned subagent so the parent Codex turn can continue to verify and clean up while the subagent is blocked or independently resolved.

## Setup

1. Run `npm run e2e-live -- prepare <scenario-id> --run-id <unique-run-id>`.
2. Confirm prepare prints `Surface: discord` and `Discovery scope`.
3. Start the Discord bridge with `npm run e2e-live -- start-current`.
4. Spawn the subagent described by the scenario below.
5. Verify with `npm run e2e-live -- verify <scenario-id> --run-id <unique-run-id>`.
6. Close the spawned subagent whether verification passes or fails if it is still open.
7. Clean the run with `npm run e2e-live -- cleanup-current`.

Do not approve, reject, accept, or send feedback through the mirrored controls. The pass condition is that the card or controls are stored and rendered in Discord.

## Scenario: `approvals.command-request`

Purpose: prove a real subagent command approval request is mirrored to Discord.

Pass: the scoped child Discord thread contains the marker, `Type: Command execution`, and `Preview:`.

The scenario does not require approve/reject buttons or detail buttons. Codex Desktop subagent approvals may legitimately render read-only until the subagent chat is opened in Desktop, and already-resolved cards may have no components.

### Subagent Action

Spawn one subagent with this instruction, substituting the generated marker:

```text
Request approval for exactly one harmless PowerShell command, then stop and wait. Use the shell tool with sandbox_permissions=require_escalated. The command must be:
Write-Output "<marker> approval-request"
Use the approval justification: "Allow this live e2e approval-card mirroring check?"
Do not run any other commands and do not produce a final answer after requesting approval.
```

The command inside the subagent approval request is:

```powershell
Write-Output "<marker> approval-request"
```

Use the generated marker printed by `prepare`; do not pass a custom marker to this scenario.

Do not call `wait_agent`. The subagent may block on the approval request. Keep the parent turn free to run verification and cleanup.

## Scenario: `approvals.proposed-plan-card`

Purpose: prove a real subagent proposed plan is mirrored to Discord with the plan response controls governed by `approvals.allowFromDiscord`.

Pass: the scoped child Discord thread contains the marker and component labels `Accept plan` and `No, and tell Codex what to do differently`.

This verifies rendering only. Do not accept the plan and do not submit feedback from Discord.

### Subagent Action

Spawn one subagent with this instruction, substituting the generated marker:

```text
Reply with exactly one final answer containing this proposed plan block and no other text:
<proposed_plan>
# <marker> proposed-plan

- Keep this as a harmless live e2e plan-card mirroring check.
</proposed_plan>
Do not run tools.
```

Use the generated marker printed by `prepare`; do not pass a custom marker to this scenario.

The subagent can finish normally. The parent turn can wait for the final answer if needed, then run verification and cleanup.
