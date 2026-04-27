# AGENTS.md for `codex-mobile`

If a user asks you to set up, start, debug, or clean this project, treat `README.md` as the source of truth for the user-facing flow.

## Platform Support

- Windows is the primary developed and tested platform.
- macOS is best-effort and not yet validated with Codex Desktop.
- Linux is unsupported.

## Setup Goal

The onboarding story should stay consistent across:

1. `README.md`
2. `npm run init`
3. Codex-assisted setup through this `AGENTS.md`

Do not invent a different setup path unless the user explicitly asks for a manual or advanced route.

## Shared Setup Checklist

Use this exact checklist when explaining or guiding setup:

1. create or choose a Discord server
2. enable Developer Mode and copy the server ID
3. create or open the Discord application
4. copy the application ID
5. create or confirm the bot
6. configure server install permissions
7. copy the bot token
8. invite the bot to the server
9. verify bot permissions
10. copy the controller user ID
11. choose a behavior preset
12. save `.env` and `bridge.config.json`
13. run `npm run doctor`
14. explain how to start and clean up the bridge manually

## If The User Says "Set This Up For Me"

Prefer this sequence:

1. Read the README sections:
   - `Prerequisites`
   - `Quick Guide`
   - `Detailed Guide`
   - `Start The Bridge`
   - `How It Works In Practice`
2. Install dependencies with:
   - `npm install`
3. Guide the user one step at a time instead of dumping the full checklist or asking for all Discord values at once.
4. For each browser/manual step, explain only the current action, then stop and wait for the user to confirm or paste the one value needed for that step.
5. Follow this conversational flow:
   - Ask the user to create or choose the Discord server.
   - Ask the user to enable Discord Developer Mode if needed.
   - Ask for the server ID, then save it into `.env`.
   - Ask the user to create or open the Discord application.
   - Ask for the application ID, then save it into `.env`.
   - Ask the user to confirm the Bot page exists.
   - Ask the user to configure server install scopes and permissions.
   - Ask for the bot token and save it into `.env`. Tell the user they may also add `DISCORD_BOT_TOKEN` directly to `.env` themselves if they prefer not to paste the token into Codex.
   - Generate or show the invite URL, ask the user to authorize the bot, then verify bot permissions.
   - Ask for the controller user ID and save it into `.env`.
   - Ask the user to choose the behavior preset, defaulting to `recommended`, then write `bridge.config.json`.
6. If a value is missing or invalid, ask only for that value again; do not restart the whole checklist.
7. Run:
   - `npm run doctor`
8. If diagnostics pass, do not start the bridge automatically. Tell the user to start it themselves with:
   - `npm start`
9. When the user uses Codex Desktop, recommend adding this project to the app, opening a chat for this project, and running `npm start` there while they work in other Codex projects.
10. After the bridge has stopped, recommend `/codex cleanall` from Discord or `npm run clean` locally when the user wants to remove bridge-managed Discord channels/threads and local state.
11. After the user starts the bridge, verify with one or more of:

- `npm run inspect`
- `npm run inspect:discord`
- `npm run inspect:codex`
- `npm run inspect:store`

When Codex runs `npm run doctor` from a restricted environment:

- Treat Discord API/network errors such as `EACCES`, `ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`, or "could not list servers" as inconclusive unless the same command also fails in the user's normal terminal.
- Do not tell the user their bot is missing from the server based only on a sandboxed doctor run that cannot reach Discord.
- If the user says `npm run doctor` passes in their terminal, trust that over Codex's sandboxed network result.
- If you need to verify Discord from Codex, rerun the same stable command with the required network approval instead of adding ad hoc Discord API checks.

## Coverage Guidance

- The bridge always monitors both Codex Desktop and Codex CLI.
- Approvals work for Desktop and for Windows Codex CLI sessions launched through the standard `codex` command while the bridge is running.
- The primary product surface is live mirroring plus exact approval handling in Discord, with narrow `/codex send` write-back for the configured controller user in mapped channels.
- Discord can route Plan Mode accept/feedback actions and tool-input answers only through the bridge's explicit controls.
- Ambient Discord chat messages are not Codex input, role IDs do not grant control, and unmapped Discord locations must reject write-back.

## Useful Operational Commands

- Start bridge:
  - `npm start`
- Development start:
  - `npm run dev`
- Diagnostics:
  - `npm run doctor`
- Coverage summary:
  - `npm run coverage`
- Coverage gate for the current core bridge surface:
  - `npm run coverage:gate`
- Clean bridge-managed Discord structure and local bridge state:
  - Stop any running bridge instance first.
  - `npm run clean`
- General inspection:
  - `npm run inspect`
- Focused inspection:
  - `npm run inspect:discord`
  - `npm run inspect:discord-thread -- <codex-thread-id-or-discord-channel-id> <limit>`
  - `npm run inspect:codex`
  - `npm run inspect:store`
  - `npm run inspect:desktop`
  - `npm run inspect:trace`
  - `npm run inspect:thread -- <thread-id> <limit>`

## Live E2E Guidance

If the user asks what live e2e tests are available, what live suites can run, or similar, run:

- `npm run e2e-live -- groups`

