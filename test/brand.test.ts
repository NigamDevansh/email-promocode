import assert from 'node:assert/strict'
import test from 'node:test'
import { brandKeyFor, displayBrand } from '../src/utils/brand.ts'

test('multi-label suffixes do not collapse unrelated brands', () => {
  // Both appear in a real Indian Promotions inbox. Taking the last two labels
  // would key both as "co.in" and merge two banks into one brand.
  assert.equal(brandKeyFor('communications.sbi.co.in', 'sbi@communications.sbi.co.in'), 'sbi')
  assert.equal(brandKeyFor('custcomm.hsbc.co.in', 'x@custcomm.hsbc.co.in'), 'hsbc')
})

test('derives the brand key from the registrable domain', () => {
  assert.equal(brandKeyFor('offers.mail.myntra.com', 'a@offers.mail.myntra.com'), 'myntra')
  assert.equal(brandKeyFor('deals.example.co.uk', 'a@deals.example.co.uk'), 'example')
  assert.equal(brandKeyFor('flyai.airindia.com', 'a@flyai.airindia.com'), 'airindia')
  assert.equal(brandKeyFor('campaign1.nipponindia.email', 'a@x'), 'nipponindia')
  assert.equal(brandKeyFor('shop.example.blogspot.com', 'a@x'), 'example')
})

test('is case-insensitive and tolerates a trailing dot', () => {
  assert.equal(brandKeyFor('Offers.Mail.MYNTRA.com.', 'a@x'), 'myntra')
})

test('falls back to the sender address when there is no usable domain', () => {
  assert.equal(brandKeyFor('', '  Weird.Sender  '), 'weird.sender')
  assert.equal(brandKeyFor('', 'Shop <Deals@Example.test>'), 'deals@example.test')
})

test('display name comes from the From header but never becomes identity', () => {
  assert.equal(displayBrand('Myntra <offers@mail.myntra.com>', 'myntra'), 'Myntra')
  assert.equal(displayBrand('"Nippon Life India" <x@y.email>', 'nipponindia'), 'Nippon Life India')
  // No display name: fall back to the key rather than showing a raw address.
  assert.equal(displayBrand('offers@mail.myntra.com', 'myntra'), 'Myntra')
})
