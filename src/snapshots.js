import { computeDigest, computeTag, normalizeToLF, stripBom, utf8ByteLength } from "./hash.js"

const DEFAULT_MAX_PATHS = 256
const DEFAULT_MAX_VERSIONS_PER_PATH = 4
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024

function pathKey(canonicalPath, rootId) {
  return `${rootId}\u0000${canonicalPath}`
}

function normalizeSeenLines(lines) {
  if (lines instanceof Set) return new Set(lines)
  return new Set(lines ?? [])
}

function positiveLimit(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`)
  return value
}

function normalizeRecordInput(input, rootId, text, options) {
  if (typeof input === "object" && input !== null) return input
  return { canonicalPath: input, rootId, text, ...(options ?? {}) }
}

/** Build an immutable-in-shape Snapshot value from normalized file metadata. */
export function makeSnapshot(input) {
  const normalizedText = normalizeToLF(stripBom(String(input.text ?? "")))
  const snapshot = {
    canonicalPath: String(input.canonicalPath),
    rootId: String(input.rootId),
    text: normalizedText,
    tag: computeTag(normalizedText),
    digest: computeDigest(normalizedText),
    seenLines: normalizeSeenLines(input.seenLines),
    lineEnding: input.lineEnding ?? "lf",
    bom: Boolean(input.bom),
  }
  return snapshot
}

/**
 * Per-process bounded Snapshot storage.
 *
 * The map order is the path-level LRU order. Snapshot lookup never chooses a
 * most-recent colliding version; callers must prove a unique exact match.
 */
export class InMemorySnapshotStore {
  constructor(options = {}) {
    this.maxPaths = positiveLimit(options.maxPaths ?? DEFAULT_MAX_PATHS, "maxPaths")
    this.maxVersionsPerPath = positiveLimit(
      options.maxVersionsPerPath ?? DEFAULT_MAX_VERSIONS_PER_PATH,
      "maxVersionsPerPath",
    )
    this.maxTotalBytes = positiveLimit(options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES, "maxTotalBytes")
    this.paths = new Map()
    this.totalBytes = 0
  }

  get pathCount() {
    return this.paths.size
  }

  get versionCount() {
    let count = 0
    for (const entry of this.paths.values()) count += entry.versions.length
    return count
  }

  _touch(key, entry) {
    this.paths.delete(key)
    this.paths.set(key, entry)
  }

  _removePath(key) {
    const entry = this.paths.get(key)
    if (!entry) return
    for (const snapshot of entry.versions) this.totalBytes -= utf8ByteLength(snapshot.text)
    this.paths.delete(key)
  }

  _evictOldestPath() {
    const oldest = this.paths.keys().next().value
    if (oldest !== undefined) this._removePath(oldest)
  }

  _removeOldestVersion(entry) {
    const snapshot = entry.versions.pop()
    if (snapshot) this.totalBytes -= utf8ByteLength(snapshot.text)
  }

  _prepareRecord(input, rootId, text, options) {
    const snapshot = makeSnapshot(normalizeRecordInput(input, rootId, text, options))
    const size = utf8ByteLength(snapshot.text)
    if (size > this.maxTotalBytes) {
      throw new Error(
        `Snapshot for ${snapshot.canonicalPath} exceeds the ${this.maxTotalBytes}-byte SnapshotStore limit`,
      )
    }
    return { snapshot, size }
  }

  /** Validate that a Snapshot can be retained without changing the store. */
  assertCanRecord(input, rootId, text, options) {
    return this._prepareRecord(input, rootId, text, options).snapshot
  }

  /** Record a Snapshot, merging identical normalized bytes. */
  record(input, rootId, text, options) {
    const { snapshot, size } = this._prepareRecord(input, rootId, text, options)
    const key = pathKey(snapshot.canonicalPath, snapshot.rootId)
    const entry = this.paths.get(key)

    if (entry) {
      const existing = entry.versions.find(
        (candidate) => candidate.digest === snapshot.digest && candidate.text === snapshot.text,
      )
      if (existing) {
        for (const line of snapshot.seenLines) existing.seenLines.add(line)
        existing.lineEnding = snapshot.lineEnding
        existing.bom = snapshot.bom
        this._touch(key, entry)
        return existing
      }
    }

    while (this.totalBytes + size > this.maxTotalBytes && this.paths.size > 0) {
      this._evictOldestPath()
    }

    let current = this.paths.get(key)
    if (!current) {
      while (this.paths.size >= this.maxPaths) this._evictOldestPath()
      current = { canonicalPath: snapshot.canonicalPath, rootId: snapshot.rootId, versions: [] }
      this.paths.set(key, current)
    }

    while (current.versions.length >= this.maxVersionsPerPath) this._removeOldestVersion(current)
    current.versions.unshift(snapshot)
    this.totalBytes += size
    this._touch(key, current)
    return snapshot
  }

  /** Return all retained versions for one canonical path and root. */
  find(canonicalPath, rootId) {
    const key = pathKey(canonicalPath, rootId)
    const entry = this.paths.get(key)
    if (!entry) return []
    this._touch(key, entry)
    return entry.versions.filter(() => true)
  }

  candidates(canonicalPath, rootId, tag) {
    return this.find(canonicalPath, rootId).filter((snapshot) => snapshot.tag === String(tag).toUpperCase())
  }

  /** Return exact byte matches without selecting among colliding tags. */
  exactMatches(canonicalPath, rootId, tag, liveText) {
    const normalizedLive = normalizeToLF(stripBom(String(liveText)))
    const candidates = this.candidates(canonicalPath, rootId, tag)
    const digest = computeDigest(normalizedLive)
    const exact = candidates.filter((snapshot) => snapshot.digest === digest && snapshot.text === normalizedLive)
    return { candidates, exact, liveText: normalizedLive, digest }
  }

  resolve(canonicalPath, rootId, tag, liveText) {
    const { candidates, exact } = this.exactMatches(canonicalPath, rootId, tag, liveText)
    if (candidates.length !== 1 || exact.length !== 1) return null
    return exact[0]
  }

  invalidate(canonicalPath, rootId) {
    for (const [key, entry] of this.paths) {
      if (entry.canonicalPath !== canonicalPath) continue
      if (rootId !== undefined && entry.rootId !== rootId) continue
      this._removePath(key)
    }
  }

  clear() {
    this.paths.clear()
    this.totalBytes = 0
  }
}

export const SnapshotStoreLimits = Object.freeze({
  maxPaths: DEFAULT_MAX_PATHS,
  maxVersionsPerPath: DEFAULT_MAX_VERSIONS_PER_PATH,
  maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
})
