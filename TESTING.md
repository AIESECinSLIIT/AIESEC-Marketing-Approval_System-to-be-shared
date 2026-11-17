# Role and approval smoke test for a fresh entity

Test only in YOUR own new project using disposable accounts and data.

- [ ] Customized entity logo/name appear on login, dashboard, and notification labels
- [ ] The exact configured Super Admin email can receive/administer the ADMIN profile
- [ ] An ordinary user cannot grant themselves ADMIN, LCVP, IGP, or IGVP authority
- [ ] Super Admin can create events, Initiative Groups and assign leadership roles
- [ ] LCVP EM can manage its IG hierarchy but not root-entity leadership
- [ ] IGP can manage its IG's permitted members and Event Managers only
- [ ] Marketing category root submission routes directly to LCVP Marketing
- [ ] B2C category root submission routes directly to LCVP B2C
- [ ] IG Marketing submission -> IGVP Marketing -> LCVP Marketing
- [ ] IG B2C submission -> IGVP OGV -> LCVP B2C
- [ ] IGVP-originated submission goes directly to matching category LCVP
- [ ] IG approval alone does not mark a submission finally approved
- [ ] Self-approval fails even when the same person switches profiles
- [ ] Request changes -> revise -> resubmit restarts the intended stage
- [ ] Approval/rejection and version history are visible only to authorized profiles
- [ ] Category/IG/event-scoped notifications reach appropriate users once
- [ ] Event-only OCP and Event Manager cannot see unrelated submissions
- [ ] Private creatives are not publicly readable; cleanup removes files, not history
- [ ] Deleting one profile does not remove another profile on the same login
- [ ] Browser and phone layouts work; mobile push needs a real device check

If any permission check fails, do not go live. Verify SQL migrations and Edge Functions are deployed to the NEW project.
