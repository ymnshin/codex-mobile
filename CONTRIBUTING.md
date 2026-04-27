# Contributing

Thanks for your interest in `codex-mobile`.

## Public beta policy

This public beta is open for feedback, bug reports, and feature suggestions through GitHub Issues.

External pull requests are not being accepted during the public beta. Please open an issue before investing time in code changes; unsolicited PRs may be closed without review.

## Scope

The first public release is a Windows-first, Discord-focused beta.

Priority feedback areas:

- security hardening
- approval reliability
- Discord UX/readability
- macOS support
- diagnostics and troubleshooting
- provider-boundary cleanup for future adapters

Lower priority for now:

- new chat providers

## Security

Do not post sensitive logs, tokens, `.env` files, or unredacted local paths in public issues.

For security issues, do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Local development

For local setup and manual testing:

```powershell
npm install
npm run init
npm run doctor
npm start
```

For validation:

```powershell
npm run build
npm test
npm run coverage
npm run coverage:gate
```

Development changes should preserve the trust model:

- no bypass around exact approval request binding
- no secret leakage into Discord
- fail closed when approval or thread state is ambiguous
