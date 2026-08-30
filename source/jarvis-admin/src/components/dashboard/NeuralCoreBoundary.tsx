import { Component, type ErrorInfo, type ReactNode } from 'react'

export default class NeuralCoreBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error('JARVIS 3D renderer failed', error, info)
  }

  render() {
    if (this.state.failed) return <div className="jarvis-neural-dom-fallback" role="status"><span>J.A.R.V.I.S.</span><strong>3D CORE OFFLINE</strong><small>Voice, text, tools, and approvals remain operational.</small></div>
    return this.props.children
  }
}
