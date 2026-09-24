/** Router-owned records; only a concrete session model is selected durably by Jev. */

/** User selection, including selector-only automatic values. */
export interface Selection {
  readonly provider: string
  readonly model: string
  /** Explicit user choice, not the result of an effort evaluation. */
  readonly reasoningEffort?: string | undefined
}

/** A concrete session model, committed only after its first effort also succeeds. */
export interface Pin {
  readonly provider: string
  readonly model: string
  readonly selectedAt: number
}

/** Request-level effort for one model route, and the effort currently in force. */
export interface EffortWire {
  readonly provider: string
  readonly model: string
  /** First effort sent for this route. Later changes do not rewrite it. */
  readonly requestEffort: string
  /** Request-level effort, or the latest configuration update recorded for this route. */
  readonly effectiveEffort: string
}

/** Child sessions inherit a concrete model and the parent's effort selection method. */
export interface PersistedRouter {
  readonly version: 1
  readonly selection: Selection
  /** Last applied own model/selection event; -1 means none. */
  readonly afterSeq: number
  readonly pin: Pin | null
  /** Absent on sidecars written before request-level effort was kept. */
  readonly effortWire?: EffortWire | undefined
}
