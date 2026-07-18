/** Feature flag du driver cron Gmail Acquisition — inactif par défaut. */
export function isAcquisitionGmailCronEnabled(): boolean {
  return process.env.ACQUISITION_GMAIL_CRON_ENABLED === "true"
}
