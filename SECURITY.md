# Security Policy

## Status

`codex-mobile` is a **Windows-first public beta**. Windows is the primary developed and tested platform, macOS is best-effort and not yet validated with Codex Desktop, and Linux is unsupported. Its security model is intentionally conservative, but it should still be treated as an enthusiast tool, not an enterprise-hardened remote admin surface.

## Threat model

The bridge sits between:

- a locally authenticated Codex Desktop instance
- a semi-trusted third-party messaging surface (Discord)

The main risks are:

- leaking sensitive content into Discord
- allowing the wrong Discord user to approve an action
- replaying or reusing an old approval interaction
- accidentally turning Discord into a generic remote-code-execution surface

## Security goals

- approvals are limited to **exact surfaced requests**
- no arbitrary command execution path is exposed through Discord
- Discord write-back is limited to explicit slash commands in mapped bridge channels
- server-side authorization is enforced by the local bridge
- stale or resolved approval cards become non-actionable
- mirrored content is redacted and truncated by default

## Current protections

- `.env` and `bridge.config.json` are local-only files and are ignored by Git
- approval actions are bound to opaque local tokens plus exact request ids
- Discord control is limited to exactly one configured user id when enabled; role ids do not grant access
- queued write-back messages are persisted locally until sent, failed, or retracted
- command details are opt-in and still redacted
- common secrets are redacted before posting to Discord:
  - API keys
  - auth headers
  - JWT-like tokens
  - GitHub/OpenAI/Slack token patterns
  - `.codex/auth.json` paths
  - stack traces and some credential-bearing strings
- the bridge fails closed when approval state is ambiguous
- audit entries are stored locally in SQLite

## Deployment guidance

Recommended for public beta users:

- use a dedicated private Discord server
- restrict bot installation to a server you control
- keep `approvals.allowFromDiscord` enabled only if you actually need remote approvals
- prefer the `recommended` preset unless you need richer mirroring
- switch to `full` only if you are comfortable with more text leaving the local machine
- review `bridge.config.json` after running the init wizard

## Known limitations

- Discord is not an end-to-end encrypted channel for this workflow
- some Codex approval surfaces are better supported than others
- the bridge does not yet support fine-grained per-channel or per-thread approval policies
- ambient Discord chat messages are ignored and never treated as Codex input
- write-back is not accepted from unmapped Discord channels or users other than the configured controller

## Reporting a vulnerability

If you find a security issue:

1. Do **not** open a public GitHub issue with exploit details.
2. Report it privately to the maintainer first.
3. Include:
   - affected version or commit
   - impact
   - reproduction steps
   - whether the issue can leak data or bypass approval controls

Until a dedicated security contact is added, treat the repository owner/maintainer as the initial private contact.

## Scope for first public release

The intended safe scope for the first GitHub release is:

- Windows only
- Discord only
- local-first monitoring
- approval handling for supported approval surfaces
- macOS only on a best-effort basis

Anything beyond that should be considered experimental until explicitly documented.
