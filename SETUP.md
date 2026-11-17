# Set up your own Marketing Approval Hub

This starter kit is **one entity per installation**. You are not joining another organization's application and do not need access to its infrastructure. Perform all steps with accounts controlled by your own entity.

## A. Create your own independent copy

1. Download the ZIP and extract it. Upload the files to **your own new GitHub repository** (or use Git locally to create your own repository). Do not fork somebody else's private production repository.
2. On your computer, install Node.js **24+**, Git and the current Supabase CLI.
3. Run `npm ci` in this project's folder.
4. Before deploying or creating a Supabase user, run:

   `npm run configure -- --name "AIESEC in Your Entity" --admin-email "example-admin@university.edu"`

   Use the **actual entity name** and **a real mailbox controlled by your entity**. The script updates UI text, SQL migrations, server logic, tests, and the push-mailto identity. It should be run **once before initial deployment** on a clean copy.
5. Replace `public/entity-logo.svg` with your authorized logo. The neutral placeholder may be used for testing; do not copy another entity's branding. Adjust icon colors if desired.
6. Commit the configured code to your own GitHub repository. Review it first; no secret keys/passwords belong in Git.

## B. Create a fresh Supabase project (under YOUR account)

1. Go to Supabase; create a **new project** under your entity's own account or organization. Do **not** use another entity's project.
2. Install and log into the Supabase CLI. From this project directory run:

   `supabase login`

   `supabase link --project-ref YOUR_NEW_PROJECT_REF`

   `supabase db push`

   Use ONLY the new project's reference ID. This applies every `.sql` migration from `supabase/migrations` in order. Never apply these migrations to an already populated unrelated database.
3. Deploy **all three** Edge Functions to **your** project:

   `supabase functions deploy manage-users`

   `supabase functions deploy review-submission`

   `supabase functions deploy send-push`

   Their JWT/auth and internal secrets expectations are defined in `supabase/config.toml`. Supabase provides built-in secret environment variables inside Edge Functions; do not expose them in the frontend.
4. In Supabase **Authentication → Providers → Email**, decide whether to require confirmation. For a real entity, **enable confirmation and configure reliable SMTP**. If confirmation is disabled, email ownership is not verified at member signup.
5. In Supabase **Authentication → Users**, create your entity's real Super Admin user with exactly the **same email chosen in Step A4**, a strong unique password, and email confirmation/verification. The Auth signup trigger will create their initial member profile.
6. In Supabase **Table Editor → `club` schema → `profiles`**, find only that admin's row (match its email and Auth user ID), change its `role` field to `ADMIN`, and save. This is the one-time bootstrap. The database will reject nonmatching admin emails. **Do not create a second user with a second password.**
7. Verify you can sign in to your **new** application and see Super Admin access before inviting other users. If you cannot, do not give others access yet.

## C. Deploy on your own Netlify

1. Create a new Netlify account/team controlled by your entity, and import **your own** GitHub repository.
2. Build command and publish directory are already set in `netlify.toml` (`npm run build` with config check, `dist`).
3. Set **site-specific environment variables** (Site configuration → Environment variables):

   `VITE_SUPABASE_URL` = your new project's HTTPS Project URL

   `VITE_SUPABASE_ANON_KEY` = your new project's **publishable key** (`sb_publishable_...`) or legacy public `anon` key

   Never use a `service_role` or secret key here.
4. Deploy, then copy your new Netlify URL. Set it as the **Site URL** and appropriate redirect URL(s) in **your** Supabase project under **Authentication → URL Configuration**.
5. Sign in as Super Admin. Create a demo event and Initiative Group to test the workflows. Remove disposable records only after confirming the system works.

## D. Approvals and Initiative Groups

- One root entity uses the generic internal `ENTITY` organization marker and its customized display name.
- Root Marketing / B2C content goes directly to the corresponding category LCVP for final review.
- Initiative Groups are created and activated by the Super Admin / LCVP EM. Group logos live in a separate public branding bucket; post creatives remain private.
- For an IG member or IG OCVP submission, route to the IGVP of the matching category, then the matching root LCVP for final review. IGVP-originated submissions go directly to the matching LCVP.
- IGP and LCVP EM retain their IG-stage permissions; they cannot bypass final LCVP decisions. Self-approval is blocked by account-level checks.
- OCP and Event Managers are event-scoped observers. Revisions/history stay attached to their own submission.

## E. Notifications

**In-app notifications** are generated by the application's database workflow automatically after a correctly installed migration; confirm one real approval event generates the intended scoped notifications.

**Web push** requires extra independent setup in each Supabase project (the code alone cannot make push work). Refer to the push setup notes in `docs/PUSH.md` and `supabase/functions/send-push/`. You need a new VAPID keypair, new webhook secret, new dispatch URL, the required database extensions/job scheduling, and a real-device permission test. Do not copy another entity's push settings. If web push is not configured, in-app notifications should still work.

## F. Handover and privacy

Keep the repository, database, website, admin mailbox, billing and recovery codes controlled by your entity. Use fresh MFA and a password manager; maintain data backups. Personal data, comments, creative files, review history and notification devices belong to this entity and must not be exported into a public GitHub repo.

## G. Known limits

- Site and database setup is technical and uses CLI commands; uploading a ZIP to GitHub alone does not create a running application.
- This is the functionality of the archived source revision, with branding/identity neutralized; it is not a guarantee of security, legal compliance, or physical-device push delivery.
- Configure and test on a fresh project before treating it as production.
- The included Express/SQLite server is retained as a legacy test fixture; the live cloud workflow is Supabase + Netlify. Avoid pointing tests or CLI migrations at any existing entity's real data.
