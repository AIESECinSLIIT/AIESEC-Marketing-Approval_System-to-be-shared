# AIESEC - Marketing Approval System to be shared

**Entity Starter Kit**

An independently deployable, entity-specific marketing approval app. This is **source code**, not a hosted service. Each entity owns its own **GitHub repository, Supabase project, Netlify site, accounts, data, creative files, and notification credentials**.

**No other entity's GitHub/Netlify/Supabase endpoints, accounts, or keys are needed or included.** The root-entity database marker is `ENTITY`, a deliberately generic internal value. Each isolated installation may use the same marker without sharing data.

**Publishing to GitHub?** See [PUBLISH.md](PUBLISH.md) for the exact public-repository instructions. The GitHub repository is not created by downloading this ZIP; it must be published under the account that will own it.

## Getting started

**Read [SETUP.md](SETUP.md) first.** Configure the entity and admin identity **before** applying migrations or creating accounts:

```bash
npm ci
npm run configure -- --name "AIESEC in Your Entity" --admin-email "example-admin@university.edu"
```

You then create a **new Supabase project** in the recipient's own account, apply the included migrations, deploy Edge Functions, and connect **a new Netlify site** to the recipient's own GitHub repository. Do not enter another entity's keys or production project reference.

The checked-in template uses a deliberately invalid placeholder `admin@your-entity.example` until configured. The setup script rewrites relevant backend and database authorization rules; changing just the website title is **not** enough.

## Included workflow (matches the source version)

- Single login with multiple scoped profiles and profile switching
- Super Admin controls leadership, people, events, initiative groups, and exceptional review overrides with password re-verification
- LCVP Marketing and LCVP B2C conduct final category approval; LCVP EM manages Initiative Groups
- IGP, IGVP Marketing and IGVP OGV review / supervise their own group; event-only OCP and Event Manager observer access
- Entity posts route to matching LCVP; IG member/OCVP posts route **IGVP first → category LCVP second**; IGVP posts route to category LCVP
- Submit, request changes, revise/resubmit, approve or reject, retain history and audit records
- Scoped in-app notifications; optional configured web push notifications, retries and profile-linked notification navigation
- Protected private creatives, event scopes, account separation, and manual creative cleanup

The app does **not** automatically publish social posts.

This distribution retains the source system's *currently implemented* profile creation permissions. Any previously discussed future permissions redesign is **not** included unless applied separately.

## Important security boundaries

- This is a **fresh installation**: `supabase/migrations/` contain **schema/code, not production submissions or user records**. Do not export/import any other entity's production database.
- Do not reuse another entity's Supabase project, Netlify site, service keys, VAPID keys, or administrator email/password.
- Never put Supabase secret/service-role keys in `VITE_` variables, `.env` commits, or the public GitHub repository.
- When you finish local configuration, review `git diff` and only commit **public configuration**. Keep credentials private.
- Public source code is not proof of authorization to use AIESEC trademarks or an automatic software license. The publisher must choose a suitable license and verify rights before publication.

For local development, Node.js 24+ and `npm ci` are recommended. `npm test` exercises the included workflow and authorization cases (some transport services are mocked). `npm run build` builds the frontend for Netlify.

See [SETUP.md](SETUP.md) for complete deployment/notification steps and [TESTING.md](TESTING.md) for a role/approval smoke-test checklist.
