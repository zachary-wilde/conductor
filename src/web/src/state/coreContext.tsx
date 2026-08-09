// Core connection context: owns the typed loopback client and the opening
// handshake, and exposes whether the core is safe to mutate against. Every view
// that issues commands reads `compatible` first; when it is false the shell
// renders read-only and disables mutation so an incompatible core is never
// corrupted.
//
// It also owns the Connect dialog: the operator can re-open it any time to
// retarget the core / change the token, and a failed handshake (including a 401
// from a missing/wrong token) forces it open so the device can be re-paired.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react'
import type { ReactNode } from 'react'
import { isCompatible } from '@ops/web-client-core'
import type { CoreHandshake } from '@ops/api-contract'
import { CoreClient, LOCAL_BUILD, RateLimitError } from '../api/client'
import { resolveConnection } from './connection'

interface CoreContextValue {
  client: CoreClient
  apiBase: string
  apiToken: string
  handshake: CoreHandshake | null
  /** True when the core's api + store-schema match this client build. */
  compatible: boolean
  booting: boolean
  bootError: string | null
  /** Re-run the handshake (e.g. after the operator dismisses an error). */
  refresh: () => void
  /** Whether the Connect dialog is currently shown. */
  connectOpen: boolean
  /** Open the Connect dialog (retarget / re-pair). */
  openConnect: () => void
  /** Close the Connect dialog (no-op while a boot error keeps it pinned). */
  closeConnect: () => void
}

const CoreContext = createContext<CoreContextValue | null>(null)

CoreContext.displayName = 'CoreContext'

export function CoreProvider({ children }: { children: ReactNode }): JSX.Element {
  // Resolved once at mount: the base + token come from localStorage → ?api=/?token=
  // → same-origin (see connection.ts). They never change without a reload.
  const { apiBase, apiToken } = useMemo(() => resolveConnection(), [])
  const client = useMemo(() => new CoreClient(apiBase, apiToken), [apiBase, apiToken])

  const [handshake, setHandshake] = useState<CoreHandshake | null>(null)
  const [booting, setBooting] = useState(true)
  const [bootError, setBootError] = useState<string | null>(null)
  const [connectOpen, setConnectOpen] = useState(false)

  const refresh = useCallback(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const attempt = (): void => {
      setBooting(true)
      setBootError(null)
      client
        .handshake()
        .then((hs) => {
          if (cancelled) return
          setHandshake(hs)
          setBooting(false)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          if (err instanceof RateLimitError) {
            // The core is rate-limiting boot — back off and retry rather than
            // pinning the Connect screen on a transient 429.
            retryTimer = setTimeout(attempt, err.retryAfter * 1000)
            return
          }
          setBootError(err instanceof Error ? err.message : String(err))
          setBooting(false)
        })
    }
    attempt()
    return () => {
      cancelled = true
      clearTimeout(retryTimer)
    }
  }, [client])

  useEffect(() => refresh(), [refresh])

  // A failed handshake means the target/token is wrong: pin the Connect dialog
  // open until a save+reload resolves it. The dialog hides its Cancel button
  // while pinned so the operator must fix the connection.
  useEffect(() => {
    if (bootError) setConnectOpen(true)
  }, [bootError])

  const compatible = handshake !== null && isCompatible(LOCAL_BUILD, handshake)

  const value = useMemo<CoreContextValue>(
    () => ({
      client,
      apiBase,
      apiToken,
      handshake,
      compatible,
      booting,
      bootError,
      refresh,
      connectOpen,
      openConnect: () => setConnectOpen(true),
      closeConnect: () => setConnectOpen(false)
    }),
    [client, apiBase, apiToken, handshake, compatible, booting, bootError, refresh, connectOpen]
  )

  return <CoreContext.Provider value={value}>{children}</CoreContext.Provider>
}

/** The core connection. Throws if used outside {@link CoreProvider}. */
export function useCore(): CoreContextValue {
  const ctx = useContext(CoreContext)
  if (!ctx) throw new Error('useCore must be used within a CoreProvider')
  return ctx
}
