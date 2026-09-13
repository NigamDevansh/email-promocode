/** Browser boundary used by the auth retry policy and its Node tests. */
export interface TokenPort {
  get(interactive: boolean): Promise<string | null>
  remove(token: string): Promise<void>
}

export interface AuthorizedFetchDeps {
  tokens: TokenPort
  fetchImpl: typeof fetch
  /** Persists `reauth_required` so scheduled sync can stop. */
  onReauthRequired: () => Promise<void>
}
