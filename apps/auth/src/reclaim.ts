import { and, eq, lt, sql } from "drizzle-orm";
import type { EffectSQLiteD1Database } from "drizzle-orm/effect-d1";
import { createAuthMiddleware } from "better-auth/api";
import type { RuntimeContext } from "alchemy";
import { Clock, Context, Effect, Option, Schema } from "effect";
import { Knob } from "@workspace/config/knob";
import { account, passkey, user } from "./db/schema.ts";
import type { RunEffect } from "./password.ts";

/**
 * The longest a sign-up retry must wait before it may reclaim an abandoned half-written user row,
 * in seconds.
 *
 * The floor of 60 is longer than one D1 statement (30 s limit) plus any user database hooks (none
 * today), so a reclaim never races a sign-up still writing its `account` row. The ceiling keeps a
 * stuck address recoverable within an hour. The hook, the runbook line and any later sweep share
 * this one value.
 */
export const AUTH_ORPHAN_GRACE_SECONDS = Knob.make(
  "AUTH_ORPHAN_GRACE_SECONDS",
  Schema.Int.pipe(Schema.check(Schema.isBetween({ maximum: 3600, minimum: 60 }))).annotate({
    default: 600,
    description:
      "Seconds an unverified user row with no credential must age before a sign-up retry may reclaim it, 60 to 3600.",
  }),
);

/**
 * Yields the Drizzle database of one execution, for the reclaim statements that the Better Auth
 * adapter cannot express (a delete guarded by `NOT EXISTS`). Like the adapter's database, it needs
 * the host's `RuntimeContext` to read the raw binding.
 */
export class ReclaimDatabase extends Context.Service<
  ReclaimDatabase,
  Effect.Effect<EffectSQLiteD1Database, never, RuntimeContext>
>()("@workspace/auth/ReclaimDatabase") {}

/**
 * The part of the sign-up body this hook reads.
 */
const SignUpBody = Schema.Struct({ email: Schema.String });

/**
 * Whether the user holds an `account` row or a `passkey` row, as `0` or `1`.
 */
const Held = Schema.Array(Schema.Struct({ account: Schema.Int, passkey: Schema.Int }));

/**
 * The one guarded `DELETE`: the row goes only when its id and address match, it is unverified,
 * `created_at` is before the cutoff, and no `account` or `passkey` row references it. Every guard
 * is evaluated by the statement itself, so a write that lands after any earlier check still keeps
 * the row.
 *
 * @param db - The Drizzle database.
 * @param target - The row to delete.
 * @param target.address - The stored (lowercase) address.
 * @param target.cutoff - Rows created before this instant may go.
 * @param target.id - The user id.
 * @returns The ids deleted: one, or none when a guard held the row.
 */
export const deleteOrphan = (
  db: EffectSQLiteD1Database,
  target: { readonly address: string; readonly cutoff: Date; readonly id: string },
) =>
  db
    .delete(user)
    .where(
      and(
        eq(user.id, target.id),
        eq(user.email, target.address),
        eq(user.emailVerified, false),
        lt(user.createdAt, target.cutoff),
        sql`not exists (select 1 from ${account} where ${account.userId} = ${target.id})`,
        sql`not exists (select 1 from ${passkey} where ${passkey.userId} = ${target.id})`,
      ),
    )
    .returning({ id: user.id });

/**
 * Delete the user row of `email` when it is an abandoned orphan, and log the reclaim.
 *
 * The row goes only when `email_verified = 0`, no `account` row and no `passkey` row references it,
 * and `created_at` is older than the grace. Three statements run: one read of `user` by the
 * normalized address, one check of `account` and `passkey`, and one `DELETE` that repeats the whole
 * predicate and names the row's id and address, so a verification or a credential written between
 * the read and the delete leaves the row in place. The no-row path is the one read. The address is
 * never logged or annotated.
 *
 * @param db - The Drizzle database.
 * @param email - The submitted address, lowercased here as Better Auth does (it does not trim, so
 *   a padded address matches no row and fails its own validation).
 * @param graceSeconds - The minimum age of a reclaimable row, in seconds.
 * @returns An effect that deletes at most that one row.
 */
export const reclaimOrphan = (db: EffectSQLiteD1Database, email: string, graceSeconds: number) =>
  Effect.gen(function* reclaim() {
    const address = email.toLowerCase();

    const [row] = yield* db
      .select({ createdAt: user.createdAt, emailVerified: user.emailVerified, id: user.id })
      .from(user)
      .where(eq(user.email, address));

    const now = yield* Clock.currentTimeMillis;
    const cutoff = new Date(now - graceSeconds * 1000);

    if (row === undefined || row.emailVerified || row.createdAt >= cutoff) {
      return;
    }

    const held = yield* db
      .all(
        sql`select
          exists(select 1 from ${account} where ${account.userId} = ${row.id}) as account,
          exists(select 1 from ${passkey} where ${passkey.userId} = ${row.id}) as passkey`,
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Held)));

    if (held.some((credential) => credential.account > 0 || credential.passkey > 0)) {
      return;
    }

    const deleted = yield* deleteOrphan(db, { address, cutoff, id: row.id });

    if (deleted.length === 0) {
      return;
    }

    const attributes = {
      ageSeconds: Math.floor((now - row.createdAt.getTime()) / 1000),
      userId: row.id,
    };

    yield* Effect.logInfo("auth.orphan.reclaim").pipe(
      Effect.annotateLogs(attributes),
      Effect.withSpan("auth.orphan.reclaim", { attributes }),
    );
  });

/**
 * What the reclaim hook needs from one execution.
 */
export interface ReclaimOptions {
  /**
   * Yields the execution's database, once the adapter has built it.
   */
  readonly db: Effect.Effect<EffectSQLiteD1Database>;
  /**
   * The bound `AUTH_METHODS.email`. With the mail add-in on, upstream heals the orphan, so the hook
   * does nothing.
   */
  readonly emailLive: boolean;
  readonly graceSeconds: number;
  readonly run: RunEffect;
}

/**
 * The `hooks.before` middleware that lets a sign-up retry reclaim an unverified orphan row.
 *
 * Email and password sign-up writes `user` and then `account`, and D1 has no rollback across the
 * two, so a failure between them strands the address. On `POST /auth/sign-up/email`, before the
 * body is processed, the hook runs {@link reclaimOrphan}, unless the mail add-in is on. Deleting
 * before the body is validated is harmless: the deleted row has no credential, so it could not
 * authenticate. A failure of the reclaim is logged by name only (a driver error can carry the
 * address) and the sign-up proceeds.
 *
 * @param options - The database, the mail flag, the grace and the effect runner.
 * @returns The middleware to register as `hooks.before`.
 */
export const reclaimOrphanBeforeSignUp = (options: ReclaimOptions) =>
  createAuthMiddleware(async (ctx) => {
    if (options.emailLive || ctx.path !== "/sign-up/email") {
      return;
    }

    const body = Schema.decodeUnknownOption(SignUpBody)(ctx.body);

    if (Option.isNone(body)) {
      return;
    }

    await options.run(
      options.db.pipe(
        Effect.flatMap((db) => reclaimOrphan(db, body.value.email, options.graceSeconds)),
        Effect.catchCause(() => Effect.logWarning("auth.orphan.reclaim_failed")),
      ),
    );
  });
