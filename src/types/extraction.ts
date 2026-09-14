export type CandidateSource = 'link' | 'alt' | 'subject' | 'text' | 'ocr'

export interface Candidate {
  /** Exact case as it appears, per §9. */
  code: string
  /** Uppercased form used only for matching and deduplication. */
  normalized: string
  source: CandidateSource
  score: number
}

export interface GateResult {
  /** Deduplicated by normalized code, highest score first. */
  candidates: Candidate[]
  hasTriggerPhrase: boolean
  /**
   * §7: when false, cache the message as no-code and stop before spending a
   * token. The regex stage is a gate, not an answer.
   */
  shouldExtract: boolean
}

export interface TriggerContext {
  afterTrigger: boolean
  nearTrigger: boolean
}
