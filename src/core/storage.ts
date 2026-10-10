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
    let raw: string | null = null
    try {
      raw = safeStorage()?.getItem(k) ?? null
    } catch {
      raw = null
    }
    if (raw == null) raw = memory.get(k) ?? null
    if (raw == null) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  },
  set(key: string, value: unknown): void {
    const k = prefix + key
    let raw: string
    try {
      raw = JSON.stringify(value)
    } catch {
      return
    }
    const s = safeStorage()
    try {
      if (s) {
        s.setItem(k, raw)
        memory.delete(k)
        return
      }
    } catch {
      // ignore
    }
    memory.set(k, raw)
  },
  remove(key: string): void {
    const k = prefix + key
    memory.delete(k)
    try {
      safeStorage()?.removeItem(k)
    } catch {
      // ignore
    }
  },
  /** Remove every prefixed key. */
  purge(): void {
    for (const k of Array.from(memory.keys())) {
      if (k.startsWith(prefix)) memory.delete(k)
    }
    try {
      const st = safeStorage()
      if (!st) return
      const toRemove: string[] = []
      for (let i = 0; i < st.length; i++) {
        const key = st.key(i)
        if (key && key.startsWith(prefix)) toRemove.push(key)
      }
      toRemove.forEach((key) => st.removeItem(key))
    } catch {
      // ignore
    }
  },
}
