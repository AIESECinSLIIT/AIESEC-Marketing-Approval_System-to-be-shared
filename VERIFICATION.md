# Starter Kit Verification and Deployment Checklist

This package is a code-only distribution, **not** an independently verified, live deployment. It contains no production user accounts, approval records, production project references, or private service credentials.

## Before publishing to a public repository

- [ ] Confirm rights to share the source code, all graphics, and any trademarks, and choose an authorized license.
- [ ] Confirm `.env`, `.env.local`, Supabase credentials, VAPID private keys, tokens, and private user data are **not** committed.
- [ ] Confirm no other entity’s production Netlify/Supabase project URLs or GitHub remote are present.
- [ ] Confirm the root entity name and admin mailbox are placeholders that each recipient must configure.

## After a recipient creates their own infrastructure

- [ ] Run `npm ci` using Node 24 or newer, `npm test`, and `npm run build`.
- [ ] Run the entity configuration script with that entity’s legitimate name and administrator email **before** applying migrations.
- [ ] Apply migrations only to a new, empty Supabase project owned by the recipient.
- [ ] Deploy the three Edge Functions to the new project.
- [ ] Create the recipient’s own Super Admin and verify role-protected paths.
- [ ] Verify root-entity submissions go directly to their category LCVP.
- [ ] Verify IG member/OCVP submissions route IGVP → category LCVP, and that self-approval and skipped-stage approvals are denied.
- [ ] Verify an IGP and LCVP EM cannot override final LC decisions.
- [ ] Verify account scope, profile switching, revisions, private files, and in-app notifications.
- [ ] Configure fresh VAPID push credentials, dispatch URL, and webhook secret; test notifications on actual devices.
- [ ] Verify unavailable/disabled users cannot access data, and other entities’ accounts and data are not present.

**Note:** Tests include mocked network/cron behavior. Passing automated tests cannot certify real-device push notification delivery or production security. See `TESTING.md` for detailed role scenarios.
