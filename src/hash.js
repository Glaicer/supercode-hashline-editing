const UINT32_MASK = 0xffffffff
const UINT64_MASK = 0xffffffffffffffffn

const XX32_P1 = 0x9e3779b1
const XX32_P2 = 0x85ebca77
const XX32_P3 = 0xc2b2ae3d
const XX32_P4 = 0x27d4eb2f
const XX32_P5 = 0x165667b1

const XX64_P1 = 0x9e3779b185ebca87n
const XX64_P2 = 0xc2b2ae3d27d4eb4fn
const XX64_P3 = 0x165667b19e3779f9n
const XX64_P4 = 0x85ebca77c2b2ae63n
const XX64_P5 = 0x27d4eb2f165667c5n

const textEncoder = new TextEncoder()

function bytesOf(text) {
  return textEncoder.encode(text)
}

function readUint32(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0
}

function readUint64(bytes, offset) {
  let value = 0n
  for (let index = 0; index < 8; index += 1) {
    value |= BigInt(bytes[offset + index]) << BigInt(index * 8)
  }
  return value
}

function rotateLeft32(value, bits) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0
}

function xxHash32Round(accumulator, input) {
  let value = (accumulator + Math.imul(input, XX32_P2)) >>> 0
  value = rotateLeft32(value, 13)
  return Math.imul(value, XX32_P1) >>> 0
}

function xxHash32MergeRound(accumulator, value) {
  let result = (accumulator ^ xxHash32Round(0, value)) >>> 0
  result = (Math.imul(result, XX32_P1) + XX32_P4) >>> 0
  return result
}

/** Return the unsigned xxHash32 value for a UTF-8 string. */
export function xxHash32(text, seed = 0) {
  const bytes = bytesOf(text)
  let offset = 0
  let hash

  if (bytes.length >= 16) {
    let v1 = (seed + XX32_P1 + XX32_P2) >>> 0
    let v2 = (seed + XX32_P2) >>> 0
    let v3 = seed >>> 0
    let v4 = (seed - XX32_P1) >>> 0

    const limit = bytes.length - 16
    while (offset <= limit) {
      v1 = xxHash32Round(v1, readUint32(bytes, offset))
      offset += 4
      v2 = xxHash32Round(v2, readUint32(bytes, offset))
      offset += 4
      v3 = xxHash32Round(v3, readUint32(bytes, offset))
      offset += 4
      v4 = xxHash32Round(v4, readUint32(bytes, offset))
      offset += 4
    }

    hash =
      (rotateLeft32(v1, 1) + rotateLeft32(v2, 7) + rotateLeft32(v3, 12) + rotateLeft32(v4, 18)) >>> 0
    hash = xxHash32MergeRound(hash, v1)
    hash = xxHash32MergeRound(hash, v2)
    hash = xxHash32MergeRound(hash, v3)
    hash = xxHash32MergeRound(hash, v4)
  } else {
    hash = (seed + XX32_P5) >>> 0
  }

  hash = (hash + bytes.length) >>> 0

  while (offset + 4 <= bytes.length) {
    hash = (hash + Math.imul(readUint32(bytes, offset), XX32_P3)) >>> 0
    hash = Math.imul(rotateLeft32(hash, 17), XX32_P4) >>> 0
    offset += 4
  }

  while (offset < bytes.length) {
    hash = (hash + Math.imul(bytes[offset], XX32_P5)) >>> 0
    hash = Math.imul(rotateLeft32(hash, 11), XX32_P1) >>> 0
    offset += 1
  }

  hash ^= hash >>> 15
  hash = Math.imul(hash, XX32_P2) >>> 0
  hash ^= hash >>> 13
  hash = Math.imul(hash, XX32_P3) >>> 0
  hash ^= hash >>> 16
  return hash >>> 0
}

function rotateLeft64(value, bits) {
  return ((value << BigInt(bits)) | (value >> BigInt(64 - bits))) & UINT64_MASK
}

function xxHash64Round(accumulator, input) {
  let value = (accumulator + input * XX64_P2) & UINT64_MASK
  value = rotateLeft64(value, 31)
  return (value * XX64_P1) & UINT64_MASK
}

