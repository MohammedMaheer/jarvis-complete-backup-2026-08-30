import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

class RendererRecoveryBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('JARVIS renderer recovered from an application error', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="jarvis-renderer-recovery">
        <div className="jarvis-renderer-recovery__orb">!</div>
        <p className="jarvis-eyebrow">Neural interface recovery</p>
        <h1>The command deck hit a recoverable fault.</h1>
        <p>{this.state.error.message || 'The local renderer stopped responding.'}</p>
        <button type="button" onClick={() => window.location.reload()}>Reconnect to local core</button>
      </main>
    )
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RendererRecoveryBoundary><App /></RendererRecoveryBoundary>
  </StrictMode>,
)
