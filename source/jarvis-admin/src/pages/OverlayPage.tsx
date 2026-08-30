import JarvisCommandConsole from '@/components/dashboard/JarvisCommandConsole'

/**
 * The overlay is the same authenticated assistant and conversation surface as
 * the command deck, rendered in a compact window. It deliberately reuses the
 * voice, memory, agent, approval, and cancellation paths instead of creating a
 * second lightweight-but-less-capable chatbot.
 */
export default function OverlayPage() {
  return <JarvisCommandConsole compact />
}
