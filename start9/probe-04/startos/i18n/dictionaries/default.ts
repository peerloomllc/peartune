export const DEFAULT_LANG = 'en_US'

const dict = {
  // main.ts
  'Starting the PearTune DHT probe': 0,
  Dashboard: 1,
  'The dashboard is ready': 2,
  'The dashboard is not ready': 3,
  // interfaces.ts
  'Pair devices, choose a music source, and revoke access': 4,
  'Peer-to-peer': 5,
  'The encrypted port phones connect on, forwarded so they can reach this server directly instead of through a relay.': 6,
} as const

/**
 * Plumbing. DO NOT EDIT.
 */
export type I18nKey = keyof typeof dict
export type LangDict = Record<(typeof dict)[I18nKey], string>
export default dict
