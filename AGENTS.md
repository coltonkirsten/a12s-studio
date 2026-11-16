# Working in this repository

a12s Studio: one person runs teams of AI agents on one Mac. Read `docs/design.md` for what it is and
`docs/build-spec.md` for how it is built. Follow the spec; if it is wrong, change the spec in the same pull request.

## Commands

- `npm run check`: format, lint, types and tests. It must pass before every commit.
- `npm test`: `node --test` across all packages. One runner; add no other.
- `npm run dev`: app, broker and web with reload.
- `npm run e2e`: manual only. Needs Docker, a12s and a Claude login. Never add it to CI.

## Rules

1. **The best part is no part.** Before adding a file, table, dependency, setting, option or abstraction, check that
   the work cannot be done without it. Three similar lines are better than a helper used once.
2. **One place for each thing.** Each rule lives in one function: the caller's identity in `caller.ts`, SQL in
   `repo.ts`, post rules in `router.ts`, delivery in `dispatcher.ts`, agent specs in `spec.ts`, grant matching in
   `match.ts`. If you need the rule elsewhere, call it; do not restate it.
3. **Walls are structural.** Team scope comes from the caller's identity through `forTeam`. Never accept a team id,
   an agent id as "from", or a secret from an agent. Never write SQL outside `repo.ts` (app) or `db.ts` users in the
   broker.
4. **The broker stays small.** No runtime dependencies. It imports nothing from the app. It never logs or returns a
   secret. Any change to `forward.ts`, `match.ts` or `vault.ts` comes with a test in the default-deny list.
5. **Clean abstractions.** A module has one job and a narrow export list. Pure logic is separate from I/O so it can
   be tested with tables. The app reaches a12s only through `a12s/port.ts`.
6. **No dead code.** No unused exports, flags, parameters, commented-out code or "for later" hooks. Delete what a
   change makes unnecessary, in the same change.
7. **Do not repeat yourself, and do not abstract early.** Remove real duplication of a rule. Leave coincidental
   similarity alone.
8. **Comments say why, never what.** Write one only when the reason is not obvious from the code: a constraint from
   a12s, a security reason, a measured fact. No history, no names, no dates.
9. **Docs are present tense.** Describe what the system does now. No changelog prose, no "previously", no plans.
10. **Server truth.** The UI renders the pushed state and keeps no copy of server data. No optimistic updates. A
    route answers after its write is committed.
11. **Types.** Strict TypeScript, erasable syntax only (no enums, no parameter properties). No `any`; narrow
    `unknown` at the boundary. Shared shapes live in `packages/contract` as types.
12. **Errors.** Fail loudly at start-up for missing configuration. At run time return `{ code, message, fix }` and
    keep going. Never swallow an error.
13. **Tests.** New behaviour comes with a test that fails without it. Tests use the fake a12s and temp folders, never
    the network, Docker or a real login.
14. **Secrets and examples.** No secret, real host name, address or personal data in the repo, in tests or in logs.
    Print where a secret is, never its value. Examples and template teams are generic.
15. **Small pull requests.** One work package, one purpose. The description says what changed and how it was
    verified.
