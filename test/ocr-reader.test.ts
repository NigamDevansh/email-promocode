import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { closeOcrEngine, readImages } from '../src/background/ocr.ts'
import type { GmailPort } from '../src/types/gmail.ts'
import type { ImageCandidate, OcrRecognizeRequest } from '../src/types/ocr.ts'

/*
 * The reader is the half of OCR that talks to the network, to Gmail and to the
 * offscreen document, so the boundaries section 7 says to mock are exactly
 * those three. Everything below the messaging layer is covered in ocr.test.ts.
 */

interface FakeChrome {
  contexts: { length: number }[]
  created: number
  closed: number
  sent: OcrRecognizeRequest[]
  /** What the offscreen document replies, or 'hang' to answer nothing at all. */
  reply: 'hang' | ((request: OcrRecognizeRequest) => unknown)
}

function install(reply: FakeChrome['reply'] = () => ({ ok: true, result: read('RAKE25') })): {
  chrome: FakeChrome
  fetches: FetchCall[]
  setResponse: (response: Response | null) => void
  restore: () => void
} {
  const state: FakeChrome = { contexts: [], created: 0, closed: 0, sent: [], reply }
  let response: Response | null = null

  const fake = {
    runtime: {
      getURL: (path: string) => `chrome-extension://test-id/${path}`,
      getContexts: async () => state.contexts,
      sendMessage: (request: OcrRecognizeRequest) => {
        state.sent.push(request)
        if (state.reply === 'hang') return new Promise(() => undefined)
        return Promise.resolve(state.reply(request))
      },
    },
    offscreen: {
      createDocument: async () => {
        state.created += 1
        state.contexts = [{ length: 1 }]
      },
      closeDocument: async () => {
        state.closed += 1
        state.contexts = []
      },
    },
  }

  const globals = globalThis as unknown as { chrome: unknown; fetch: unknown }
  const realChrome = globals.chrome
  const realFetch = globals.fetch
  globals.chrome = fake

  const fetches: FetchCall[] = []
  globals.fetch = async (url: string, init?: RequestInit) => {
    fetches.push({ url: String(url), init })
    if (!response) throw new Error('no response configured')
    // A body can only be read once, and one test reads nine images.
    return response.clone()
  }

  return {
    chrome: state,
    fetches,
    setResponse: (next: Response | null) => {
      response = next
    },
    restore: () => {
      globals.chrome = realChrome
      globals.fetch = realFetch
    },
  }
}

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

const imageResponse = (bytes: number, type = 'image/png'): Response =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': type } })

/** A confident single-word read, which section 11's floors let through. */
const read = (word: string): { text: string; words: { text: string; confidence: number }[]; meanConfidence: number } => ({
  text: word,
  words: [{ text: word, confidence: 95 }],
  meanConfidence: 95,
})

const inline = (attachmentId: string, mimeType: string = 'image/jpeg'): ImageCandidate => ({
  source: 'inline',
  attachmentId,
  data: null,
  url: null,
  width: null,
  height: null,
  pixelArea: null,
  byteSize: 90_000,
  mimeType,
})

const remote = (url: string): ImageCandidate => ({
  source: 'remote',
  attachmentId: null,
  data: null,
  url,
  width: 600,
  height: 400,
  pixelArea: 240_000,
  byteSize: null,
  mimeType: null,
})

/** Big enough to clear the "too small to hold legible text" floor. */
const BIG_BASE64 = 'QUJDRA'.repeat(2_000)

function gmailWith(data: string): GmailPort & { attachmentCalls: string[] } {
  const calls: string[] = []
  return {
    attachmentCalls: calls,
    async getAttachmentData(_messageId, attachmentId) {
      calls.push(attachmentId)
      return data
    },
    getProfileHistoryId: async () => '1',
    listHistory: async () => ({ messageIds: [], nextPageToken: null, historyId: '1' }),
    listPage: async () => ({ ids: [], nextPageToken: null }),
    getFull: async () => {
      throw new Error('not used')
    },
  }
}

test('an inline part is read through Gmail and never off the network', async () => {
  const harness = install()
  try {
    const gmail = gmailWith(BIG_BASE64)
    const run = await readImages([inline('att-1')], 'm1', gmail)

    assert.deepEqual(gmail.attachmentCalls, ['att-1'])
    assert.equal(run.imagesRead, 1)
    assert.equal(run.text, 'RAKE25')
  } finally {
    harness.restore()
  }
})

