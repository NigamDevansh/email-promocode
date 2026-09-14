import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const popup = readFileSync('src/popup/index.html', 'utf8')
const popupCss = readFileSync('src/popup/popup.css', 'utf8')
const settings = readFileSync('src/settings/index.html', 'utf8')
const settingsCss = readFileSync('src/settings/settings.css', 'utf8')

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

test('the popup never sits blank: every wait has something moving on screen', () => {
  // First paint, before the service worker has answered with any state.
  assert.match(popup, /id="loadingView"/)
  assert.match(popup, /id="headerSpinner"[^>]+class="inline-spinner"/)
  assert.match(popupCss, /\.spinner\b/)
  // And the wait for an answer, shown where the answer will appear.
  assert.match(popupCss, /\.bubble-typing\b/)
})

test('the palette is Gmail, not a product of its own', () => {
  for (const css of [popupCss, settingsCss]) {
    assert.match(css, /#1a73e8/, 'Google Blue carries anything actionable')
    assert.doesNotMatch(
      css,
      /#238451|#17663d|#eaf7ef|#dcefe3|#b9d8c4/i,
      'the old green palette is gone',
    )
  }
})

test('the composer shows one focus ring rather than a box inside a pill', () => {
  assert.doesNotMatch(popupCss, /textarea:focus-visible\s*\{[^}]*outline:\s*3px/)
  assert.match(popupCss, /\.composer:focus-within/)
})

test('settings contains provider, model and API key without scan controls', () => {
  assert.match(settings, /id="provider"/)
  assert.match(settings, /id="model"/)
  assert.match(settings, /id="apiKey"/)
  assert.doesNotMatch(settings, /backfillDays|enableOcr|fetchRemoteImages/)
})
