export interface Env {
  /**
   * The policy worker's `Fleet` entrypoint, bound only on our own fleet
   * deployment (wrangler.fleet.toml). Bound ⇒ it is the address and the
   * credential both: DNA_ENDPOINT and DNA_API_KEY go unread.
   */
  POLICY_WORKER?: Fetcher;
  /** The org's API key, a secret. Set ⇒ DNA is on, calling the default endpoint. */
  DNA_API_KEY?: string;
  /** Decision endpoint override; empty ⇒ off. */
  DNA_ENDPOINT?: string;
  /** "false" turns DNA off without removing the key. */
  DNA_ENABLED?: string;
  /** "open" (default): pass traffic when the policy call fails (§8); "closed": block. */
  DNA_FAIL_MODE?: string;
  /** Hot-path budget for the policy call, ms (default 2000, §11). */
  DNA_TIMEOUT_MS?: string;
  /** Budget for a request presenting a payment, ms (default 10000). Sized in
   *  seconds, not the hot path's milliseconds: settlement happens inside this
   *  call, and the caller is waiting for it. */
  DNA_PAYMENT_TIMEOUT_MS?: string;
  /** "true" forwards every request header but the credentials, for the request record
   *  (kept only under the policy worker's own flag). Unset in production. */
  DNA_DEBUG_LOG_RAW_PAYLOAD?: string;
  /** @deprecated DNA_ENDPOINT. Unlike DNA_API_KEY, the old key names need this set to switch DNA on. */
  POLICY_WORKER_URL?: string;
  /** @deprecated DNA_API_KEY */
  POLICY_ADAPTER_KEY?: string;
  /** @deprecated DNA_API_KEY */
  POLICY_SHARED_SECRET?: string;
  /** @deprecated DNA_TIMEOUT_MS */
  POLICY_TIMEOUT_MS?: string;
  /** @deprecated DNA_PAYMENT_TIMEOUT_MS */
  POLICY_PAYMENT_TIMEOUT_MS?: string;
  /** @deprecated DNA_FAIL_MODE */
  FAIL_MODE?: string;
  /** @deprecated DNA_DEBUG_LOG_RAW_PAYLOAD. Read only alongside POLICY_WORKER_URL. */
  DEBUG_LOG_RAW_PAYLOAD?: string;
  /** Origin that is itself a Worker (no public hop). Takes precedence over ORIGIN_URL. */
  ORIGIN?: Fetcher;
  /** Origin override for proxying; default re-fetches the incoming request (zone routing). */
  ORIGIN_URL?: string;
}