test('an inline part is handed over as its own type, not as a hopeful PNG', async () => {
  const harness = install()
  try {
    await readImages([inline('att-1', 'image/gif')], 'm1', gmailWith(BIG_BASE64))

    assert.match(harness.chrome.sent[0]?.dataUrl ?? '', /^data:image\/gif;base64,/)
  } finally {
    harness.restore()
  }
})

test('a direct Gmail body part does not need a second Gmail request', async () => {
  const harness = install()
  try {
    const direct: ImageCandidate = {
      ...inline('unused'),
      attachmentId: null,
      data: BIG_BASE64,
    }
    const gmail = gmailWith('')
    const run = await readImages([direct], 'm1', gmail)

    assert.deepEqual(gmail.attachmentCalls, [])
    assert.equal(run.imagesRead, 1)
  } finally {
    harness.restore()
  }
})

test('an image declared too large never starts the engine', async () => {
  const harness = install()
  try {
    const tooLarge = { ...inline('att-1'), byteSize: 9_000_000 }
    const run = await readImages([tooLarge], 'm1', gmailWith(BIG_BASE64))

    assert.deepEqual(harness.chrome.sent, [])
    assert.equal(run.imagesRead, 0)
  } finally {
    harness.restore()
  }
})

test('an image too small in bytes never starts the engine', async () => {
  const harness = install()
  try {
    const run = await readImages([inline('att-1')], 'm1', gmailWith('small'))

    assert.equal(harness.chrome.created, 0, 'not even the offscreen document is worth it')
    assert.equal(run.imagesRead, 0)
  } finally {
    harness.restore()
  }
})

test('the engine is started once and reused across images', async () => {
  const harness = install()
  try {
    await readImages([inline('att-1'), inline('att-2')], 'm1', gmailWith(BIG_BASE64))

    assert.equal(harness.chrome.created, 1, 'starting it costs seconds; keep it warm')
    assert.equal(harness.chrome.sent.length, 2)
  } finally {
    harness.restore()
  }
})

test('a failed read leaves the message to the text stages instead of throwing', async () => {
  const harness = install(() => ({ ok: false, error: 'engine crashed' }))
  try {
    const run = await readImages([inline('att-1')], 'm1', gmailWith(BIG_BASE64))

    assert.deepEqual(run, {
      imagesConsidered: 1,
      imagesRead: 0,
      imagesAccepted: 0,
      meanConfidence: 0,
      text: '',
    })
  } finally {
    harness.restore()
  }
})

test('a hung engine times out rather than stalling the whole slice', { timeout: 5000 }, async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const harness = install('hang')
  try {
    const pending = readImages([inline('att-1')], 'm1', gmailWith(BIG_BASE64))

    // Let the fetch and messaging microtasks settle before the clock moves.
    await new Promise((resolve) => setImmediate(resolve))
    t.mock.timers.tick(30_000)

    const run = await pending
    assert.equal(harness.chrome.sent.length, 1, 'the request was made')
    assert.equal(run.imagesRead, 0, 'and abandoned rather than awaited forever')
  } finally {
    harness.restore()
  }
})

test('one message cannot spend the budget the next message needs', { timeout: 5000 }, async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const harness = install('hang')
  try {
    const pending = readImages(
      [inline('att-1'), inline('att-2'), inline('att-3'), inline('att-4')],
      'm1',
      gmailWith(BIG_BASE64),
    )

    // Three images each burn the recognize timeout; the fourth is past the
    // 90-second message budget, which is now the only thing that stops OCR.
    for (let image = 0; image < 4; image += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      t.mock.timers.tick(30_000)
    }

    await pending
    assert.equal(harness.chrome.sent.length, 3, 'the fourth was never started')
  } finally {
    harness.restore()
  }
})

test('the diagnostics count what was considered, read and believed', async () => {
  const unreadable = { text: 'M0N', words: [{ text: 'M0N', confidence: 40 }], meanConfidence: 40 }
  let call = 0
  const harness = install(() => ({
    ok: true,
    result: (call += 1) === 1 ? read('RAKE25') : unreadable,
  }))
  try {
    const run = await readImages([inline('att-1'), inline('att-2')], 'm1', gmailWith(BIG_BASE64))

    assert.deepEqual(
      [run.imagesConsidered, run.imagesRead, run.imagesAccepted],
      [2, 2, 1],
      'a read that happened but was not trusted is still a read',
    )
    assert.equal(run.meanConfidence, 67.5, 'averaged over the reads, not over the images')
  } finally {
    harness.restore()
  }
})

