import { computeDigest, computeTag, normalizeToLF, stripBom, utf8ByteLength } from "./hash.ts"

const DEFAULT_MAX_PATHS = 256
const DEFAULT_MAX_VERSIONS_PER_PATH = 4
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024

function pathKey(canonicalPath: string, rootId: string): string {
  return `${rootId}\u0000${canonicalPath}`
}

function normalizeSeenLines(lines: Iterable<number> | null | undefined): Set<number> {
  if (lines instanceof Set) return new Set(lines)
  return new Set(lines ?? [])
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`)
  return value
}

export interface SnapshotInput {
  canonicalPath: string
  rootId: string
  text: string
  seenLines?: Iterable<number>
  lineEnding?: string
  bom?: boolean
}

export interface SnapshotRecordOptions {
  seenLines?: Iterable<number>
  lineEnding?: string
  bom?: boolean
}

export interface Snapshot {
  canonicalPath: string
  rootId: string
  text: string
  tag: string
  digest: string
  seenLines: Set<number>
  lineEnding: string
  bom: boolean
}

interface PathEntry {
  canonicalPath: string
  rootId: string
  versions: Snapshot[]
}

export interface SnapshotStoreOptions {
  maxPaths?: number
  maxVersionsPerPath?: number
  maxTotalBytes?: number
}

function normalizeRecordInput(
  input: SnapshotInput | string,
  rootId?: string,
  text?: string,
  options?: SnapshotRecordOptions,
): SnapshotInput {
  if (typeof input === "object" && input !== null) return input
  return { canonicalPath: input, rootId: rootId as string, text: text as string, ...(options ?? {}) }
}

/** Build an immutable-in-shape Snapshot value from normalized file metadata. */
export function makeSnapshot(input: SnapshotInput): Snapshot {
  const normalizedText = normalizeToLF(stripBom(String(input.text ?? "")))
  const snapshot: Snapshot = {
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

export interface ExactMatches {
  candidates: Snapshot[]
  exact: Snapshot[]
  liveText: string
  digest: string
}

/**
 * Per-process bounded Snapshot storage.
 *
 * The map order is the path-level LRU order. Snapshot lookup never chooses a
 * most-recent colliding version; callers must prove a unique exact match.
 */
export class InMemorySnapshotStore {
  maxPaths: number
  maxVersionsPerPath: number
  maxTotalBytes: number
  paths: Map<string, PathEntry>
  totalBytes: number

  constructor(options: SnapshotStoreOptions = {}) {
    this.maxPaths = positiveLimit(options.maxPaths ?? DEFAULT_MAX_PATHS, "maxPaths")
    this.maxVersionsPerPath = positiveLimit(
      options.maxVersionsPerPath ?? DEFAULT_MAX_VERSIONS_PER_PATH,
      "maxVersionsPerPath",
    )
    this.maxTotalBytes = positiveLimit(options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES, "maxTotalBytes")
    this.paths = new Map()
    this.totalBytes = 0
  }

  get pathCount(): number {
    return this.paths.size
  }

  get versionCount(): number {
    let count = 0
    for (const entry of this.paths.values()) count += entry.versions.length
    return count
  }

  _touch(key: string, entry: PathEntry): void {
    this.paths.delete(key)
    this.paths.set(key, entry)
  }

  _removePath(key: string): void {
    const entry = this.paths.get(key)
    if (!entry) return
    for (const snapshot of entry.versions) this.totalBytes -= utf8ByteLength(snapshot.text)
    this.paths.delete(key)
  }

  _evictOldestPath(): void {
    const oldest = this.paths.keys().next().value
    if (oldest !== undefined) this._removePath(oldest)
  }

  _removeOldestVersion(entry: PathEntry): void {
    const snapshot = entry.versions.pop()
    if (snapshot) this.totalBytes -= utf8ByteLength(snapshot.text)
  }

  _prepareRecord(
    input: SnapshotInput | string,
    rootId?: string,
    text?: string,
    options?: SnapshotRecordOptions,
  ): { snapshot: Snapshot; size: number } {
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
  assertCanRecord(
    input: SnapshotInput | string,
    rootId?: string,
    text?: string,
    options?: SnapshotRecordOptions,
  ): Snapshot {
    return this._prepareRecord(input, rootId, text, options).snapshot
  }

  /** Record a Snapshot, merging identical normalized bytes. */
  record(
    input: SnapshotInput | string,
    rootId?: string,
    text?: string,
    options?: SnapshotRecordOptions,
  ): Snapshot {
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
  find(canonicalPath: string, rootId: string): Snapshot[] {
    const key = pathKey(canonicalPath, rootId)
    const entry = this.paths.get(key)
    if (!entry) return []
    this._touch(key, entry)
    return entry.versions.filter(() => true)
  }

  candidates(canonicalPath: string, rootId: string, tag: string): Snapshot[] {
    return this.find(canonicalPath, rootId).filter((snapshot) => snapshot.tag === String(tag).toUpperCase())
  }

  /** Return exact byte matches without selecting among colliding tags. */
  exactMatches(canonicalPath: string, rootId: string, tag: string, liveText: string): ExactMatches {
    const normalizedLive = normalizeToLF(stripBom(String(liveText)))
    const candidates = this.candidates(canonicalPath, rootId, tag)
    const digest = computeDigest(normalizedLive)
    const exact = candidates.filter((snapshot) => snapshot.digest === digest && snapshot.text === normalizedLive)
    return { candidates, exact, liveText: normalizedLive, digest }
  }

  resolve(canonicalPath: string, rootId: string, tag: string, liveText: string): Snapshot | null {
    const { candidates, exact } = this.exactMatches(canonicalPath, rootId, tag, liveText)
    if (candidates.length !== 1 || exact.length !== 1) return null
    return exact[0]
  }

  invalidate(canonicalPath: string, rootId?: string): void {
    for (const [key, entry] of this.paths) {
      if (entry.canonicalPath !== canonicalPath) continue
      if (rootId !== undefined && entry.rootId !== rootId) continue
      this._removePath(key)
    }
  }

  clear(): void {
    this.paths.clear()
    this.totalBytes = 0
  }
}

export const SnapshotStoreLimits = Object.freeze({
  maxPaths: DEFAULT_MAX_PATHS,
  maxVersionsPerPath: DEFAULT_MAX_VERSIONS_PER_PATH,
  maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
})
