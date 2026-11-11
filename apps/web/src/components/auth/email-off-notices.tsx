/**
 * Shown on sign-in in place of the reset link when no email provider is live.
 *
 * @param props - The notice's props.
 * @param props.email - `AuthMethods.email`: whether reset mail exists.
 * @returns The line, or nothing when email is live.
 */
export const PasswordResetNotice = ({ email }: { readonly email: boolean }) =>
  email ? null : (
    <p className="text-muted-foreground text-sm">
      Forgot your password? It can't be reset on this site yet. If you added a passkey or linked an
      account, sign in with that.
    </p>
  );

/**
 * Shown on sign-up when no email provider is live, nudging toward a passkey.
 *
 * @param props - The hint's props.
 * @param props.email - `AuthMethods.email`: whether reset mail exists.
 * @returns The hint, or nothing when email is live.
 */
export const PasskeyNudge = ({ email }: { readonly email: boolean }) =>
  email ? null : (
    <p className="text-muted-foreground text-sm">
      Add a passkey in Settings after you sign up. Without email it is your way back in if you
      forget your password.
    </p>
  );
