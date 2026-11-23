/**
 * Labels the factory puts on a ticket to track its progress. Every tracker
 * vendor must be able to store these on a ticket: no spaces, lowercase.
 */
export const LABELS = {
  building: "factory-building",
  prOpen: "factory-pr-open",
  reviewed: "factory-reviewed",
  merged: "factory-merged",
  blocked: "factory-blocked",
  verified: "factory-verified",
  verifyFailed: "factory-verify-failed",
} as const;

export type Labels = typeof LABELS;
