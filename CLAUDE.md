# Reddably — Project Memory

Reddably is an out-of-network (OON) insurance billing platform for mental-health group
practices — practice admins overseeing multiple clinicians. Sibling product to Sessionably
(same founder, same stack). Differentiator vs. Mentaya: built for group practices, not solo
providers.

## Golden rules (do not violate)

- Mirror Sessionably's stack exactly. No frameworks. Vanilla HTML/CSS/JS only — no
  React / Vue / Next. One HTML file per view (e.g. `app.html`, `client-portal.html`).
- HIPAA-compliant. No PHI in URLs or query strings. PHI encrypted at rest (RDS,
  infra-level) and in transit. Audit-log PHI access.
- All network calls go through `window.ReddablyAPI` (`public/js/api-client.js`). Views
  never call `fetch()` directly.
- Use design tokens, never raw hex. Reference the semantic CSS variables from
  `public/app-foundation/styles/tokens.css`.
- Light mode only. A single stone-led "Stone & Sage" identity. No dark mode, no theme toggle.
- Auth token stored in `localStorage` under `reddably_access_token`.

## Stack

- Frontend: static, served by Vercel from the repo root. Assets live under `/public`.
- Backend: AWS Lambda + PostgreSQL (RDS) inside a VPC, behind `https://api.claimsub.com`.
  Deployed separately from Vercel.
- A few Stripe endpoints run as Vercel functions in `/api` — the Lambda VPC has no NAT
  egress, so it can't make outbound Stripe calls.
- Payments: Stripe + Stripe Connect. Per-claim platform fee of 5%, paid by the client or
  the practice (configurable, with per-clinician override).
- Domains: `reddably.com` (marketing), `app.reddably.com`, `api.claimsub.com`.

## Design system (F0 — "Stone & Sage")

Stone-led. **Color is not decoration** — every hue earns its place, and most of the app is
stone. Calm and clinical: no urgency theater, no dopamine UI.

### What each color is for

- **Stone carries structure.** Page and app backgrounds, sidebar/rail, topbar, cards,
  borders, dividers, tables, and neutral hover/selected states.
- **Stone/ink carries default action.** Primary and generic actions — Save, Continue, Add
  Claim, New Claim, Upload, Create, Submit Claim — use `--color-primary` (hover
  `--color-primary-hover`). Never sage.
- **Active navigation is stone/ink.** Never sage.
- **Sage is earned** by meaningful successful/resolved state (paid, accepted, active
  coverage). It is not the default primary-action color and never marks in-flight work.
- **Clay is reserved** for restrained human-scale warmth and family-brand expression. It is
  not a status color and carries no claim-state meaning.
- **Urgent `#A14842`** (`--color-danger`) is reserved for consequential interruption or
  failure: rejected/denied claim, failed payment, destructive actions.
- Neutral workflow states (draft, pending, processing, queued, needs-review) stay stone.
- Monetary values stay ink-led. Never sage.
- Ordinary field validation stays neutral: `.field__error` → `--color-text-muted`;
  `.field--invalid .field__control` → `--ink-400`.

The former deep-red primary and metallic accent are **retired** and are no longer SC brand
colors. Do not reintroduce them.

### Palette — canonical Sessionably values

`public/app-foundation/styles/tokens.css` is authoritative. Values flagged below have **no
token yet** — they are part of the brand ramp but have no variable to reference, so do not
reach for them until one is added (the golden rule stands: tokens, never raw hex).

- **Stone** — `#FBFAF7 #F4F2EC #E8E4DB #D6D0C2 #B5AC97 #8C8472 #6C6657 #4C4839 #34322A
  #1F1E1A`. Fully token-backed: `--paper-base`, `--paper-sunken`, `--line-200`, `--ink-300`,
  `--ink-400`, `--ink-500`, `--color-text-subtle`, `--ink-700`, `--color-primary-hover`,
  `--ink-900`.
- **Sage** — `#F1F4EF #DDE6D7 #C2D1B9 #9FB494 #7A9670 #5C7B55 #486141 #384B33`. Partially
  token-backed: `--color-accent-tint` `#DDE6D7`, `--color-focus-ring` `#5C7B55`,
  `--color-accent` `#486141`, `--color-accent-strong` `#384B33`. `#F1F4EF` and `#C2D1B9`
  exist only as the claim-state badge literals in `public/app/components.css`; `#9FB494` and
  `#7A9670` are currently unused.
- **Clay** — `#FAF1EA #F1DECF #E3C2A8 #CFA17F #B27F5A #8E6244 #6E4B34`. No tokens; not yet
  used anywhere in the app.
- **Urgent** — `#A14842` (`--color-danger`).

### Claim state

