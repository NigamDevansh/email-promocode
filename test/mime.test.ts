import assert from 'node:assert/strict'
import test from 'node:test'
import type { GmailPart } from '../src/types/gmail.ts'
import { collectTextParts, decodeBase64Url, senderDomainOf } from '../src/utils/mime.ts'

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
  assert.deepEqual(collectTextParts(payload), { text: 'plain body', html: '<p>html body</p>' })
})

test('skips attachments identified by attachmentId, filename or disposition', () => {
  const payload: GmailPart = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/plain', body: { data: b64url('keep') } },
      { mimeType: 'text/plain', body: { attachmentId: 'a1', data: b64url('drop-by-id') } },
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

test('parses the registrable sender domain out of RFC 5322 forms', () => {
  assert.equal(senderDomainOf('Offers <offers@Mail.Example.COM>'), 'mail.example.com')
  assert.equal(senderDomainOf('plain@example.in'), 'example.in')
  assert.equal(senderDomainOf('"Odd, Name" <a.b+tag@deals.example.co.uk>'), 'deals.example.co.uk')
})
