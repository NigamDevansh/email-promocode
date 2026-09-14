import type { ChatTurnRecord } from '../types/chat.js'
import type { PopupRequest, PopupResponse, SyncStatus } from '../types/messaging.js'
import type { OfferRecord } from '../types/storage.js'
import { describeConditions, describeExpiry, expiryStateOf } from '../utils/expiry.js'
import { gmailThreadUrl, offerKey } from '../utils/offers.js'

const syncStripEl = document.querySelector<HTMLDivElement>('#syncStrip')!
const headerStatusTextEl = document.querySelector<HTMLSpanElement>('#headerStatusText')!
const headerSpinnerEl = document.querySelector<HTMLSpanElement>('#headerSpinner')!
const settingsEl = document.querySelector<HTMLButtonElement>('#settings')!
const loadingViewEl = document.querySelector<HTMLElement>('#loadingView')!
const connectViewEl = document.querySelector<HTMLElement>('#connectView')!
const connectEl = document.querySelector<HTMLButtonElement>('#connect')!
const connectErrorEl = document.querySelector<HTMLParagraphElement>('#connectError')!
const chatViewEl = document.querySelector<HTMLElement>('#chatView')!
const conversationEl = document.querySelector<HTMLDivElement>('#conversation')!
const chatFormEl = document.querySelector<HTMLFormElement>('#chatForm')!
const questionEl = document.querySelector<HTMLTextAreaElement>('#question')!
const sendEl = document.querySelector<HTMLButtonElement>('#send')!
const chatStatusEl = document.querySelector<HTMLParagraphElement>('#chatStatus')!

let chatTurns: ChatTurnRecord[] = []
let offers: OfferRecord[] = []
let hasApiKey = false
let syncTimer: number | undefined
let awaitingAnswer = false

function send(request: PopupRequest): Promise<PopupResponse> {
  return chrome.runtime.sendMessage(request) as Promise<PopupResponse>
}

function setHeaderStatus(text: string, spinner: '' | 'loading' | 'waiting' | 'blocked' = ''): void {
  headerStatusTextEl.textContent = text
  headerSpinnerEl.hidden = spinner === ''
  headerSpinnerEl.className = `inline-spinner${spinner && spinner !== 'loading' ? ` ${spinner}` : ''}`
}

function showConnect(message: string = ''): void {
  loadingViewEl.hidden = true
  connectViewEl.hidden = false
  chatViewEl.hidden = true
  syncStripEl.hidden = true
  connectErrorEl.textContent = message
  setHeaderStatus('Connect once to organize your Promotions coupons.')
  if (syncTimer !== undefined) window.clearInterval(syncTimer)
}

function showChat(): void {
  loadingViewEl.hidden = true
  connectViewEl.hidden = true
  chatViewEl.hidden = false
  questionEl.focus()
}

