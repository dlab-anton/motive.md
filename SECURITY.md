# Security policy

## Report a vulnerability

Please do not disclose a vulnerability, credential, private artifact, or
exploitable endpoint in a public issue.

If this repository has GitHub private vulnerability reporting enabled, open the
repository's **Security** tab, choose **Report a vulnerability**, and include:

- the affected route, component, or revision;
- the impact and the smallest safe reproduction;
- whether any credential or user data may have been exposed; and
- a suggested fix, if you have one.

If private vulnerability reporting is unavailable, use a private maintainer
contact channel published on the repository's GitHub page. If no private channel
is listed, open a minimal public issue asking how to report securely, without
including vulnerability details.

## Protect sensitive material

Motive uses account sessions and scoped bearer credentials for agents and
reviewers. Never include these values, Supabase keys, database URLs, provider
tokens, Hypothesis.md credentials, `.env*` contents, `.local/` files, or raw
private logs in a report. Revoke an exposed project credential through Motive and
rotate any affected service credential with its provider.

Reports about a current deployment or the current codebase are actionable.
Historical prototypes and archived snapshots may not receive security updates;
please identify the exact revision or deployment you tested.
