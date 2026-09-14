import { getDomain, getDomainWithoutSuffix } from 'tldts'

const DOMAIN_OPTIONS = { allowPrivateDomains: true } as const

/** Registrable domain according to the current Public Suffix List. */
export function registrableDomain(domain: string): string {
  return getDomain(domain, DOMAIN_OPTIONS) ?? ''
}

/** Stable identity derived from the sender domain, never from an LLM name. */
export function brandKeyFor(senderDomain: string, sender: string): string {
  const domainKey = getDomainWithoutSuffix(senderDomain, DOMAIN_OPTIONS)
  if (domainKey) return domainKey.toLowerCase()

  const address = /<([^>]+)>/.exec(sender)?.[1] ?? sender
  return address.trim().toLowerCase()
}

/** Human-readable sender name used only for display. */
export function displayBrand(from: string, brandKey: string): string {
  const quoted = /^\s*"([^"]+)"\s*</.exec(from)?.[1]
  const bare = /^\s*([^<]+?)\s*</.exec(from)?.[1]
  const name = (quoted ?? bare ?? '').trim()

  if (name && !name.includes('@')) return name
  return brandKey ? brandKey.charAt(0).toUpperCase() + brandKey.slice(1) : from
}
