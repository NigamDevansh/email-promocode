import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const popup = readFileSync('src/popup/index.html', 'utf8')
const popupCss = readFileSync('src/popup/popup.css', 'utf8')
const settings = readFileSync('src/settings/index.html', 'utf8')

test('the popup exposes only connection, chat and the settings gear', () => {
  assert.match(popup, /id="connect"/)
  assert.match(popup, /id="question"/)
  assert.match(popup, /id="settings"[^>]+aria-label="Open Settings"/)
  assert.doesNotMatch(popup, /id="scan"|id="refresh"|Recent promotional emails/)
})

test('the chat prompt and background progress copy match the simple UX', () => {
  assert.match(popup, /Ask your doubt and get the coupon…/)
  assert.match(popup, /You can still chat with coupons already found/)
  assert.match(popup, /aria-describedby="syncDescription"/)
  assert.match(popupCss, /width: 520px/)
  assert.match(popupCss, /height: 580px/)
  assert.match(popupCss, /color-scheme: light/)
})

test('settings contains provider, model and API key without scan controls', () => {
  assert.match(settings, /id="provider"/)
  assert.match(settings, /id="model"/)
  assert.match(settings, /id="apiKey"/)
  assert.doesNotMatch(settings, /backfillDays|enableOcr|fetchRemoteImages/)
})
