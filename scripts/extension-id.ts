import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Chrome derives an extension ID from the first 128 bits of the SHA-256 digest
 * of the DER public key, with each hex digit mapped onto a-p.
 */
export function deriveExtensionId(base64PublicKey: string): string {
  const der = Buffer.from(base64PublicKey, 'base64')
  const digest = createHash('sha256').update(der).digest('hex').slice(0, 32)
  return Array.from(digest, (hexDigit) =>
    String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(hexDigit, 16)),
  ).join('')
}

export function readManifestKey(): string {
  const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), '../manifest.template.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { key?: string }
  if (!manifest.key) throw new Error('manifest.template.json has no "key" field')
  return manifest.key
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  console.log(deriveExtensionId(readManifestKey()))
}
