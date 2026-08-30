// React Three Fiber 9.7 still constructs THREE.Clock internally, while
// Three.js 0.185 marks that class deprecated. Keep the R3F-compatible API but
// implement it on top of the non-deprecated Timer so the desktop console stays
// warning-free without mutating node_modules.
export * from 'three/src/Three.js'
import { Timer } from 'three/src/core/Timer.js'

export class Clock extends Timer {
  autoStart: boolean
  startTime = 0
  oldTime = 0
  elapsedTime = 0
  running = false

  constructor(autoStart = true) {
    super()
    this.autoStart = autoStart
    if (autoStart) this.start()
  }

  start(): void {
    this.reset()
    this.startTime = performance.now()
    this.oldTime = this.startTime
    this.elapsedTime = 0
    this.running = true
  }

  stop(): void {
    if (this.running) this.update()
    this.running = false
    this.autoStart = false
  }

  getDelta(): number {
    if (!this.running) {
      if (!this.autoStart) return 0
      this.start()
    }
    this.update()
    const delta = super.getDelta()
    this.elapsedTime = super.getElapsed()
    this.oldTime = performance.now()
    return delta
  }

  getElapsedTime(): number {
    this.getDelta()
    return this.elapsedTime
  }
}
