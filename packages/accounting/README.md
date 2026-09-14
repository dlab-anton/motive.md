# P1 PostgreSQL ledger kernel

`LedgerKernel` is a private control-plane boundary. It accepts decimal strings,
uses PostgreSQL row locks and an append-only balanced journal, and writes an
outbox entry in each accepted state-changing transaction.

The public control API can use `getGrantForIssuer`, `listGrantsForIssuer`, and
`revokeGrant` after it has authenticated the actor. Request admission is kept
disabled by the control API until the runtime, sandbox, and evaluator gates are
complete.

`closeAttempt` and `closeGrant` are financial closure operations only. They do
not prove a sandbox or command stopped; P2 must record and reconcile that
separate physical lifecycle before treating a reservation release as cleanup.

## Run capabilities and gateway admission

`issueRunCapability` is a trusted control-plane operation. It checks the
current project operator or funding-controller authority, the attempt's active
work order, funding chain, lease epoch, controller generation, and frozen
profile before minting an opaque random bearer. PostgreSQL stores only its
SHA-256 hash together with the exact project, attempt, grant, source, profile,
lease, controller generation, and database-clock expiry. The raw bearer is
returned once as `capability`; it is never put in an event, journal, outbox, or
idempotency response. A completed issuance idempotency replay fails closed,
so callers must retain the original bearer.

`getRunCapabilityContext(token)` is an advisory preflight helper for the
trusted gateway. It has no admission authority. `admitCapabilityRequest` takes
the bearer, never a caller-selected actor/project/grant/lease, and locks the
same controller → source → grant → attempt chain as ordinary admission before
locking and revalidating the capability and work-order state. Revocation,
expiry, profile, lease, and controller-generation checks therefore happen in
the commit transaction rather than in a cache.

Gateway-derived admission metadata is deliberately narrow: credential
reference, requested model, frozen profile ID, and the approved
`max_output_tokens` normalization. It is validated strictly, persisted with
the operation before any provider call, included in the operation's immutable
admission identity, and contains neither bearer values nor request text.

After admission, `claimOperationForDispatch` is the durable send-once
boundary. It stores a hash of a fresh dispatcher invocation identifier and
changes `ISSUING` to `IN_FLIGHT` in one transaction. Only `claimed: true` may
contact a provider. A lost acknowledgement, a concurrent retry, or a stale
lease/controller generation never grants a second send; each new operation
also records the exact lease epoch and controller generation that admitted it.
Historical rows without those durable fences are not dispatchable and remain
for reconciliation. `recordOperationProviderIdentity` records early provider
request/response identifiers as write-once fields without changing the send
claim.