function offerCard(offer: OfferRecord): HTMLElement {
  const card = document.createElement('article')
  card.className = 'offer-card'

  const brandWrap = document.createElement('div')
  brandWrap.className = 'offer-brand-wrap'

  const avatar = document.createElement('span')
  avatar.className = 'offer-avatar'
  avatar.textContent = (offer.brand[0] ?? '?').toUpperCase()
  avatar.setAttribute('aria-hidden', 'true')

  const brand = document.createElement('span')
  brand.className = 'offer-brand'
  brand.textContent = offer.brand

  brandWrap.append(avatar, brand)

  const code = document.createElement('button')
  code.type = 'button'
  code.className = 'offer-code'
  code.textContent = offer.code
  code.title = 'Copy coupon code'
  code.setAttribute('aria-label', `Copy coupon code ${offer.code}`)
  code.setAttribute('translate', 'no')
  code.addEventListener('click', () => {
    void navigator.clipboard.writeText(offer.code).then(
      () => {
        code.classList.add('copied')
        code.textContent = 'Copied ✓'
        window.setTimeout(() => {
          code.classList.remove('copied')
          code.textContent = offer.code
        }, 1200)
      },
      () => {
        chatStatusEl.classList.add('error')
        chatStatusEl.textContent = 'Could not copy the code. Open the source email instead.'
      },
    )
  })

  const head = document.createElement('div')
  head.className = 'offer-card-head'
  head.append(brandWrap, code)

  const badges = document.createElement('div')
  badges.className = 'offer-badges'

  if (offer.discount) {
    const discountPill = document.createElement('span')
    discountPill.className = 'offer-pill discount'
    discountPill.textContent = offer.discount
    badges.append(discountPill)
  }

  const expiryState = expiryStateOf(offer.expiry, new Date())
  const expiryDesc = describeExpiry(expiryState)
  if (expiryDesc) {
    const expiryPill = document.createElement('span')
    const isUrgent =
      expiryState.kind === 'expired' ||
      (expiryState.kind === 'active' && expiryState.daysLeft <= 1)
    expiryPill.className = `offer-pill ${isUrgent ? 'urgent' : 'neutral'}`
    expiryPill.textContent = expiryDesc
    badges.append(expiryPill)
  }

  if (offer.needsReview) {
    const reviewPill = document.createElement('span')
    reviewPill.className = 'offer-pill warn'
    reviewPill.textContent = 'Verify in email'
    badges.append(reviewPill)
  }

  const conditions = describeConditions(offer)
  const detail = document.createElement('p')
  detail.className = 'offer-detail'
  detail.textContent = conditions || (badges.children.length === 0 ? 'Promo code found in Promotions' : '')

  const footer = document.createElement('div')
  footer.className = 'offer-footer'

  const source = document.createElement('a')
  source.className = 'offer-source'
  source.href = gmailThreadUrl(offer)
  source.target = '_blank'
  source.rel = 'noreferrer'
  source.innerHTML = `<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M2.5 4A1.5 1.5 0 0 0 1 5.5v9A1.5 1.5 0 0 0 2.5 16h15a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 17.5 4h-15ZM2 6.13l7.47 4.98a1 1 0 0 0 1.06 0L18 6.13V14.5a.5.5 0 0 1-.5.5h-15a.5.5 0 0 1-.5-.5V6.13Zm15.35-1.13L10 9.89 2.65 5H17.35Z"/></svg><span>Open source email</span>`

  footer.append(source)

  card.append(head)
  if (badges.children.length > 0) card.append(badges)
  if (detail.textContent) card.append(detail)
  card.append(footer)
  return card
}

function renderConversation(): void {
  const byKey = new Map(offers.map((offer) => [offerKey(offer), offer]))

  if (chatTurns.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty-chat'

    const icon = document.createElement('div')
    icon.className = 'empty-chat-icon'
    icon.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM12 6c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3zm-4 8c0-1.33 2.67-2 4-2s4 .67 4 2v2H8v-2z"/></svg>`

    const title = document.createElement('div')
    title.className = 'empty-chat-title'
    title.textContent = 'Ask about your Promotions coupons'

    const desc = document.createElement('p')
    desc.className = 'empty-chat-desc'
    desc.textContent = hasApiKey
      ? 'Ask about a brand, minimum spend, expiry, or the best coupon for your cart.'
      : 'Add your LLM API key from the gear icon above, then ask for any coupon.'

    empty.append(icon, title, desc)

    conversationEl.replaceChildren(empty)
    return
  }

  const nodes = chatTurns.map((turn) => {
    const wrapper = document.createElement('article')
    wrapper.className = `turn turn-${turn.role}`

    const bubble = document.createElement('p')
    bubble.className = 'bubble'
    bubble.textContent = turn.text
    wrapper.append(bubble)

    if (turn.role === 'assistant') {
      for (const key of turn.offerKeys) {
        const offer = byKey.get(key)
        if (offer) wrapper.append(offerCard(offer))
      }
    }
    return wrapper
  })

  if (awaitingAnswer) nodes.push(typingIndicator())

  conversationEl.replaceChildren(...nodes)
  nodes.at(-1)?.scrollIntoView({ block: 'end' })
}

function typingIndicator(): HTMLElement {
  const wrapper = document.createElement('article')
  wrapper.className = 'turn turn-assistant'

  const bubble = document.createElement('p')
  bubble.className = 'bubble bubble-typing'
  bubble.setAttribute('aria-label', 'Finding the best coupon')
  bubble.append(
    document.createElement('span'),
    document.createElement('span'),
    document.createElement('span'),
  )

  wrapper.append(bubble)
  return wrapper
}

