import { describe, expect, it } from 'vitest'
import { enforceAssistantTruth, type AssistantTruthEvidence } from '../../src/services/truth-contract.js'

const noEvidence: AssistantTruthEvidence = {
  memoryWriteVerified: false,
  memoryRecallCount: 0,
  screenContextVerified: false,
  verifiedToolResultCount: 0,
  verifiedMutationCount: 0,
}

describe('assistant truth contract', () => {
  it('rejects unsupported memory-write and recall claims', () => {
    expect(enforceAssistantTruth("I'll remember that.", noEvidence).correctedClaims).toContain('memory_write')
    expect(enforceAssistantTruth('I remember your previous fix.', noEvidence).correctedClaims).toContain('memory_recall')
  })

  it('rejects unsupported vision, running-tool, and completion claims', () => {
    expect(enforceAssistantTruth('I see it on your screen.', noEvidence).correctedClaims).toContain('vision')
    expect(enforceAssistantTruth("I'm checking the system now.", noEvidence).correctedClaims).toContain('tool_running')
    expect(enforceAssistantTruth('I fixed it. Done.', noEvidence).correctedClaims).toContain('action_complete')
  })

  it('preserves grounded claims', () => {
    const grounded: AssistantTruthEvidence = {
      memoryWriteVerified: true,
      memoryRecallCount: 1,
      screenContextVerified: true,
      verifiedToolResultCount: 2,
      verifiedMutationCount: 1,
    }
    expect(enforceAssistantTruth("I saved that preference. I see the screen, and I've fixed it.", grounded)).toEqual({
      content: "I saved that preference. I see the screen, and I've fixed it.",
      correctedClaims: [],
    })
  })
})
