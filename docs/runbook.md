# Runbook

## Auth

Stuck sign-up address with the mail add-in on (the reclaim hook is off, so the row stays): delete the abandoned row by hand with `DELETE FROM user WHERE email_verified = 0 AND id NOT IN (SELECT user_id FROM account) AND id NOT IN (SELECT user_id FROM passkey) AND created_at < <now - AUTH_ORPHAN_GRACE_SECONDS in milliseconds>;` (`created_at` is Unix milliseconds in the generated schema).

## Limits

I-25 and I-44 fill this section.

## Domain

`workers.dev` is a public suffix, so browsers isolate cookies between accounts but not between Workers of one account; the risk is accepted until an owned domain (I-26).

I-26 fills the rest of this section.

## Build and gates

I-31 and I-38 fill this section.
