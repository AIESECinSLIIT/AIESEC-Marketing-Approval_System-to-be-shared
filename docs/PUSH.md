# Optional independent web-push setup

This repository contains the same `send-push` Edge Function, subscription storage, retry handling, and notification routing as the source application.

To activate web push in a **new** entity installation:

1. Deploy the `send-push` function to your own Supabase project.
2. Generate a NEW VAPID public/private keypair and a NEW random 32-byte hex webhook secret. Never copy another entity's values.
3. Ensure your database supports the `pg_net` and `pg_cron` facilities referenced in the included migrations and functions. Inspect the relevant migration code for `club.push_settings`, `club_push_config`, `club_claim_push` and the scheduled retry job.
4. In the private `club.push_settings` row, configure the VAPID pair, webhook secret and `dispatch_url` pointing ONLY to **your** project's `/functions/v1/send-push` URL. Keep the key material out of Git and frontend environment variables.
5. Verify the database webhook and retry job invoke YOUR edge function, and test `Send test` from the installed web app on a real device.
6. iPhone/iPad web push requires a supported iOS version and the app added to the Home Screen. The user must grant notification permission.

**Do not mark push as operational until a real end-to-end push test succeeds.** In-app notifications are distinct from optional web push.
