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

export interface TokenRequest {
  token: string | null
  /** chrome.runtime.lastError, preserved so the popup can say what failed. */
  error: string | null
}

/** Narrow Chrome Identity surface used by the browser adapter. */
export interface IdentityApi {
  getAuthToken(
    details: { interactive: boolean },
    callback: (result: string | { token?: string } | undefined) => void,
  ): void
  removeCachedAuthToken(details: { token: string }, callback: () => void): void
}
