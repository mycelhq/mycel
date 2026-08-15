/**
 * Expected Composio tool slugs for send/book/calendar adapters.
 *
 * Verified 2026-08-11 against the live catalogue with prod `COMPOSIO_API_KEY` (mycel/composio-api-key).
 * Outlook tools are double-prefixed (`OUTLOOK_OUTLOOK_*`) in Composio's catalogue — the short forms
 * (`OUTLOOK_SEND_EMAIL` etc.) are absent and would fail at execute time. Re-check with
 * `scripts/verify-composio-slugs.ts` when Composio renames tools. Drift correction without a deploy:
 * `MYCEL_CAPABILITY_PROVIDERS`.
 */
export const EXPECTED_ACTION_SLUGS = {
  gmail_send: "GMAIL_SEND_EMAIL",
  outlook_send: "OUTLOOK_OUTLOOK_SEND_EMAIL",
  google_calendar_book: "GOOGLECALENDAR_CREATE_EVENT",
  outlook_book: "OUTLOOK_OUTLOOK_CALENDAR_CREATE_EVENT",
  google_calendar_events: "GOOGLECALENDAR_EVENTS_LIST",
  outlook_events: "OUTLOOK_OUTLOOK_LIST_EVENTS",
} as const;

/** CRM contact-list reads — verified same day against the live catalogue. */
export const EXPECTED_CRM_READ_SLUGS = {
  hubspot_contacts: "HUBSPOT_HUBSPOT_LIST_CONTACTS",
  pipedrive_persons: "PIPEDRIVE_GET_ALL_PERSONS",
  salesforce_contacts: "SALESFORCE_LIST_CONTACTS",
  attio_people: "ATTIO_LIST_RECORDS",
} as const;

export type ExpectedActionShape = keyof typeof EXPECTED_ACTION_SLUGS;
