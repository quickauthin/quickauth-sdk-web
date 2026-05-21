/**
 * Tiny localStorage wrapper that no-ops when storage is unavailable
 * (Safari private mode, SSR, locked-down embeds).
 */

let prefix = 'qa_'

const memory = new Map<string, string>()

function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const probe = '__qa_probe__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return window.localStorage
  } catch {
    return null
  }
}

export const storage = {
  setPrefix(p: string): void {
    prefix = p
  },
  get<T = unknown>(key: string): T | null {
    const k = prefix + key
    const s = safeStorage()
    const raw = s ? s.getItem(k) : memory.get(k) ?? null
    if (raw == null) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  },
  set(key: string, value: unknown): void {
    const k = prefix + key
    const raw = JSON.stringify(value)
    const s = safeStorage()
    if (s) s.setItem(k, raw)
    else memory.set(k, raw)
  },
  remove(key: string): void {
    const k = prefix + key
    const s = safeStorage()
    if (s) s.removeItem(k)
    else memory.delete(k)
  },
  /** Remove every prefixed key. Used when consent is revoked. */
  purge(): void {
    const s = safeStorage()
    if (s) {
      const toRemove: string[] = []
      for (let i = 0; i < s.length; i++) {
        const key = s.key(i)
        if (key && key.startsWith(prefix)) toRemove.push(key)
      }
      toRemove.forEach((k) => s.removeItem(k))
    } else {
      for (const k of Array.from(memory.keys())) {
        if (k.startsWith(prefix)) memory.delete(k)
      }
    }
  },
}
