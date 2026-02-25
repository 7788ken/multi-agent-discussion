import fs from 'fs'
import os from 'os'
import path from 'path'

const REGISTRY_DIR = path.join(os.homedir(), '.multi-agent')
const REGISTRY_FILE = 'discussion-roots.json'
const DISCUSSION_ROOTS_FILE_PATH = path.join(REGISTRY_DIR, REGISTRY_FILE)

function toPathKey(normalizedPath) {
  if (process.platform === 'win32') {
    return normalizedPath.toLowerCase()
  }
  return normalizedPath
}

function normalizeRootPath(rootPath) {
  if (typeof rootPath !== 'string') {
    return null
  }

  const trimmed = rootPath.trim()
  if (!trimmed) {
    return null
  }

  const resolved = path.normalize(path.resolve(trimmed))
  try {
    return path.normalize(fs.realpathSync(resolved))
  } catch {
    return resolved
  }
}

function dedupeRoots(candidates) {
  const roots = []
  const seen = new Set()

  for (const candidate of candidates) {
    const normalized = normalizeRootPath(candidate)
    if (!normalized) {
      continue
    }

    const key = toPathKey(normalized)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    roots.push(normalized)
  }

  return roots
}

function readRoots() {
  let raw = ''
  try {
    raw = fs.readFileSync(DISCUSSION_ROOTS_FILE_PATH, 'utf8')
  } catch {
    return []
  }

  if (!raw.trim()) {
    return []
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }

  if (Array.isArray(parsed)) {
    return dedupeRoots(parsed)
  }

  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.roots)) {
    return dedupeRoots(parsed.roots)
  }

  return []
}

function writeRoots(roots) {
  const normalized = dedupeRoots(Array.isArray(roots) ? roots : [])
  const payload = `${JSON.stringify({ roots: normalized }, null, 2)}\n`
  const tmpPath = `${DISCUSSION_ROOTS_FILE_PATH}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`

  fs.mkdirSync(REGISTRY_DIR, { recursive: true })
  fs.writeFileSync(tmpPath, payload, 'utf8')
  try {
    fs.renameSync(tmpPath, DISCUSSION_ROOTS_FILE_PATH)
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath)
    } catch {}
    throw err
  }
}

function registerRoot(rootPath) {
  const normalized = normalizeRootPath(rootPath)
  if (!normalized) {
    return readRoots()
  }

  const existing = readRoots()
  const existingKeys = new Set(existing.map(toPathKey))
  if (existingKeys.has(toPathKey(normalized))) {
    return existing
  }

  const next = [...existing, normalized]
  try {
    writeRoots(next)
  } catch {
    return next
  }
  return next
}

function getRoots() {
  return readRoots()
}

export {
  DISCUSSION_ROOTS_FILE_PATH,
  normalizeRootPath,
  readRoots,
  registerRoot,
  getRoots
}
