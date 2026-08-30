export interface AssistantTruthEvidence {
  memoryWriteVerified: boolean
  memoryRecallCount: number
  screenContextVerified: boolean
  verifiedToolResultCount: number
  verifiedMutationCount: number
}

export interface TruthContractResult {
  content: string
  correctedClaims: Array<'memory_write' | 'memory_recall' | 'vision' | 'tool_running' | 'action_complete'>
}

const MEMORY_WRITE_CLAIM = /\b(?:i(?:'ll| will) remember(?: that| this)?|i(?:'ve| have)? (?:saved|stored|recorded|memorized|memorised) (?:that|this|it)|i(?:'ve| have) added (?:that|this|it) to (?:my )?memory)\b/i
const MEMORY_RECALL_CLAIM = /\bi remember(?: that| this| it| when| you| your)\b/i
const VISION_CLAIM = /\bi (?:can )?see (?:it|that|this|your screen|the screen|what(?:'s| is) on (?:your|the) screen)\b/i
const TOOL_RUNNING_CLAIM = /\bi(?:'m| am) (?:checking|running|investigating|scanning)\b/i
const ACTION_COMPLETE_CLAIM = /\b(?:i(?:'ve| have)? fixed (?:it|that|this|the issue)|(?:it(?:'s| is)|that(?:'s| is)) fixed|done[.!]?\s*$|task (?:is )?complete)\b/i

/**
 * Last-line defense against persuasive but unsupported first-person claims.
 * The model can phrase an answer; only application-owned evidence can grant a
 * memory, vision, tool-running, or completed-action claim.
 */
export function enforceAssistantTruth(
  content: string,
  evidence: AssistantTruthEvidence,
): TruthContractResult {
  const correctedClaims: TruthContractResult['correctedClaims'] = []
  const corrections: string[] = []

  if (MEMORY_WRITE_CLAIM.test(content) && !evidence.memoryWriteVerified) {
    correctedClaims.push('memory_write')
    corrections.push("I couldn't verify a persistent memory write, so I won't claim that this was remembered.")
  }
  if (MEMORY_RECALL_CLAIM.test(content) && evidence.memoryRecallCount < 1) {
    correctedClaims.push('memory_recall')
    corrections.push("I don't have a retrieved memory supporting that claim.")
  }
  if (VISION_CLAIM.test(content) && !evidence.screenContextVerified) {
    correctedClaims.push('vision')
    corrections.push("I don't have verified screen or image context for this response.")
  }
  if (TOOL_RUNNING_CLAIM.test(content)) {
    correctedClaims.push('tool_running')
    corrections.push('No tool is currently running. I will report a check only after a real tool result is available.')
  }
  if (ACTION_COMPLETE_CLAIM.test(content) && evidence.verifiedMutationCount < 1) {
    correctedClaims.push('action_complete')
    corrections.push("I couldn't verify a completed PC change, so I won't claim the issue is fixed or the action is done.")
  }

  return correctedClaims.length > 0
    ? { content: corrections.join(' '), correctedClaims }
    : { content, correctedClaims }
}
