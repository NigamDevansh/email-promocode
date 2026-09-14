import type { ChatTurnRecord } from '../types/chat.js'
import type { PopupRequest, PopupResponse, SyncStatus } from '../types/messaging.js'
import type { OfferRecord } from '../types/storage.js'
import { describeConditions, describeExpiry, expiryStateOf } from '../utils/expiry.js'
import { gmailThreadUrl, offerKey } from '../utils/offers.js'

const syncStripEl = document.querySelector<HTMLDivElement>('#syncStrip')!
const headerStatusEl = document.querySelector<HTMLParagraphElement>('#headerStatus')!
const settingsEl = document.querySelector<HTMLButtonElement>('#settings')!
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

function send(request: PopupRequest): Promise<PopupResponse> {
  return chrome.runtime.sendMessage(request) as Promise<PopupResponse>
}

function showConnect(message: string = ''): void {
  connectViewEl.hidden = false
  chatViewEl.hidden = true
  syncStripEl.hidden = true
  connectErrorEl.textContent = message
  headerStatusEl.textContent = 'Connect once to organize your Promotions coupons.'
  if (syncTimer !== undefined) window.clearInterval(syncTimer)
}

function showChat(): void {
  connectViewEl.hidden = true
  chatViewEl.hidden = false
  questionEl.focus()
}

function offerCard(offer: OfferRecord): HTMLElement {
  const card = document.createElement('article')
  card.className = 'offer-card'

  const brand = document.createElement('span')
  brand.className = 'offer-brand'
  brand.textContent = offer.brand

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
        code.textContent = 'Copied'
        window.setTimeout(() => {
          code.textContent = offer.code
        }, 900)
      },
      () => {
        chatStatusEl.classList.add('error')
        chatStatusEl.textContent = 'Could not copy the code. Open the source email instead.'
      },
    )
  })

  const head = document.createElement('div')
  head.className = 'offer-card-head'
  head.append(brand, code)

  const detail = document.createElement('p')
  detail.className = 'offer-detail'
  detail.textContent = [
    offer.discount,
    describeExpiry(expiryStateOf(offer.expiry, new Date())),
    describeConditions(offer),
    offer.needsReview ? 'Verify in the email' : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const source = document.createElement('a')
  source.className = 'offer-source'
  source.href = gmailThreadUrl(offer)
  source.target = '_blank'
  source.rel = 'noreferrer'
  source.textContent = 'Open source email'

  card.append(head, detail, source)
  return card
}

function renderConversation(): void {
  const byKey = new Map(offers.map((offer) => [offerKey(offer), offer]))

  if (chatTurns.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'empty-chat'
    empty.textContent = hasApiKey
      ? 'Ask about a brand, minimum spend, expiry, or the best coupon for your cart.'
      : 'Add your LLM API key from the gear above, then ask for any coupon.'
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

  conversationEl.replaceChildren(...nodes)
  nodes.at(-1)?.scrollIntoView({ block: 'end' })
}

function applySyncStatus(status: SyncStatus): void {
  syncStripEl.className = 'sync-strip'
  syncStripEl.hidden = status.state === 'ready'

  if (status.state === 'ready') {
    headerStatusEl.textContent = hasApiKey
      ? 'Ask anything about your saved coupons.'
      : 'Coupons are ready. Add an API key in Settings to chat.'
    return
  }

  if (status.state === 'blocked') {
    syncStripEl.classList.add('blocked')
    syncStripEl.title = `Coupon loading paused: ${status.message ?? 'check Settings'}`
    headerStatusEl.textContent = 'Coupon loading needs attention in Settings.'
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
    headerStatusEl.textContent = 'Coupons are updating in the background.'
    return
  }

  syncStripEl.title =
    'Your promotional codes are being loaded. You can still chat with coupons already found.'
  headerStatusEl.textContent = status.totalProcessed
    ? `${status.totalProcessed} promotional emails checked. Still updating…`
    : 'Checking your Promotions coupons…'
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
  chatStatusEl.textContent = 'Finding the best coupon…'
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