function xxHash64MergeRound(accumulator, value) {
  let result = (accumulator ^ xxHash64Round(0n, value)) & UINT64_MASK
  result = (result * XX64_P1 + XX64_P4) & UINT64_MASK
  return result
}

/** Return the uppercase hexadecimal xxHash64 value for a UTF-8 string. */
export function xxHash64(text, seed = 0n) {
  const bytes = bytesOf(text)
  let offset = 0
  let hash

  if (bytes.length >= 32) {
    let v1 = (seed + XX64_P1 + XX64_P2) & UINT64_MASK
    let v2 = (seed + XX64_P2) & UINT64_MASK
    let v3 = seed & UINT64_MASK
    let v4 = (seed - XX64_P1) & UINT64_MASK

    const limit = bytes.length - 32
    while (offset <= limit) {
      v1 = xxHash64Round(v1, readUint64(bytes, offset))
      offset += 8
      v2 = xxHash64Round(v2, readUint64(bytes, offset))
      offset += 8
      v3 = xxHash64Round(v3, readUint64(bytes, offset))
      offset += 8
      v4 = xxHash64Round(v4, readUint64(bytes, offset))
      offset += 8
    }

    hash =
      (rotateLeft64(v1, 1) + rotateLeft64(v2, 7) + rotateLeft64(v3, 12) + rotateLeft64(v4, 18)) & UINT64_MASK
    hash = xxHash64MergeRound(hash, v1)
    hash = xxHash64MergeRound(hash, v2)
    hash = xxHash64MergeRound(hash, v3)
    hash = xxHash64MergeRound(hash, v4)
  } else {
    hash = (seed + XX64_P5) & UINT64_MASK
  }

  hash = (hash + BigInt(bytes.length)) & UINT64_MASK

  while (offset + 8 <= bytes.length) {
    hash ^= xxHash64Round(0n, readUint64(bytes, offset))
    hash = (rotateLeft64(hash, 27) * XX64_P1 + XX64_P4) & UINT64_MASK
    offset += 8
  }

  if (offset + 4 <= bytes.length) {
    hash ^= (BigInt(readUint32(bytes, offset)) * XX64_P1) & UINT64_MASK
    hash = (rotateLeft64(hash, 23) * XX64_P2 + XX64_P3) & UINT64_MASK
    offset += 4
  }

  while (offset < bytes.length) {
    hash ^= (BigInt(bytes[offset]) * XX64_P5) & UINT64_MASK
    hash = (rotateLeft64(hash, 11) * XX64_P1) & UINT64_MASK
    offset += 1
  }

  hash ^= hash >> 33n
  hash = (hash * XX64_P2) & UINT64_MASK
  hash ^= hash >> 29n
  hash = (hash * XX64_P3) & UINT64_MASK
  hash ^= hash >> 32n
  return hash.toString(16).padStart(16, "0").toUpperCase()
}

export function stripBom(text) {
  return text.startsWith("\uFEFF") ? text.slice(1) : text
}

export function hasBom(text) {
  return text.startsWith("\uFEFF")
}

export function normalizeToLF(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

export function detectLineEnding(text) {
  return /\r\n/.test(text) ? "crlf" : "lf"
}

export function restoreLineEndings(text, lineEnding, bom = false) {
  const restored = lineEnding === "crlf" ? text.replace(/\n/g, "\r\n") : text
  return bom ? `\uFEFF${restored}` : restored
}

export function normalizeFileHashText(text) {
  return text.replace(/[ \t\r]+(?=\n|$)/g, "")
}

export function computeTag(text) {
  const normalized = normalizeToLF(stripBom(text))
  return (xxHash32(normalizeFileHashText(normalized)) & 0xffff).toString(16).padStart(4, "0").toUpperCase()
}

export function computeDigest(text) {
  return xxHash64(normalizeToLF(stripBom(text)))
}

export function splitAddressableLines(text) {
  if (text === "") return []
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

export function formatNumberedLines(lines, startLine = 1) {
  return lines.map((line, index) => `${startLine + index}:${line}`).join("\n")
}

export function utf8ByteLength(text) {
  return bytesOf(text).byteLength
}

