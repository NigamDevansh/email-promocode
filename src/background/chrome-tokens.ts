import type { TokenPort } from '../types/auth.js'

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

export const chromeTokens: TokenPort = {
  get(interactive) {
    return new Promise((resolve) => {
      identity.getAuthToken({ interactive }, (result) => {
        if (chrome.runtime.lastError || !result) {
          resolve(null)
          return
        }
        resolve(typeof result === 'string' ? result : (result.token ?? null))
      })
    })
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
