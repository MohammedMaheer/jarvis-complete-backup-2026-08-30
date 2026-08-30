'use strict'

/**
 * Windows PowerShell may emit UTF-8, UTF-16LE, a BOM, or a host warning before
 * a script's final JSON line. Decode those known transport shapes while still
 * requiring a real JSON object/array as the response envelope.
 */
function parsePowerShellJson(chunks) {
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  const sample = bytes.subarray(0, Math.min(bytes.length, 80))
  const likelyUtf16 = (bytes[0] === 0xff && bytes[1] === 0xfe)
    || (bytes.length > 8 && [...sample].filter((value) => value === 0).length > 12)
  const decoded = bytes.toString(likelyUtf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '').trim()
  const candidates = [
    decoded,
    ...decoded.split(/\r?\n/).reverse().map((line) => line.trim()).filter((line) => line.startsWith('{') || line.startsWith('[')),
  ]
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') return parsed
    } catch { /* Try the final JSON line after a PowerShell host warning. */ }
  }
  throw new Error('The desktop action returned an invalid local response.')
}

module.exports = { parsePowerShellJson }
