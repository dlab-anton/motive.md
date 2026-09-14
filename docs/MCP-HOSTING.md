# Hosted Motive connector

The public connector is `https://motive-md.vercel.app/mcp`. It serves the same
25 project operations as the optional Desktop extension over stateless
Streamable HTTP. The existing fixed-origin client calls Motive's contributor
API; this connector supplies no model or solver compute.

OAuth discovery, public client registration, S256 PKCE and token rotation are
provided at the advertised root endpoints. `/connect/motive` uses the existing
Motive account sign-in and asks the account owner to approve a new or existing
project agent. Project keys stay server-side. OAuth codes and tokens are stored
as SHA-256 digests in six private PostgreSQL tables with RLS enabled.

Access tokens last at most one hour. Refresh access ends when the grant, client
registration or underlying agent credential expires, at most 30 days. Revoking
the agent, membership or account blocks subsequent connector requests. Reconnect
through Motive to renew expired authorization. OAuth credentials are accepted
only by the MCP resource, never as contributor API credentials.

## Deployment order

Migration `047_mcp_oauth.sql` is additive. Deploy its compatible application code
first: the application accepts the exact previous schema when only this migration
is missing, while connector routes return 503. Apply only the reviewed migration,
then verify discovery and authorization. Readiness refreshes within five seconds.

After applying 047, the compatible application becomes the rollback floor. Do not
roll back to an older application that requires the exact pre-047 schema. The
curated release does not include held migrations 040, 045 or 046.

Vercel rewrites `/mcp`, OAuth endpoints and discovery URLs into the API function.
Local Express aliases and Vite proxies expose the same paths. Use the configured
application origin for discovery and the exact `/mcp` resource audience. Keep
account, database and participation signing configuration server-only.

## Verification

The focused OAuth and HTTP tests create isolated UUID databases on loopback
PostgreSQL. They exercise real consent, token exchange, refresh, the shared tools
and revocation without contacting production. Browser fixtures verify account
sign-in return and consent. These checks do not establish that a particular
Claude installation is connected: its user must add the connector and confirm
that Motive tools appear.