test('closing the engine tears down the offscreen document', async () => {
  const harness = install()
  try {
    await readImages([inline('att-1')], 'm1', gmailWith(BIG_BASE64))
    await closeOcrEngine()

    assert.equal(harness.chrome.closed, 1, 'section 7: it does not outlive the queue')
  } finally {
    harness.restore()
  }
})

test('closing an engine that never started is not an error', async () => {
  const harness = install()
  try {
    await closeOcrEngine()
    assert.equal(harness.chrome.closed, 0)
  } finally {
    harness.restore()
  }
})

// ------------------------------------------- reading the sender's own banners

test('a remote banner is fetched without cookies and without a referrer', async () => {
  const harness = install()
  try {
    harness.setResponse(imageResponse(50_000))
    const run = await readImages([remote('https://cdn.x/hero.png')], 'm1', gmailWith(''))

    assert.equal(harness.fetches.length, 1)
    assert.equal(harness.fetches[0]?.url, 'https://cdn.x/hero.png')
    assert.equal(harness.fetches[0]?.init?.credentials, 'omit')
    assert.equal(harness.fetches[0]?.init?.referrerPolicy, 'no-referrer')
    assert.equal(run.imagesRead, 1)
  } finally {
    harness.restore()
  }
})

test('an inline part is never fetched off the network', async () => {
  const harness = install()
  try {
    await readImages([inline('att-1')], 'm1', gmailWith(BIG_BASE64))

    assert.deepEqual(harness.fetches, [], 'Gmail already served it; the sender learns nothing')
  } finally {
    harness.restore()
  }
})

test('a response that is not an image is dropped before it reaches the engine', async () => {
  const harness = install()
  try {
    harness.setResponse(
      new Response('<html>not found</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    )
    const run = await readImages([remote('https://cdn.x/gone.png')], 'm1', gmailWith(''))

    assert.deepEqual(harness.chrome.sent, [])
    assert.equal(run.imagesRead, 0)
  } finally {
    harness.restore()
  }
})

test('a remote image too small in bytes never starts the engine', async () => {
  const harness = install()
  try {
    harness.setResponse(imageResponse(900))
    const run = await readImages([remote('https://cdn.x/dot.png')], 'm1', gmailWith(''))

    assert.equal(harness.chrome.created, 0, 'not even the offscreen document is worth it')
    assert.equal(run.imagesRead, 0)
  } finally {
    harness.restore()
  }
})

test('an oversized remote Content-Length is rejected before the body reaches OCR', async () => {
  const harness = install()
  try {
    harness.setResponse(
      new Response(new Uint8Array(1), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '9000000' },
      }),
    )
    const run = await readImages([remote('https://cdn.x/oversized.png')], 'm1', gmailWith(''))

    assert.equal(harness.chrome.created, 0)
    assert.equal(run.imagesRead, 0)
  } finally {
    harness.restore()
  }
})

test('every image is attempted, not just the first one that answers', async () => {
  // The whole point of scanning everything: the code may be in image nine.
  const harness = install((request) => ({
    ok: true,
    result: request.dataUrl.length > 0 ? read('RAKE25') : read('NOPE'),
  }))
  try {
    harness.setResponse(imageResponse(50_000))
    const banners = Array.from({ length: 9 }, (_, index) =>
      remote(`https://cdn.x/${index}.png`))

    const run = await readImages(banners, 'm1', gmailWith(''))

    assert.equal(harness.fetches.length, 9, 'no silent cut-off partway down the list')
    assert.equal(run.imagesConsidered, 9)
    assert.equal(run.imagesRead, 9)
  } finally {
    harness.restore()
  }
})

test('a banner that fails to load does not stop the ones after it', async () => {
  const harness = install()
  try {
    // No response configured, so every fetch rejects.
    const run = await readImages(
      [remote('https://cdn.x/1.png'), inline('att-1'), remote('https://cdn.x/2.png')],
      'm1',
      gmailWith(BIG_BASE64),
    )

    assert.equal(run.imagesConsidered, 3)
    assert.equal(run.imagesRead, 1, 'the inline part in the middle still got read')
  } finally {
    harness.restore()
  }
})
