/**
 * The capabilities of a private Pro repository.
 */
export const PRO = [
  "mergeSettings",
  "dependabotAlerts",
  "actionsSettings",
  "rulesets",
  "classicProtection",
  "autoMerge",
  "environments",
  "environmentSecrets",
  "shaPin",
] as const;

/**
 * The capabilities of a public repository: Pro plus the code-security features.
 */
export const PUBLIC = [
  ...PRO,
  "forkApproval",
  "privateVulnerabilityReporting",
  "environmentReviewers",
  "secretScanning",
  "pushProtection",
  "codeql",
] as const;
