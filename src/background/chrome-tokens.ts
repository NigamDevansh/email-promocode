import type { TokenPort, TokenRequest } from '../types/auth.js'

/*
 * The only Chrome Identity binding in the codebase. Kept apart from auth.ts so
 * the retry policy there stays importable in Node tests.
 *
 * @types/chrome has changed the getAuthToken callback shape across releases
 * (a bare string, then a result object). Narrowing it here keeps the build from
 * depending on which one is installed.
 */
interface IdentityApi {
  getAuthToken(
    details: { interactive: boolean },
    callback: (result: string | { token?: string } | undefined) => void,
  ): void
  removeCachedAuthToken(details: { token: string }, callback: () => void): void
}

const identity = chrome.identity as unknown as IdentityApi


export function requestAuthToken(interactive: boolean): Promise<TokenRequest> {
  return new Promise((resolve) => {
    identity.getAuthToken({ interactive }, (result) => {
      const error = chrome.runtime.lastError?.message ?? null
      const token = typeof result === 'string' ? result : (result?.token ?? null)
      resolve({ token: error ? null : token, error })
    })
  })
}

export const chromeTokens: TokenPort = {
  async get(interactive) {
    return (await requestAuthToken(interactive)).token
  },
  remove(token) {
    return new Promise((resolve, reject) => {
      identity.removeCachedAuthToken({ token }, () => {
        const error = chrome.runtime.lastError
        if (error) {
          reject(new Error(error.message))
          return
        }
        resolve()
      })
    })
  },
}