State meaning lives on **badges only** — never whole rows, monetary amounts, or navigation.

| Treatment | Background | Border | Text |
| --- | --- | --- | --- |
| Neutral | `#F4F2EC` | `#E8E4DB` | `#4C4839` |
| Successful | `#F1F4EF` | `#C2D1B9` | `#384B33` |
| Urgent | `#FBFAF7` | `#A14842` | `#A14842` |

Statuses do not have their own selectors: they route through tone buckets in
`public/app/views.js` (`BADGE_TONES`), and CSS only ever sees the tone. A tone's treatment
must therefore be correct for **every** status routed into it.

**`submitted` currently remains stone**, even though a submitted claim is a successful state
that would otherwise earn sage. It shares the `info` tone bucket with `processing` and
`claim_ready`, which must stay stone; CSS cannot tell them apart, so sage there would paint
queued work as resolved. Separating it means changing the tone map — a JS change,
deliberately not taken in PR-1 or PR-2.

### Type and token families

- Body font: Inter. Display/headings: Source Serif Pro. Mono: JetBrains Mono.
- Avoid blue/teal-primary + orange-accent — it reads as a healthcare-IT incumbent
  ("Availity-coded") and undermines the distinct identity.
- Token families: spacing `--space-1..11` (4px base), radius `--radius-1..pill`, shadow
  `--shadow-0..3`, motion `--motion-fast..ambient`, zones `--zone-0..3`, shell
  `--rail-width` / `--topbar-height` / `--content-max`.

### Migration status

PR-1 (token layer) and PR-2 (authenticated app surfaces) are merged. The public marketing
and auth surfaces — `index.html`, `login.html`, `signup.html`, `invite.html`,
`card-setup.html`, `public/login.css` — are **not yet migrated**; that is PR-3, and they
still carry retired literals. The two-ring logo consequently differs between the app shell
(ink + sage) and the public pages. That inconsistency is temporary and resolves in PR-3.

## Repo layout

```
/                                  index.html (marketing), app.html (app shell)
/public/app-foundation/styles/     tokens.css, app.css
/public/styles/                    public-tokens.css
/public/js/                        api-client.js, app.js
/backend/                          AWS Lambda handlers + shared libs
/db/                               schema.sql (data model — source of truth), migrations/
/api/                              Vercel functions (Stripe checkout, etc.)
vercel.json                        clean URLs
```

## Data & code conventions

- PostgreSQL. UUID primary keys via `gen_random_uuid()`. `timestamptz` `created_at` /
  `updated_at`, with a shared `set_updated_at()` trigger.
- Prefer `text` + `CHECK` constraints over native `ENUM` types (easier to evolve).
- Money: `numeric(12,2)`. Percentages: `numeric(5,2)`.
- Soft-delete over hard-delete (`is_active` / `is_hidden`). Foreign keys default to
  `ON DELETE RESTRICT` to protect financial and PHI records. Keep an append-only
  `audit_log`.
- Multi-tenancy: carry `practice_id` on every practice-scoped table for query scoping and
  future row-level security.
- Vanilla JS: no build step, no bundler. Plain ES in `.js` files loaded via `<script>`.

## Group-practice model

- `practices` own `users` (role: `practice_admin` | `clinician` | `billing_staff`).
- A practice admin sees all clinicians, clients, and claims; a clinician is scoped to
  their own caseload.
- A client has one primary clinician but can be reassigned. Fee-payer is set at the
  practice level with a per-clinician override.

## Not in v1

AI/clinical notes, telehealth video, full EHR, and scheduling-as-a-feature (sessions exist
only to attach claims to). Those belong to Sessionably.

## Git workflow

- Never commit directly to `main`. Branch per task: `feat/…`, `fix/…`, `chore/…`.
- After completing a task: stage the relevant files, commit with a clear conventional
  message, push the branch, and open a PR with `gh pr create` (title + a short body that
  summarizes the change and how to test it). If `gh` is not authenticated, push the branch
  and tell the user the compare URL so they can open the PR on github.com.
- One PR per logical unit of work. Do NOT merge — the user reviews and merges.
- Never commit secrets; respect `.gitignore` (`.env*` etc.). Only `.env.example` is tracked.

## Taking an idea (default working mode)

The user gives ideas in plain English, not pre-written prompts. When you get one:

1. If it's unambiguous and does NOT touch the money path (fee, submit, Stripe) or
   change claim behavior — restate it in one line, then just build it. Don't wait
   for a formal prompt.
2. If it IS money-path/claim-behavioral, OR you'd have to guess at a product
   decision — stop and ask ONE clear question before coding. Flag in the PR body:
   "Money-path change — recommend diff review before merge."
3. Always one PR per logical unit. If an idea is really several units, say so and
   propose the split before starting.
