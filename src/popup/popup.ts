import type { MessageSummary, PopupRequest, PopupResponse } from '../types/messaging.js'
import type { OfferRecord } from '../types/storage.js'
import { describeConditions, describeExpiry, expiryStateOf } from '../utils/expiry.js'
import { gmailThreadUrl, searchOffers, sortOffersForDisplay } from '../utils/offers.js'

const statusEl = document.querySelector<HTMLParagraphElement>('#status')!
const connectEl = document.querySelector<HTMLButtonElement>('#connect')!
const refreshEl = document.querySelector<HTMLButtonElement>('#refresh')!
const settingsEl = document.querySelector<HTMLButtonElement>('#settings')!
const listEl = document.querySelector<HTMLUListElement>('#messages')!
const scanEl = document.querySelector<HTMLButtonElement>('#scan')!
const progressEl = document.querySelector<HTMLParagraphElement>('#progress')!
const searchEl = document.querySelector<HTMLInputElement>('#search')!
const offersEl = document.querySelector<HTMLUListElement>('#offers')!
const offersEmptyEl = document.querySelector<HTMLParagraphElement>('#offers-empty')!

function send(request: PopupRequest): Promise<PopupResponse> {
  return chrome.runtime.sendMessage(request) as Promise<PopupResponse>
}

let allOffers: OfferRecord[] = []

function renderMessages(messages: MessageSummary[]): void {
  listEl.replaceChildren(
    ...messages.map((message) => {
      const subject = document.createElement('span')
      subject.className = 'subject'
      subject.textContent = message.subject

      const meta = document.createElement('span')
      meta.className = 'meta'
      meta.textContent = `${message.from} · ${new Date(message.date).toLocaleDateString()}`

      const item = document.createElement('li')
      item.append(subject, meta)
      return item
    }),
  )
}

function offerCard(offer: OfferRecord, today: Date): HTMLLIElement {
  const state = expiryStateOf(offer.expiry, today)

  const code = document.createElement('button')
  code.type = 'button'
  code.className = 'offer-code'
  code.textContent = offer.code
  code.title = 'Copy code'
  code.setAttribute('aria-label', `Copy coupon code ${offer.code}`)
  code.addEventListener('click', () => {
    void navigator.clipboard.writeText(offer.code).then(
      () => {
        code.textContent = 'Copied'
        setTimeout(() => {
          code.textContent = offer.code
        }, 900)
      },
      () => undefined,
    )
  })

  const brand = document.createElement('span')
  brand.className = 'offer-brand'
  brand.textContent = offer.brand

  const head = document.createElement('div')
  head.className = 'offer-head'
  head.append(code, brand)

  // Section 11: an unverified code is labelled as one rather than shown plainly.
  if (offer.needsReview) {
    const badge = document.createElement('span')
    badge.className = 'badge'
    badge.textContent = 'unverified'
    badge.title = 'Read from email text; open the email to confirm'
    head.append(badge)
  }

  const meta = document.createElement('span')
  meta.className = 'offer-meta'
  // Section 10: never show a code without what blocks using it.
  meta.textContent = [describeExpiry(state), describeConditions(offer), offer.discount]
    .filter(Boolean)
    .join(' · ')

  const link = document.createElement('a')
  link.className = 'offer-subject'
  link.href = gmailThreadUrl(offer)
  link.target = '_blank'
  link.rel = 'noreferrer'
  link.textContent = offer.sourceSubject || 'Open source email'

  const item = document.createElement('li')
  item.className = state.kind === 'expired' ? 'offer offer-expired' : 'offer'
  item.append(head, meta, link)
  return item
}

function renderOffers(): void {
  const today = new Date()
  const matching = sortOffersForDisplay(searchOffers(allOffers, searchEl.value), today)

  offersEl.replaceChildren(...matching.map((offer) => offerCard(offer, today)))

  const empty = matching.length === 0
  offersEmptyEl.hidden = !empty
  offersEmptyEl.textContent = allOffers.length
    ? 'No codes match that search.'
    : 'No saved codes yet.'
  searchEl.hidden = allOffers.length === 0
}

async function loadOffers(): Promise<void> {
  const response = await send({ type: 'list-offers' })
  if (!response.ok) return

  allOffers = response.offers ?? []
  renderOffers()
}

function showDisconnected(message: string): void {
  statusEl.textContent = message
  connectEl.hidden = false
  refreshEl.hidden = true
  scanEl.hidden = true
  progressEl.textContent = ''
  listEl.replaceChildren()
}

/** Drives backfill slices until the window is scanned or something fails. */
async function scanInbox(): Promise<void> {
  scanEl.disabled = true
  try {
    for (;;) {
      const response = await send({ type: 'sync' })

      if (!response.ok) {
        if (response.authState !== 'connected') {
          showDisconnected('Google access needs reconnecting.')
          break
        }
        progressEl.textContent = response.error
        break
      }

      const progress = response.progress
      if (!progress) break

      // A slice may store offers before hitting a retryable error.
      await loadOffers()

      if (progress.nextAttemptAt && progress.nextAttemptAt > Date.now()) {
        const retryTime = new Date(progress.nextAttemptAt).toLocaleTimeString()
        progressEl.textContent = `Paused after a temporary error. Try again after ${retryTime}.`
        break
      }

      progressEl.textContent = progress.remaining
        ? `Scanned ${progress.totalProcessed} messages. Continuing…`
        : `Scan complete: ${progress.totalProcessed} messages scanned.`

      if (progress.error) {
        progressEl.textContent = `Paused: ${progress.error}`
        break
      }
      if (!progress.remaining) break
    }
  } catch (error) {
    progressEl.textContent = error instanceof Error ? error.message : String(error)
  } finally {
    scanEl.disabled = false
  }
}

async function loadMessages(): Promise<void> {
  statusEl.textContent = 'Reading your Promotions mail…'
  connectEl.hidden = true
  refreshEl.hidden = true
  // A preview failure should not block a connected user from starting a scan.
  scanEl.hidden = false

  const response = await send({ type: 'list-messages' })

  if (!response.ok) {
    if (response.authState === 'connected') {
      statusEl.textContent = response.error
      refreshEl.hidden = false
      return
    }
    showDisconnected('Google access needs reconnecting.')
    return
  }

  const messages = response.messages ?? []
  statusEl.textContent = messages.length
    ? `${messages.length} recent promotional emails.`
    : 'No recent promotional email found.'
  refreshEl.hidden = false
  scanEl.hidden = false
  renderMessages(messages)
}

connectEl.addEventListener('click', async () => {
  connectEl.hidden = true
  statusEl.textContent = 'Waiting for Google…'

  const response = await send({ type: 'connect' })
  if (response.ok && response.authState === 'connected') {
    await loadMessages()
    await loadOffers()
    return
  }
  showDisconnected(response.ok ? 'Connection did not complete.' : response.error)
})

refreshEl.addEventListener('click', () => {
  void loadMessages()
})

scanEl.addEventListener('click', () => {
  void scanInbox()
})

settingsEl.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage()
})

searchEl.addEventListener('input', () => {
  renderOffers()
})

async function start(): Promise<void> {
  // Saved offers remain useful even when Gmail needs reconnecting.
  await loadOffers()
  const response = await send({ type: 'get-state' })
  if (response.ok && response.authState === 'connected') {
    await loadMessages()
    return
  }
  showDisconnected(
    response.authState === 'reauth_required'
      ? 'Google access needs reconnecting.'
      : 'Connect your Gmail account to begin.',
  )
}

void start()
