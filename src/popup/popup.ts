import type { MessageSummary, PopupRequest, PopupResponse } from '../types/messaging.js'

const statusEl = document.querySelector<HTMLParagraphElement>('#status')!
const connectEl = document.querySelector<HTMLButtonElement>('#connect')!
const refreshEl = document.querySelector<HTMLButtonElement>('#refresh')!
const listEl = document.querySelector<HTMLUListElement>('#messages')!

function send(request: PopupRequest): Promise<PopupResponse> {
  return chrome.runtime.sendMessage(request) as Promise<PopupResponse>
}

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

function showDisconnected(message: string): void {
  statusEl.textContent = message
  connectEl.hidden = false
  refreshEl.hidden = true
  listEl.replaceChildren()
}

async function loadMessages(): Promise<void> {
  statusEl.textContent = 'Reading your Promotions mail…'
  connectEl.hidden = true
  refreshEl.hidden = true

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
    : 'No promotional email in the last 45 days.'
  refreshEl.hidden = false
  renderMessages(messages)
}

connectEl.addEventListener('click', async () => {
  connectEl.hidden = true
  statusEl.textContent = 'Waiting for Google…'

  const response = await send({ type: 'connect' })
  if (response.ok && response.authState === 'connected') {
    await loadMessages()
    return
  }
  showDisconnected(response.ok ? 'Connection did not complete.' : response.error)
})

refreshEl.addEventListener('click', () => {
  void loadMessages()
})

async function start(): Promise<void> {
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
