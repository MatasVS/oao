import {
  CONFIGURATION_BACKUP_FORMAT,
  CONFIGURATION_BACKUP_FORMAT_VERSION,
  parseConfigurationBackup,
} from "@oao/contracts";
import type { ConfigurationBackup } from "./api/types";

/** Names a backup like the API's download: `<org-slug>-<YYYY-MM-DD-HHMMSS>.oao-backup.json`. */
export function configurationBackupFileName(
  backup: ConfigurationBackup,
): string {
  const slug = backup.organization.slug.replace(/[^a-z0-9-]/giu, "-") || "oao";
  const stamp = backup.exportedAt
    .slice(0, 19)
    .replaceAll(":", "")
    .replace("T", "-");
  return `${slug}-${stamp}.oao-backup.json`;
}

/** Explains a failed backup parse the way the API does: where, and what is wrong. */
export function configurationBackupProblem(error: unknown): string {
  const issue =
    error && typeof error === "object" && "issues" in error
      ? (
          error as {
            readonly issues: readonly {
              readonly message: string;
              readonly path?: readonly { readonly key: unknown }[];
            }[];
          }
        ).issues[0]
      : undefined;
  const path = issue?.path?.map((entry) => String(entry.key)).join(".");
  return issue
    ? `The backup is not a valid OAO configuration backup${path ? ` at ${path}` : ""}: ${issue.message}`
    : "The backup is not a valid OAO configuration backup";
}

/** Reads a backup file, saying exactly why a file is refused. */
export function readConfigurationBackup(text: string): ConfigurationBackup {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The file is not valid JSON.");
  }
  const header = (value && typeof value === "object" ? value : {}) as Readonly<
    Record<string, unknown>
  >;
  if (header.format !== CONFIGURATION_BACKUP_FORMAT)
    throw new Error(
      "The file is not an OAO configuration backup. Download one from the Organization page first.",
    );
  if (header.formatVersion !== CONFIGURATION_BACKUP_FORMAT_VERSION)
    throw new Error(
      `The backup uses format version ${String(header.formatVersion)}; this console reads version ${CONFIGURATION_BACKUP_FORMAT_VERSION}.`,
    );
  try {
    return parseConfigurationBackup(value);
  } catch (error) {
    throw new Error(configurationBackupProblem(error), { cause: error });
  }
}
