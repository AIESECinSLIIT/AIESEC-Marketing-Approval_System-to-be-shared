-- pg_net cannot be relocated. Reinstall the new transport extension in the
-- extensions namespace before enabling any real-device subscriptions.
drop extension pg_net;
create extension pg_net with schema extensions;
revoke all on schema net from public,anon,authenticated;
revoke all on all tables in schema net from public,anon,authenticated;
revoke all on all sequences in schema net from public,anon,authenticated;
revoke all on all functions in schema net from public,anon,authenticated;

