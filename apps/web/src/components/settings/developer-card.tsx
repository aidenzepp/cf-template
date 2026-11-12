import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/ui/card";

/**
 * A placeholder for the developer tab. API keys land here later; nothing here calls a server.
 *
 * @returns The card.
 */
export const DeveloperCard = () => (
  <Card>
    <CardHeader>
      <CardTitle>API keys</CardTitle>
      <CardDescription>Keys for scripts and tools will be created here.</CardDescription>
    </CardHeader>
    <CardContent>
      <p className="text-sm text-muted-foreground">Nothing to set up yet.</p>
    </CardContent>
  </Card>
);
