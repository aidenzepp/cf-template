import { useAtom } from "@effect/atom-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/ui/card";
import { Field, FieldLabel } from "@workspace/ui/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@workspace/ui/components/ui/radio-group";
import { Schema } from "effect";
import { Appearance, appearanceAtom } from "../../lib/appearance.ts";

const decodeAppearance = Schema.decodeUnknownOption(Appearance);

const CHOICES: ReadonlyArray<{ readonly label: string; readonly value: typeof Appearance.Type }> = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

/**
 * The appearance choice: light, dark or the browser's own preference. The choice is kept in this
 * browser's storage and applies at once.
 *
 * @returns The card.
 */
export const AppearanceCard = () => {
  const [appearance, setAppearance] = useAtom(appearanceAtom);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>Saved on this device. System follows your browser.</CardDescription>
      </CardHeader>
      <CardContent>
        <RadioGroup
          aria-label="Appearance"
          onValueChange={(value) => {
            const next = decodeAppearance(value);

            if (next._tag === "Some") {
              setAppearance(next.value);
            }
          }}
          value={appearance}
        >
          {CHOICES.map(({ label, value }) => (
            <Field key={value} orientation="horizontal">
              <RadioGroupItem id={`appearance-${value}`} value={value} />
              <FieldLabel htmlFor={`appearance-${value}`}>{label}</FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      </CardContent>
    </Card>
  );
};
