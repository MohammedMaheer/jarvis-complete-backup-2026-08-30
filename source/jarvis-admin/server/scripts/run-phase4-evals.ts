import { runPhase4DeterministicEvaluation } from '../src/services/phase4-evaluation.js'

const result = runPhase4DeterministicEvaluation()
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (!result.regressionGatePassed) process.exitCode = 1
