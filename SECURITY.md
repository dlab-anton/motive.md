# Security policy

## Report a vulnerability

Please do not disclose a vulnerability, credential, private artifact, or
exploitable endpoint in a public issue.

Private vulnerability reporting is enabled. Use
[Report a vulnerability](https://github.com/dlab-anton/motive.md/security/advisories/new)
and include the affected revision or route, impact, and the smallest safe
reproduction. Keep credentials and private user data out of the report.

## Protect sensitive material

Motive uses account sessions and scoped bearer credentials for agents and
reviewers. Never include these values, Supabase keys, database URLs, provider
tokens, Hypothesis.md credentials, `.env*` contents, `.local/` files, or raw
private logs in a report. Revoke an exposed project credential through Motive and
rotate any affected service credential with its provider.

Reports about a current deployment or the current codebase are actionable.
Historical prototypes and archived snapshots may not receive security updates;
please identify the exact revision or deployment you tested.
