import assert from 'node:assert/strict'
import test from 'node:test'
import type { GmailPart } from '../src/types/gmail.ts'
import {
  collectTextParts,
  decodeBase64Url,
  hydrateExternalParts,
  senderDomainOf,
} from '../src/utils/mime.ts'

const b64url = (value: string): string => Buffer.from(value, 'utf8').toString('base64url')

test('decodes base64url with - and _ and no padding', () => {
  const source = 'subjects?a>b~c'
  const encoded = b64url(source)
  assert.ok(!encoded.includes('='), 'fixture should be unpadded')
  assert.equal(decodeBase64Url(encoded), source)
})

test('honours a declared charset', () => {
  // 0xE9 is é in ISO-8859-1 but invalid standalone UTF-8.
  const latin1 = Buffer.from([0xe9]).toString('base64url')
  assert.equal(decodeBase64Url(latin1, 'iso-8859-1'), 'é')
})

test('falls back to UTF-8 on an unknown charset label rather than throwing', () => {
  assert.equal(decodeBase64Url(b64url('plain'), 'x-not-a-charset'), 'plain')
})

test('separates text and html across a nested tree', () => {
  const payload: GmailPart = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: b64url('plain body') } },
          { mimeType: 'text/html', body: { data: b64url('<p>html body</p>') } },
        ],
      },
    ],
  }
  assert.deepEqual(collectTextParts(payload), {
    text: 'plain body',
    html: '<p>html body</p>',
    external: [],
  })
})

test('skips attachments identified by filename or disposition', () => {
  const payload: GmailPart = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/plain', body: { data: b64url('keep') } },
      { mimeType: 'text/plain', filename: 'x.txt', body: { data: b64url('drop-by-filename') } },
      {
        mimeType: 'text/plain',
        headers: [{ name: 'Content-Disposition', value: 'attachment; filename="y.txt"' }],
        body: { data: b64url('drop-by-disposition') },
      },
    ],
  }
  assert.equal(collectTextParts(payload).text, 'keep')
})

test('an externalized body is queued for fetching, not treated as an attachment', () => {
  const payload: GmailPart = {
    mimeType: 'multipart/alternative',
    parts: [
      {
        mimeType: 'text/html',
        headers: [{ name: 'Content-Type', value: 'text/html; charset="utf-8"' }],
        body: { attachmentId: 'big-html-1', size: 400000 },
      },
    ],
  }
  const collected = collectTextParts(payload)

  assert.equal(collected.html, '', 'nothing inline yet')
  assert.deepEqual(collected.external, [
    { attachmentId: 'big-html-1', kind: 'html', charset: 'utf-8' },
  ])
})

test('hydrating an externalized body merges it into the right surface', async () => {
  const collected = {
    text: 'inline plain',
    html: '',
    external: [{ attachmentId: 'big-html-1', kind: 'html' as const, charset: 'utf-8' }],
  }
  const hydrated = await hydrateExternalParts(collected, async (id) => {
    assert.equal(id, 'big-html-1')
    return b64url('<p>Use code LARGE40</p>')
  })

  assert.deepEqual(hydrated, { text: 'inline plain', html: '<p>Use code LARGE40</p>' })
})

test('a real attachment still wins over an externalized body', () => {
  const payload: GmailPart = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/plain', body: { data: b64url('keep') } },
      {
        mimeType: 'text/plain',
        filename: 'invoice.txt',
        body: { attachmentId: 'real-attachment' },
      },
    ],
  }
  const collected = collectTextParts(payload)
  assert.equal(collected.text, 'keep')
  assert.deepEqual(collected.external, [], 'named files are not externalized bodies')
})

test('parses the registrable sender domain out of RFC 5322 forms', () => {
  assert.equal(senderDomainOf('Offers <offers@Mail.Example.COM>'), 'mail.example.com')
  assert.equal(senderDomainOf('plain@example.in'), 'example.in')
  assert.equal(senderDomainOf('"Odd, Name" <a.b+tag@deals.example.co.uk>'), 'deals.example.co.uk')
})