function applySyncStatus(status: SyncStatus): void {
  syncStripEl.className = 'sync-strip'
  syncStripEl.hidden = status.state === 'ready'

  if (status.state === 'ready') {
    setHeaderStatus(
      hasApiKey
        ? 'Ask anything about your saved coupons.'
        : 'Coupons are ready. Add an API key in Settings to chat.',
    )
    return
  }

  if (status.state === 'blocked') {
    syncStripEl.classList.add('blocked')
    syncStripEl.title = `Coupon loading paused: ${status.message ?? 'check Settings'}`
    setHeaderStatus('Coupon loading needs attention in Settings.', 'blocked')
    return
  }

  if (status.state === 'waiting') {
    syncStripEl.classList.add('waiting')
    const time = status.nextAttemptAt
      ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
          status.nextAttemptAt,
        )
      : 'shortly'
    syncStripEl.title = `Coupon loading will resume at ${time}. You can still chat with coupons already found.`
    setHeaderStatus('Coupons are updating in the background.', 'waiting')
    return
  }

  syncStripEl.title =
    'Your promotional codes are being loaded. You can still chat with coupons already found.'
  setHeaderStatus(
    status.totalProcessed
      ? `${status.totalProcessed} promotional emails checked. Still updating…`
      : 'Checking your Promotions coupons…',
    'loading',
  )
}

async function refreshSyncStatus(): Promise<void> {
  try {
    const response = await send({ type: 'get-sync-status' })
    if (response.authState !== 'connected') {
      showConnect('Google access expired. Connect again.')
      return
    }
    if (response.ok && response.syncStatus) applySyncStatus(response.syncStatus)
  } catch {
    // The next poll retries after a routine service-worker restart.
  }
}

async function loadSettings(): Promise<void> {
  const response = await send({ type: 'get-settings' })
  if (!response.ok || !response.settings) return
  hasApiKey = response.settings.hasApiKey
  questionEl.disabled = !hasApiKey
  sendEl.disabled = !hasApiKey
  chatStatusEl.textContent = hasApiKey ? '' : 'Add an API key from Settings to start chatting.'
}

async function loadChat(): Promise<void> {
  const response = await send({ type: 'get-chat' })
  if (!response.ok) return
  chatTurns = response.chatTurns ?? []
  offers = response.offers ?? []
  renderConversation()
}

async function enterChat(): Promise<void> {
  showChat()
  await Promise.all([loadSettings(), loadChat(), refreshSyncStatus()])
  renderConversation()
  syncTimer = window.setInterval(() => void refreshSyncStatus(), 1_500)
}

settingsEl.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage()
})

connectEl.addEventListener('click', async () => {
  connectEl.disabled = true
  connectEl.textContent = 'Connecting…'
  connectErrorEl.textContent = ''

  try {
    const response = await send({ type: 'connect' })
    if (response.ok && response.authState === 'connected') {
      await enterChat()
      return
    }
    showConnect(response.ok ? 'Connection did not complete. Please try again.' : response.error)
  } catch {
    showConnect('Could not connect right now. Please try again.')
  } finally {
    connectEl.disabled = false
    connectEl.textContent = 'Connect Google'
  }
})

questionEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    chatFormEl.requestSubmit()
  }
})

chatFormEl.addEventListener('submit', async (event) => {
  event.preventDefault()
  const question = questionEl.value.trim()
  if (!question || !hasApiKey) return

  const previousTurns = chatTurns
  chatTurns = [
    ...chatTurns,
    {
      turnId: 'pending',
      role: 'user',
      text: question,
      offerKeys: [],
      createdAt: Date.now(),
    },
  ]
  questionEl.value = ''
  questionEl.disabled = true
  sendEl.disabled = true
  chatStatusEl.classList.remove('error')
  // The dots in the conversation say this now, where the answer will appear.
  chatStatusEl.textContent = ''
  awaitingAnswer = true
  renderConversation()

  try {
    const response = await send({ type: 'send-chat', question })
    if (!response.ok) throw new Error(response.error)
    chatTurns = response.chatTurns ?? []
    offers = response.offers ?? []
    chatStatusEl.textContent = ''
  } catch (error) {
    chatTurns = previousTurns
    questionEl.value = question
    chatStatusEl.classList.add('error')
    chatStatusEl.textContent =
      error instanceof Error ? error.message : 'Could not answer. Please try again.'
  } finally {
    awaitingAnswer = false
    questionEl.disabled = !hasApiKey
    sendEl.disabled = !hasApiKey
    renderConversation()
    questionEl.focus()
  }
})

async function start(): Promise<void> {
  try {
    const response = await send({ type: 'get-state' })
    if (response.ok && response.authState === 'connected') {
      await enterChat()
      return
    }
    showConnect(
      response.authState === 'reauth_required' ? 'Google access expired. Connect again.' : '',
    )
  } catch {
    showConnect('Could not check Google access. Please try again.')
  }
}

void start()
