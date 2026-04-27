# Releasing

This project is currently intended to ship as a **Windows-first public beta**. Windows is the tested platform; macOS is best-effort and probably not working yet.

## Release checklist

### Code

- [ ] `npm run build`
- [ ] `npm test`
- [ ] no unexpected local config or secret files are staged
- [ ] `.env` and `bridge.config.json` are not included in the commit

### Security

- [ ] approval routing still requires exact surfaced requests
- [ ] redaction tests pass
- [ ] Discord approval allowlist validation still fails closed
- [ ] no new Discord write capability was added without explicit review

### Docs

- [ ] `README.md` reflects the current shipped behavior
- [ ] `SECURITY.md` reflects the current trust model
- [ ] public beta limitations are still explicit

### Repo health

- [ ] CI is green on Windows
- [ ] issue templates are present
- [ ] license is present

## Versioning policy

Until the project leaves beta:

- use conservative version bumps
- document breaking behavior changes clearly in release notes
- treat approval/security behavior changes as release-note-worthy even if they are small
