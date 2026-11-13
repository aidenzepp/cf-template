import { Context, Effect, Schema } from "effect";

/**
 * One plain-text message to send.
 */
export const Mail = Schema.Struct({
  subject: Schema.String,
  text: Schema.String,
  to: Schema.String,
});

/**
 * The failure of one send: the provider refused the message or could not be reached. The `message`
 * must not carry the recipient address or the mail body; the add-in that raises it keeps both out.
 */
export class MailerError extends Schema.TaggedError<
  MailerError,
  { readonly brand: unique symbol }
>()("MailerError", {
  cause: Schema.Unknown,
  message: Schema.String,
}) {}

/**
 * The capability to send one message.
 */
interface MailerService {
  readonly send: (mail: typeof Mail.Type) => Effect.Effect<void, MailerError>;
}

/**
 * The sender used when no mail add-in provides one: it logs one warning with the fixed event name
 * and the subject, never the recipient address or the body, and sends nothing.
 */
const None: MailerService = {
  send: Effect.fn("Mailer.None.send")(function* send(mail) {
    yield* Effect.logWarning("mailer.none").pipe(Effect.annotateLogs({ subject: mail.subject }));
  }),
};

/**
 * The optional mail port. Core reads it and works without a provider; the email add-in provides it.
 * Without one, {@link None} answers.
 */
export const Mailer = Object.assign(
  Context.Reference<MailerService>("@workspace/config/Mailer", { defaultValue: () => None }),
  { None },
);
