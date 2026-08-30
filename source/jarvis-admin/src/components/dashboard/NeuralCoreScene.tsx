import { Canvas, useFrame } from '@react-three/fiber'
import { Sparkles } from '@react-three/drei'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MathUtils, type Group, type Mesh } from 'three'

export interface NeuralTaskNode {
  id: string
  title: string
  tool: string
  status: 'pending' | 'ready' | 'running' | 'waiting_approval' | 'retrying' | 'complete' | 'failed' | 'skipped' | 'cancelled'
}

function modeColor(mode: string): string {
  if (mode === 'LISTENING') return '#fb7185'
  if (mode === 'AUTHORIZATION') return '#fbbf24'
  if (mode === 'RECOVERING') return '#c4b5fd'
  if (mode === 'ERROR') return '#ff5867'
  if (mode === 'CANCELLED') return '#94a3b8'
  if (['PLANNING', 'THINKING', 'MEMORY', 'EXECUTING', 'TRANSCRIBING'].includes(mode)) return '#fbbf24'
  if (mode === 'SPEAKING' || mode === 'COMPLETE') return '#6ee7b7'
  return '#22d3ee'
}

function SceneRig({ reducedMotion, pointerFine, children }: { reducedMotion: boolean; pointerFine: boolean; children: ReactNode }) {
  const rig = useRef<Group>(null)
  useFrame(({ pointer }, delta) => {
    if (!rig.current) return
    const targetYaw = reducedMotion || !pointerFine ? 0 : pointer.x * MathUtils.degToRad(1.5)
    const targetPitch = reducedMotion || !pointerFine ? 0 : -pointer.y * MathUtils.degToRad(1)
    const damping = 1 - Math.exp(-delta * 4.5)
    rig.current.rotation.y = MathUtils.lerp(rig.current.rotation.y, targetYaw, damping)
    rig.current.rotation.x = MathUtils.lerp(rig.current.rotation.x, targetPitch, damping)
  })
  return <group ref={rig}>{children}</group>
}

function Reactor({ mode, audioLevel, reducedMotion }: { mode: string; audioLevel: number; reducedMotion: boolean }) {
  const group = useRef<Group>(null)
  const inner = useRef<Mesh>(null)
  const color = modeColor(mode)
  useFrame((state, delta) => {
    if (!group.current || !inner.current) return
    const active = ['PLANNING', 'THINKING', 'MEMORY', 'EXECUTING', 'TRANSCRIBING', 'RECOVERING'].includes(mode)
    const authorization = mode === 'AUTHORIZATION'
    if (!reducedMotion && !authorization) group.current.rotation.y += delta * (active ? 0.7 : mode === 'SPEAKING' ? 0.42 : 0.11)
    group.current.rotation.x = reducedMotion ? 0 : Math.sin(state.clock.elapsedTime * 0.28) * 0.035
    const semanticPulse = active ? Math.sin(state.clock.elapsedTime * 2.1) * 0.035 : mode === 'COMPLETE' ? 0.08 : 0
    inner.current.scale.setScalar(1 + semanticPulse + Math.min(0.28, audioLevel * 0.34))
  })
  return (
    <group ref={group}>
      <mesh ref={inner}><icosahedronGeometry args={[0.78, 4]} /><meshPhysicalMaterial color={color} emissive={color} emissiveIntensity={2.5} roughness={0.16} metalness={0.4} transparent opacity={0.72} wireframe /></mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[1.18, 0.018, 12, 128]} /><meshBasicMaterial color={color} transparent opacity={0.78} /></mesh>
      <mesh rotation={[0.82, 0.2, 0.4]}><torusGeometry args={[1.55, 0.012, 10, 128]} /><meshBasicMaterial color="#22d3ee" transparent opacity={0.42} /></mesh>
      <mesh rotation={[1.72, 0.3, -0.5]}><torusGeometry args={[1.92, 0.009, 10, 128]} /><meshBasicMaterial color={mode === 'AUTHORIZATION' ? '#fbbf24' : '#67e8f9'} transparent opacity={0.3} /></mesh>
    </group>
  )
}