Then answer with the group IDs and brief explanations from that output. Do not expect the user to remember group names.
Always include each group's human input and approval requirements from the output, including what is not required. Do not collapse local-store groups and Discord-surface groups into the same interaction model.

If the user asks to run live e2e tests without more detail, prefer:

- `autonomous-basic`

For live e2e execution:

- Use `npm run e2e-live -- group <group-id>` to get the exact run contract and ordered scenarios.
- Use `npm run e2e-live -- prepare ...` for each scenario.
- Pass `--marker` to `prepare` only for `initial-user-message` scenarios. For commentary, command, file-edit, and subagent scenarios, use the generated marker printed by `prepare`; do not reuse the user's initial request text as the marker.
- Treat `discord-basic` as a mechanically triggered Discord smoke group for command and file-edit output. Do not add `basic-message.commentary-*` to that group run unless the user explicitly asks for commentary mirroring; commentary checks require Codex to emit the exact generated marker in a commentary update after the bridge starts.
- The default surface is local-store verification. Use the stable current-run helper commands printed by `prepare`: `npm run e2e-live -- start-local-current`, `npm run e2e-live -- verify <scenario-id> --run-id <run-id>`, and `npm run e2e-live -- stop-current`. `prepare` updates the current-run pointer for each scenario.
- Use `prepare --surface discord` only when the user explicitly asks for full Discord API/rendering proof. For that surface, `prepare` must print `Discovery scope`; the temp config uses `discovery.allowedThreadIds` so the run-scoped bridge only discovers the current runner thread, and e2e-created Discord channels carry that run's scope marker. `verify --run-id` first uses marker evidence in the temp run store to auto-select the scoped Discord channel or child thread, then checks the rendered Discord output and recorded Discord message IDs. Use `inspect-discord` and pass `--channel <id>` only when auto-selection fails or is ambiguous. Cleanup for Discord-surface scenarios is `npm run e2e-live -- cleanup-current`; it uses mapped-only scoped cleanup from the temp store and must not clean the normal live bridge. `stop-current` is process-only and leaves Discord categories/channels behind.
- Do not set `BRIDGE_CONFIG_PATH` or `STORE_PATH` by hand for live e2e runs, and do not use `Start-Process`; the helper owns the temp environment and avoids duplicate Windows `Path`/`PATH` issues.
- Do not inspect Discord through a browser or web search.
- Network approval should not be needed for default store verification. A local process approval may still be needed because `start-local-current` starts the bridge, which spawns `codex app-server`. If approval is requested for a local-store group, ask for session approval for `npm run e2e-live -- start-local-current`; this should compress the start approval to once per session/group instead of once per scenario. Discord-surface tests may still require network approval because they call the Discord API and cleanup deletes bridge-managed Discord structure, and local process approval because verification launches the Node inspect command. If approval is requested, request session approval for the stable `npm run e2e-live` command family instead of one-off inline env commands.
- The helper starts live e2e bridge processes with `CODEX_MOBILE_LIVE_E2E_IGNORE_HELPER_COMMANDS=1`, so helper verify/inspect/stop/cleanup commands do not count as scenario command activity.
- If the user asks to run tests only, report helper failures as they happen and do not debug or retry unless the user explicitly asks. Run the printed cleanup command before reporting a failure.
- During command and file-edit visibility scenarios, do not run extra shell commands, file edits, or ad hoc inspections while the bridge is running. Those extra events can change the expected command/file counts and invalidate the scenario.
- For commentary visibility failures, distinguish "Codex never emitted the marker" from "the bridge emitted it but Discord/store verification missed it." Check the helper evidence before calling it a bridge failure.

## Tutorial Consistency Rules

- Keep README, wizard wording, and agent guidance closely aligned.
- When summarizing setup for the user, prefer the README language rather than ad-libbing.
- If a setup step changes, update all three surfaces:
  - `README.md`
  - `src/init.ts`
  - `AGENTS.md`

## Engineering Principles

- Think before coding.
- Before editing, identify the current architecture, affected dependencies, and whether the change should extend an existing abstraction instead of adding a parallel one.
- Prefer the simplest approach that satisfies the product goal without sacrificing reasonable security, correctness, or maintainability.
- Keep a big-picture view. Always think of the consequences of your changes to both app behavior and codebase.
- Reuse and centralize shared logic when features overlap; avoid duplicating behavior across similar pipelines, views, or services.
- Do not reinvent an existing mechanism just because the new feature is adjacent to it.
- If fresh and refresh paths, edit and view paths, or similar flows should behave the same, use the same underlying logic unless there is an explicit reason not to.
- For larger architectural changes, stop and ask before proceeding.
- If the project is under development, you can most likely remove dead compatibility code instead of carrying it forward unless backward compatibility is explicitly required. If unsure, ask the user whether this bloat is necessary or not.
- Optimize for clear ownership, small public surfaces, and fewer moving parts.

## Before Coding Checklist

- Is there already similar logic in the repo? Can I extend a shared helper/module instead of duplicating?
- Is this the simplest solution that preserves quality?
- Will this create drift between similar code paths?
- Is this large enough that I should ask first?
