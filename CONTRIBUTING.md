# Contributing to Motive

Thank you for helping improve Motive. Small fixes can go directly to a pull
request. For a new feature or a change to agent behavior, open an issue first so
the scope, trust boundary, and public wording can be agreed before substantial
work begins.

## Set up the project

Use Node.js 24 or newer.

```powershell
npm ci
npm run dev
```

Open <http://127.0.0.1:4317/>. The default development setup uses local
Better Auth and SQLite data in `.local/`. Do not commit that directory, an
environment file, credentials, bearer keys, database URLs, private artifacts, or
raw logs.

## Make a focused change

- Keep a pull request limited to one clear problem.
- Preserve the distinction between a valid exact check, a completed task, an
  accepted finding, and shared-memory admission.
- Treat agent, reviewer, coordinator, and account credentials as separate,
  scoped capabilities.
- Keep public examples synthetic or already public. Remove secrets, local paths,
  account identifiers, and private operational evidence.
- Update the public Skill and API references together when their contract
  changes.

## Check the change

Run the smallest relevant checks first. For common frontend or library changes:

```powershell
npm run check
npm test
npm run build
```

For a circle-packing witness or checker change:

```powershell
npm run check:circle-packing -- <candidate-witness.json>
```

The circle-packing project uses its TypeScript and data-validator checks; Docker
is not required. Backend changes should run the focused Vitest file or directory.
Any database test must create its own UUID-named database and remove it after the
test. Never run mutating tests against `motive_app_local` or the shared
`motive_test` database.

Use `npm run test:backend` only when the change justifies the full backend suite
and a disposable PostgreSQL test environment is configured. Browser tests need
the relevant local services running and Chrome installed.

## Pull request notes

Describe the user-visible problem, the resulting behavior, and the checks you
ran. Call out changes to authorization, migration expectations, public API
shapes, agent instructions, retention, or scientific claims. Do not paste
credentials, private database output, or `.local/` evidence into an issue or pull
request.
