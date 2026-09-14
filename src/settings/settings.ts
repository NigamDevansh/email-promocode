import type { PopupRequest, PopupResponse, SettingsView } from '../types/messaging.js'
import type { ProviderId } from '../types/llm.js'
import { DEFAULT_MODELS, PROVIDER_LABELS, PROVIDERS } from '../utils/settings.js'

const form = document.querySelector<HTMLFormElement>('#form')!
const providerEl = document.querySelector<HTMLSelectElement>('#provider')!
const modelEl = document.querySelector<HTMLInputElement>('#model')!
const apiKeyEl = document.querySelector<HTMLInputElement>('#apiKey')!
const keyStateEl = document.querySelector<HTMLParagraphElement>('#keyState')!
const clearKeyEl = document.querySelector<HTMLButtonElement>('#clearKey')!
const statusEl = document.querySelector<HTMLSpanElement>('#status')!
const saveEl = document.querySelector<HTMLButtonElement>('#save')!

function send(request: PopupRequest): Promise<PopupResponse> {
  return chrome.runtime.sendMessage(request) as Promise<PopupResponse>
}

providerEl.replaceChildren(
  ...PROVIDERS.map((provider) => {
    const option = document.createElement('option')
    option.value = provider
    option.textContent = PROVIDER_LABELS[provider]
    return option
  }),
)

function apply(view: SettingsView): void {
  providerEl.value = view.provider
  modelEl.value = view.model

  // The raw key never reaches this page; only whether one exists.
  apiKeyEl.value = ''
  keyStateEl.textContent = view.hasApiKey
    ? `A key is stored (${view.apiKeyMasked}). Leave blank to keep it.`
    : 'No key stored yet. Coupon details and chat stay unavailable until one is set.'
  clearKeyEl.hidden = !view.hasApiKey
}

providerEl.addEventListener('change', () => {
  const provider = providerEl.value as ProviderId
  modelEl.value = DEFAULT_MODELS[provider]
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  statusEl.textContent = 'Saving…'
  saveEl.disabled = true

  try {
    const response = await send({
      type: 'save-settings',
      settings: {
        provider: providerEl.value as ProviderId,
        model: modelEl.value.trim(),
        apiKey: apiKeyEl.value,
      },
    })

    if (!response.ok || !response.settings) {
      statusEl.textContent = response.ok ? 'Could not save. Please try again.' : response.error
      return
    }

    apply(response.settings)
    statusEl.textContent = 'Saved.'
  } catch {
    statusEl.textContent = 'Could not save. Please try again.'
  } finally {
    saveEl.disabled = false
  }
})

clearKeyEl.addEventListener('click', async () => {
  clearKeyEl.disabled = true
  statusEl.textContent = 'Removing key…'
  try {
    const response = await send({ type: 'clear-api-key' })
    if (response.ok && response.settings) {
      apply(response.settings)
      statusEl.textContent = 'Key removed.'
      return
    }
    statusEl.textContent = response.ok ? 'Could not remove the key.' : response.error
  } catch {
    statusEl.textContent = 'Could not remove the key. Please try again.'
  } finally {
    clearKeyEl.disabled = false
  }
})

async function start(): Promise<void> {
  try {
    const response = await send({ type: 'get-settings' })
    if (response.ok && response.settings) apply(response.settings)
  } catch {
    statusEl.textContent = 'Could not load Settings. Reload this page to try again.'
  }
}

void start()
