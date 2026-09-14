import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeEntities,
  extractAltTexts,
  extractHrefs,
  extractVisibleText,
} from '../src/utils/html.ts'

test('reads double-quoted, single-quoted and unquoted attribute values', () => {
  const html = `<img alt="First code"><img alt='Second code'><img alt=THIRD40>`
  assert.deepEqual(extractAltTexts(html), ['First code', 'Second code', 'THIRD40'])
})

test('decodes numeric, hex and named entities', () => {
  assert.equal(decodeEntities('&#8377;500 &amp; &#x20B9;200 &mdash; &quot;deal&quot;'), '₹500 & ₹200 — "deal"')
})

test('leaves unknown entities untouched rather than mangling a code', () => {
  assert.equal(decodeEntities('CODE&notanentity;20'), 'CODE&notanentity;20')
})

test('strips script and style bodies before reading visible text', () => {
  const html = '<style>.a{color:red}</style><p>Use code REAL10</p><script>var x="FAKE99"</script>'
  assert.equal(extractVisibleText(html), 'Use code REAL10')
})

test('collapses tags to a space so adjacent elements cannot fuse', () => {
  assert.equal(extractVisibleText('<b>Use code</b><span>SAVE20</span>'), 'Use code SAVE20')
})

test('drops HTML comments, which ESPs use for conditional markup', () => {
  assert.equal(extractVisibleText('<!--[if mso]>OUTLOOK99<![endif]--><p>Hello</p>'), 'Hello')
})

test('reads anchor targets and decodes entity-escaped ampersands in them', () => {
  const html = '<a href="https://x.example/c?coupon=A10&amp;utm=mail">Shop</a>'
  assert.deepEqual(extractHrefs(html), ['https://x.example/c?coupon=A10&utm=mail'])
})

test('does not read links or alt text from comments and script blocks', () => {
  const html = [
    '<!-- <a href="https://x.example/?coupon=COMMENT40">hidden</a> -->',
    '<script><img alt="Use code SCRIPT50">',
    '<a href="https://x.example/?coupon=REAL20">Shop</a>',
  ].join('')

  assert.deepEqual(extractHrefs(html), [])
  assert.deepEqual(extractAltTexts(html), [])
})