function TaskGraph({ tasks }: { tasks: NeuralTaskNode[] }) {
  const graph = useRef<Group>(null)
  useFrame((_, delta) => {
    if (graph.current && tasks.some((task) => task.status === 'running' || task.status === 'retrying')) graph.current.rotation.z += delta * 0.045
  })
  const nodes = useMemo(() => tasks.slice(0, 6).map((task, index, list) => {
    const angle = (index / Math.max(1, list.length)) * Math.PI * 2 - Math.PI / 2
    return { ...task, position: [Math.cos(angle) * 2.35, Math.sin(angle) * 1.28, -0.42 + (index % 2) * 0.28] as const }
  }), [tasks])
  if (nodes.length === 0) return null
  return <group ref={graph}>{nodes.map((node) => {
    const color = node.status === 'complete' ? '#6ee7b7' : node.status === 'failed' ? '#fb7185' : node.status === 'waiting_approval' ? '#fbbf24' : node.status === 'retrying' ? '#c4b5fd' : node.status === 'running' ? '#67e8f9' : '#155e75'
    const size = node.status === 'running' || node.status === 'waiting_approval' ? 0.095 : 0.06
    return <group key={node.id} position={node.position}><mesh><sphereGeometry args={[size, 16, 16]} /><meshBasicMaterial color={color} transparent opacity={node.status === 'skipped' || node.status === 'cancelled' ? 0.28 : 0.9} /></mesh><mesh rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[size * 2.2, 0.006, 8, 40]} /><meshBasicMaterial color={color} transparent opacity={0.35} /></mesh></group>
  })}</group>
}

export default function NeuralCoreScene({ mode, compact = false, audioLevel = 0, tasks = [] }: { mode: string; compact?: boolean; audioLevel?: number; tasks?: NeuralTaskNode[] }) {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [pointerFine, setPointerFine] = useState(false)
  const [contextLost, setContextLost] = useState(false)
  const rendererCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden)
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const pointer = window.matchMedia('(pointer: fine)')
    const update = () => { setReducedMotion(motion.matches); setPointerFine(pointer.matches) }
    document.addEventListener('visibilitychange', onVisibility)
    update()
    motion.addEventListener?.('change', update)
    pointer.addEventListener?.('change', update)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      motion.removeEventListener?.('change', update)
      pointer.removeEventListener?.('change', update)
    }
  }, [])
  useEffect(() => () => rendererCleanupRef.current?.(), [])
  const onCreated = useCallback(({ gl }: { gl: { domElement: HTMLCanvasElement } }) => {
    rendererCleanupRef.current?.()
    const canvas = gl.domElement
    const onLost = (event: Event) => { event.preventDefault(); setContextLost(true) }
    const onRestored = () => setContextLost(false)
    canvas.addEventListener('webglcontextlost', onLost, { passive: false })
    canvas.addEventListener('webglcontextrestored', onRestored)
    rendererCleanupRef.current = () => { canvas.removeEventListener('webglcontextlost', onLost); canvas.removeEventListener('webglcontextrestored', onRestored) }
  }, [])
  const lowPower = compact || reducedMotion || (navigator.hardwareConcurrency ?? 8) < 8
  const active = ['LISTENING', 'PLANNING', 'TRANSCRIBING', 'THINKING', 'MEMORY', 'EXECUTING', 'RECOVERING', 'SPEAKING'].includes(mode)
  const particleCount = lowPower ? 28 : active ? 118 : 58
  const particleSpeed = reducedMotion ? 0 : mode === 'EXECUTING' || mode === 'PLANNING' ? 0.6 : mode === 'SPEAKING' ? 0.46 : 0.16
  return (
    <div className="jarvis-neural-stage" data-context-lost={contextLost || undefined}>
      <Canvas onCreated={onCreated} frameloop={visible && !reducedMotion ? 'always' : 'demand'} dpr={[1, lowPower ? 1.25 : 1.6]} camera={{ position: [0, 0.28, compact ? 5.4 : 4.7], fov: 42 }} gl={{ alpha: true, antialias: !lowPower, powerPreference: 'high-performance' }} className="jarvis-neural-canvas">
        <ambientLight intensity={0.34} />
        <pointLight position={[2, 2, 3]} color="#67e8f9" intensity={18} distance={8} />
        <pointLight position={[-2, -1, 2]} color={modeColor(mode)} intensity={10} distance={7} />
        <SceneRig reducedMotion={reducedMotion} pointerFine={pointerFine}>
          <Reactor mode={mode} audioLevel={audioLevel} reducedMotion={reducedMotion} />
          <TaskGraph tasks={tasks} />
          <Sparkles count={particleCount} scale={[5.8, 3.5, 3]} size={active ? 1.8 : 1.25} speed={particleSpeed} color={modeColor(mode)} opacity={0.58} />
        </SceneRig>
      </Canvas>
      {contextLost && <div className="jarvis-neural-recovery" role="status">3D CORE DEGRADED · COMMAND SYSTEM REMAINS AVAILABLE</div>}
    </div>
  )
}
