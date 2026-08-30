import { Bot, BrainCircuit, Cpu, Database, Mic, ShieldCheck, Waves, Wrench } from 'lucide-react'
import { lazy, Suspense } from 'react'
import type { CSSProperties } from 'react'
import type { AudioLevel } from '@/lib/audio'
import type { NeuralTaskNode } from './NeuralCoreScene'
import NeuralCoreBoundary from './NeuralCoreBoundary'

const NeuralCoreScene = lazy(() => import('./NeuralCoreScene'))

interface HolographicCoreProps {
  mode: string
  isRecording: boolean
  isBusy: boolean
  micLevel?: AudioLevel | null
  ttsLevel?: AudioLevel | null
  taskSteps?: NeuralTaskNode[]
  activeModule?: CoreModule | null
  onModuleSelect?: (module: CoreModule) => void
}

export type CoreModule = 'system' | 'voice' | 'memory' | 'tools' | 'guardian'

export default function HolographicCore({ mode, isRecording, isBusy, micLevel, ttsLevel, taskSteps = [], activeModule, onModuleSelect }: HolographicCoreProps) {
  const audioLevel = Math.max(micLevel?.rms ?? 0, ttsLevel?.rms ?? 0)
  return (
    <div className="jarvis-hologram-stage" style={{ '--jarvis-audio-level': audioLevel } as CSSProperties} aria-label={`Jarvis core ${mode.toLowerCase()}`}>
      <div className="jarvis-webgl-core" aria-hidden="true"><NeuralCoreBoundary><Suspense fallback={null}><NeuralCoreScene mode={mode} audioLevel={audioLevel} tasks={taskSteps} /></Suspense></NeuralCoreBoundary></div>
      <div className="jarvis-holo-floor" aria-hidden="true" />
      <div className="jarvis-holo-beam" aria-hidden="true" />
      <div className="jarvis-holo-orbit jarvis-holo-orbit--one" aria-hidden="true"><i /><i /><i /></div>
      <div className="jarvis-holo-orbit jarvis-holo-orbit--two" aria-hidden="true"><i /><i /></div>
      <div className="jarvis-reactor jarvis-reactor--hud" data-mode={mode.toLowerCase()}>
        <div className="jarvis-reactor-ring jarvis-reactor-ring--outer" />
        <div className="jarvis-reactor-ring jarvis-reactor-ring--middle" />
        <div className="jarvis-reactor-ring jarvis-reactor-ring--inner" />
        <div className="jarvis-holo-sphere" aria-hidden="true">
          <span className="jarvis-holo-longitude jarvis-holo-longitude--a" />
          <span className="jarvis-holo-longitude jarvis-holo-longitude--b" />
          <span className="jarvis-holo-latitude jarvis-holo-latitude--a" />
          <span className="jarvis-holo-latitude jarvis-holo-latitude--b" />
        </div>
        <div className="jarvis-reactor-core jarvis-reactor-core--overlay">
          {isRecording ? <Waves size={34} /> : isBusy ? <BrainCircuit size={34} /> : <Bot size={34} />}
          <strong>J.A.R.V.I.S.</strong>
          <span>{mode}</span>
        </div>
      </div>
      <span className="jarvis-holo-label jarvis-holo-label--left">TASK GRAPH<br />{taskSteps.length ? `${taskSteps.filter((step) => step.status === 'complete').length}/${taskSteps.length}` : 'STANDBY'}</span>
      <span className="jarvis-holo-label jarvis-holo-label--right">LOCAL<br />QWEN</span>
      <div className="jarvis-core-modules" aria-label="JARVIS contextual modules">
        {([
          ['system', Cpu, 'System'],
          ['voice', Mic, 'Voice'],
          ['memory', Database, 'Memory'],
          ['tools', Wrench, 'Tools'],
          ['guardian', ShieldCheck, 'Guardian'],
        ] as const).map(([module, Icon, label]) => <button key={module} type="button" className={`jarvis-core-module jarvis-core-module--${module}`} aria-pressed={activeModule === module} onClick={() => onModuleSelect?.(module)}><Icon size={13} /><span>{label}</span></button>)}
      </div>
    </div>
  )
}
