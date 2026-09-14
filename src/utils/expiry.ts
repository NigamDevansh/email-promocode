import type { OfferRecord } from '../types/storage.js'
import type { ExpiryState } from '../types/offers.js'

/** Expiry is stored as a date and evaluated whenever offers are rendered. */

const MS_PER_DAY = 86_400_000

function localDay(value: Date): number {
  return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate())
}

function expiryDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const timestamp = Date.UTC(year, month - 1, day)
  const parsed = new Date(timestamp)

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null
  }
  return timestamp
}

export function expiryStateOf(expiry: string | null, today: Date): ExpiryState {
  if (!expiry) return { kind: 'unknown' }

  const deadline = expiryDay(expiry)
  if (deadline === null) return { kind: 'unknown' }

  const days = Math.round((deadline - localDay(today)) / MS_PER_DAY)
  return days < 0 ? { kind: 'expired', daysAgo: -days } : { kind: 'active', daysLeft: days }
}

export function describeExpiry(state: ExpiryState): string {
  switch (state.kind) {
    case 'unknown':
      return 'No expiry given'
    case 'expired':
      return state.daysAgo === 1 ? 'Expired yesterday' : `Expired ${state.daysAgo} days ago`
    case 'active':
      if (state.daysLeft === 0) return 'Expires today'
      if (state.daysLeft === 1) return 'Expires tomorrow'
      return `${state.daysLeft} days left`
  }
}

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
  AED: 'AED ',
  SGD: 'S$',
  AUD: 'A$',
  CAD: 'C$',
  JPY: '¥',
}

/** Section 9: `min_spend` is numeric and interpreted using `currency`. */
export function formatMoney(amount: number | null, currency: string | null): string | null {
  if (amount === null) return null

  const symbol = currency ? (CURRENCY_SYMBOLS[currency] ?? `${currency} `) : ''
  return `${symbol}${amount.toLocaleString('en-IN')}`
}

/** One short line of blocking conditions, or null when nothing blocks use. */
export function describeConditions(offer: OfferRecord): string | null {
  const parts: string[] = []

  const minSpend = formatMoney(offer.minSpend, offer.currency)
  if (minSpend) parts.push(`Min ${minSpend}`)
  if (offer.newUsersOnly) parts.push('New users only')
  if (offer.appOnly) parts.push('App only')
  if (offer.singleUse === true) parts.push('One-time use')
  if (offer.conditions) parts.push(offer.conditions)

  return parts.length > 0 ? parts.join(' · ') : null
}