4. The test-before-PR gate below ("Before opening a PR") is non-negotiable
   regardless of how small the idea.

## Before opening a PR

Verification happens BEFORE the commit, not after the PR. All three steps below are
required; there is no "commit it and check CI".

1. **`npm test` must be green.** One command runs the entire backend suite
   (`backend/scripts/run-tests.js` → every `backend/tests/*.test.js`, each in its own
   process) and exits non-zero if any file fails. Run the whole suite, not just the file
   you touched — the suite is ~5 seconds. `npm test -- <substring>` narrows it while
   debugging, but the full run is what gates the commit.
2. **Curl-check every API endpoint you touched.** A green unit test proves the handler
   logic; it does not prove the deployed route, its auth, or its response shape. For any
   endpoint added or changed, hit it with `curl` (against the deployed Lambda, or locally)
   and paste the actual request/response into the PR body. Never send real PHI in a
   self-check — use synthetic fixtures.
3. **If anything fails, stay in debug and do NOT commit.** A failing test or a curl that
   answers wrong is the task, not a footnote. Do not commit a red suite, do not commit
   with a "fix in a follow-up" note, and do not weaken or skip an assertion to get to
   green. If a test is genuinely wrong, fix the test deliberately and say so in the PR
   body.

Add or extend a test for the behavior you changed. `backend/tests/onboarding_to_claim_e2e.test.js`
walks the critical path (client → intake → clinician confirm → session → claim → submit)
end to end; if a change touches that chain, it belongs there.

## Handing over shell work (deploys, migrations, one-off ops)

Operational work runs in the user's terminal, not the agent's. Anything that has to
be run by hand is delivered as **one paste-able script**, never as prose steps the
user has to sequence themselves.

**Deliver it as a heredoc that WRITES A FILE, then a separate line that runs it:**

```
cat > /tmp/thing.sh <<'SCRIPT'
...
SCRIPT
bash /tmp/thing.sh
```

Never hand over a bare multi-line script to paste. The user's shell is zsh, which
performs HISTORY EXPANSION on `!` in interactive input — so a `#!/usr/bin/env bash`
shebang fails with `zsh: event not found: /usr/bin/env`, and any `!` inside a
double-quoted string (`echo "!! stopping"`) fails the same way. The first line then
errors and the REST OF THE PASTE executes as loose commands, which on a deploy
script is genuinely dangerous. A QUOTED heredoc delimiter (`<<'SCRIPT'`) suppresses
all expansion, and `bash file` avoids zsh's parsing entirely.

Rules for that script:

- `set -euo pipefail`, and derive identifiers rather than hardcoding them
  (`terraform output -raw migrate_function_name`, `git rev-parse --show-toplevel`).
  A wrong guessed resource name is discovered in production.
- **Every check is a hard gate that exits non-zero.** A comment saying "confirm this
  looks right" is not a gate. Parse the actual result (`jq -e '.ok == true'`) and stop.
- **Explicit confirmation before anything user-facing**, via
  `read -r ANSWER </dev/tty` — `/dev/tty`, or a pasted block feeds its own remaining
  lines into the prompt.
- **When a check cannot run, say so in the output** and name the substitute. Never
  skip silently: a script that prints nothing looks identical to one that verified
  everything.
- **State the expected value inline** (`^^ all three MUST be 0`). The person running
  it should not need the schema in their head to tell pass from fail.
- **Close with a rollback line per phase**, and say which phase is the first one that
  is user-visible.

### Deploy ordering — the fact that makes ordering necessary here

`infra/terraform` builds ONE `archive_file.backend` zip shared by every Lambda
(`auth`, `migrate`, `backfill`). A plain `terraform apply` updates them together, so
a schema-dependent handler goes live before the migrate Lambda has applied the
schema. `infra/terraform/deploy.sh` passes extra args through to `terraform apply`,
so an ordered rollout is:

```
./deploy.sh -target=aws_lambda_function.migrate   # migrate function only
aws lambda invoke --function-name "$(terraform output -raw migrate_function_name)" ...
<verify>
./deploy.sh                                       # then the API handlers
```

Terraform warns that `-target` is for exceptional use; this is that exception.
NOTE: the `-target` split is reasoned from the terraform source, not yet proven
against a real apply — correct this section after the first live run.

The Vercel project is **git-linked** to this repo and serves the production domains,
so **merging to `main` IS the frontend deploy**. It belongs last in any sequence,
not first. Never describe a merge as inert.

Migrations are applied by the operator, never automatically (`db/README.md`;
`backend/handlers/migrate.js` is invoked by hand). Every migration file carries its
own deploy order and verification queries in its header, each with a stated expected
result.

## More context

@README.md @db/schema.sql
