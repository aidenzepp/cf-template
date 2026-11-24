import { Schema } from "effect";
import { Knob } from "@workspace/config/knob";

/**
 * The longest a sign-up retry must wait before it may reclaim an abandoned half-written user row,
 * in seconds.
 *
 * The floor of 60 is longer than one D1 statement (30 s limit) plus any user database hooks (none
 * today), so a reclaim never races a sign-up still writing its `account` row. The ceiling keeps a
 * stuck address recoverable within an hour. The hook, the runbook line, the sign-up copy and any
 * later sweep share this one value.
 */
export const AUTH_ORPHAN_GRACE_SECONDS = Knob.make(
  "AUTH_ORPHAN_GRACE_SECONDS",
  Schema.Int.pipe(Schema.check(Schema.isBetween({ maximum: 3600, minimum: 60 }))).annotate({
    default: 600,
    description:
      "Seconds an unverified user row with no credential must age before a sign-up retry may reclaim it, 60 to 3600.",
  }),
);
