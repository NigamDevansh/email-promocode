import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { GmailMessage } from '../src/types/gmail.ts'
import { gateMessage } from '../src/utils/candidates.ts'
import { parseGmailMessage } from '../src/utils/mime.ts'

interface Fixture {
  description: string
  message: GmailMessage
  expected: {
    senderDomain: string
    candidates: string[]
    hasTriggerPhrase: boolean
    shouldExtract: boolean
  }
}

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/emails')
const files = readdirSync(fixtureDir)
  .filter((name) => name.endsWith('.json'))
  .sort()

test('§7 asks for roughly ten fixtures; fail loudly if the directory empties', () => {
  assert.ok(files.length >= 10, `expected at least 10 fixtures, found ${files.length}`)
})

for (const file of files) {
  const fixture = JSON.parse(readFileSync(resolve(fixtureDir, file), 'utf8')) as Fixture

  test(`${file}: ${fixture.description}`, () => {
    const parsed = parseGmailMessage(fixture.message)
    assert.equal(parsed.senderDomain, fixture.expected.senderDomain, 'sender domain')

    const gate = gateMessage(parsed)
    assert.deepEqual(
      gate.candidates.map((candidate) => candidate.normalized),
      fixture.expected.candidates,
      'candidate codes, highest score first',
    )
    assert.equal(gate.hasTriggerPhrase, fixture.expected.hasTriggerPhrase, 'trigger phrase')
    assert.equal(gate.shouldExtract, fixture.expected.shouldExtract, 'gate decision')
  })
}
