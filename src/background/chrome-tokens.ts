import type { IdentityApi, TokenPort, TokenRequest } from '../types/auth.js'

/** Chrome Identity adapter; the auth retry policy stays browser-independent. */
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
