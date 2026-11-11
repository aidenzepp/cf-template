import { Button } from "@workspace/ui/components/ui/button";
import { authClient } from "../../lib/auth-client.ts";

const PROVIDER_NAMES = new Map([
  ["github", "GitHub"],
  ["google", "Google"],
]);

/**
 * One button per live OAuth provider; nothing renders for an empty list.
 *
 * @param props - The buttons' props.
 * @param props.providers - The provider ids of `AuthMethods`.
 * @param props.callbackURL - Where the provider sends the person back to.
 * @returns The buttons, or nothing.
 */
export const ProviderButtons = ({
  callbackURL,
  providers,
}: {
  readonly callbackURL: string;
  readonly providers: ReadonlyArray<string>;
}) =>
  providers.length === 0 ? null : (
    <div className="flex flex-col gap-2">
      {providers.map((provider) => (
        <Button
          key={provider}
          onClick={() => {
            void authClient.signIn.social({ callbackURL, provider });
          }}
          type="button"
          variant="outline"
        >
          {`Continue with ${PROVIDER_NAMES.get(provider) ?? provider}`}
        </Button>
      ))}
    </div>
  );
