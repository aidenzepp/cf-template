import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/ui/tabs";
import type { ReactNode } from "react";
import { settingsTab } from "../../lib/settings-tab.ts";
import type { SettingsTab } from "../../lib/settings-tab.ts";

/**
 * The tab strip of `/settings` over the vendored `Tabs`, which is never hand-edited. The selected
 * tab belongs to the caller (the route keeps it in the search params); a value that is not a tab is
 * ignored.
 *
 * @param props - The strip's props.
 * @param props.children - The panels, one `SettingsPanel` per tab.
 * @param props.onTabChange - Called with the tab the person chose.
 * @param props.tab - The selected tab.
 * @returns The strip and its panels.
 */
export const SettingsTabs = ({
  children,
  onTabChange,
  tab,
}: {
  readonly children: ReactNode;
  readonly onTabChange: (tab: typeof SettingsTab.Type) => void;
  readonly tab: typeof SettingsTab.Type;
}) => (
  <Tabs
    onValueChange={(value) => {
      const next = settingsTab(value);

      if (next !== undefined) {
        onTabChange(next);
      }
    }}
    value={tab}
  >
    <TabsList>
      <TabsTrigger value="preferences">Preferences</TabsTrigger>
      <TabsTrigger value="account">Account</TabsTrigger>
      <TabsTrigger value="developer">Developer</TabsTrigger>
    </TabsList>
    {children}
  </Tabs>
);

/**
 * The panel of one tab. Only the selected panel is mounted, so a card loads its data when its tab
 * opens.
 *
 * @param props - The panel's props.
 * @param props.children - The cards of the tab.
 * @param props.tab - The tab the panel belongs to.
 * @returns The panel.
 */
export const SettingsPanel = ({
  children,
  tab,
}: {
  readonly children: ReactNode;
  readonly tab: typeof SettingsTab.Type;
}) => (
  <TabsContent value={tab}>
    <div className="flex flex-col gap-4">{children}</div>
  </TabsContent>
);
