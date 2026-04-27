# Basic Message Live E2E

This playbook covers the config branches for user, commentary, and final assistant message visibility.

The `basic-message.user-*` scenarios use the initial user request that started the live test. They do not require a second user follow-up. Prepare them with `--marker` set to an exact distinctive substring from that initial request.

## Setup

1. Run `npm run e2e-live -- prepare <scenario-id> --run-id <unique-run-id>`.
2. Start the local-store bridge with `npm run e2e-live -- start-local-current`.
3. Verify with `npm run e2e-live -- verify <scenario-id> --run-id <unique-run-id>`.
4. Keep the bridge process running until verification and cleanup are complete.

Do not set temp environment variables by hand, and do not use `Start-Process`. The live e2e helper owns the temp config/store environment. `prepare` updates `tmp/live-e2e/current-run.json`, so `start-local-current` stays stable across scenarios for session approval. Use `prepare --surface discord` only when you explicitly need Discord API/rendering proof.

## Scenarios

### `basic-message.user-on`

Purpose: prove real user messages mirror when `visibility.userMessages` is `true`.

Action:

1. Prepare with `--marker` set to an exact distinctive substring from the initial user request.
2. Start the bridge after prepare.
3. Wait 10 seconds.
4. Run `npm run e2e-live -- verify basic-message.user-on --run-id <run-id>`.

Pass: the scoped channel contains the marker.

### `basic-message.user-off`

Purpose: prove real user messages are suppressed when `visibility.userMessages` is `false`.

Action:

1. Prepare with `--marker` set to an exact distinctive substring from the initial user request.
2. Start the bridge after prepare.
3. Run `npm run e2e-live -- verify basic-message.user-off --run-id <run-id>`.

Pass: the scoped channel remains free of the marker for the full timeout.

### `basic-message.commentary-on`

Purpose: prove commentary mirrors when `visibility.thinkingMessages` is `true`.

Action:

1. Send one commentary update containing exactly the generated marker.
2. Wait 10 seconds.
3. Run `npm run e2e-live -- verify basic-message.commentary-on --run-id <run-id>`.

Pass: the scoped channel contains the marker.

### `basic-message.commentary-off`

Purpose: prove commentary is suppressed when `visibility.thinkingMessages` is `false`.

Action:

1. Send one commentary update containing exactly the generated marker.
2. Run `npm run e2e-live -- verify basic-message.commentary-off --run-id <run-id>`.

Pass: the scoped channel remains free of the marker for the full timeout.

### `basic-message.final-on`

Purpose: prove subagent final answers mirror when `visibility.finalMessages` is `true`.

Action:

1. Spawn one harmless subagent with the instruction: reply with exactly the generated marker as the final answer.
2. Run `npm run e2e-live -- verify basic-message.final-on --run-id <run-id>`.

Pass: the scoped child thread contains the marker.

### `basic-message.final-off`

Purpose: prove subagent final answers are suppressed when `visibility.finalMessages` is `false`.

Action:

1. Spawn one harmless subagent with the instruction: reply with exactly the generated marker as the final answer.
2. Run `npm run e2e-live -- verify basic-message.final-off --run-id <run-id>`.

Pass: the scoped child thread remains free of the marker for the full timeout.
