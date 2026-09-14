export type ExpiryState =
  | { kind: 'unknown' }
  | { kind: 'active'; daysLeft: number }
  | { kind: 'expired'; daysAgo: number }
