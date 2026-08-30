import { execSync } from 'node:child_process'
import { platform } from 'node:os'
import type { GpuType } from '../types/wizard.js'

/**
 * Detect the host's GPU type by probing the system. Returns 'none' on failure.
 *
 * Used by the upgrade flow's state-reconstructor: the .env file doesn't
 * persist the user's hardware selection from the original install wizard,
 * so reconcile must re-detect or the generator strips GPU runtime config
 * (NVIDIA deploy block, ipc:host, shm_size) from gpu: true services like
 * jarvis-llm-proxy-api — bricking the container on next compose up.
 */
export function detectGpuType(): GpuType {
  const plat = platform()

  if (plat === 'darwin') {
    try {
      const output = execSync('system_profiler SPDisplaysDataType -json', {
        encoding: 'utf-8',
        timeout: 10_000,
      })
      const data = JSON.parse(output) as { SPDisplaysDataType?: unknown[] }
      if (data?.SPDisplaysDataType?.[0]) return 'apple'
    } catch {
      // Fall through to 'none'
    }
    return 'none'
  }

  if (plat === 'linux') {
    // NVIDIA: nvidia-smi exits 0 if a CUDA-capable GPU is present.
    try {
      execSync('nvidia-smi --query-gpu=name --format=csv,noheader -L 2>/dev/null || nvidia-smi -L', {
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: 'pipe',
      })
      return 'nvidia'
    } catch {
      // Not NVIDIA via nvidia-smi. We may be inside a docker container without
      // nvidia-smi on PATH — fall back to asking the docker daemon (if its
      // socket is mounted, which it is for jarvis-admin) whether it has the
      // nvidia runtime registered. Presence of the runtime strongly implies
      // the host has a CUDA-capable GPU and nvidia-container-toolkit installed.
      try {
        const runtimes = execSync('docker info --format "{{json .Runtimes}}" 2>/dev/null', {
          encoding: 'utf-8',
          timeout: 5_000,
          stdio: 'pipe',
        })
        if (/"nvidia"/.test(runtimes)) return 'nvidia'
      } catch {
        // Docker socket not available either; try AMD.
      }
    }

    // AMD: lspci reports VGA/Display class with "AMD" or "Advanced Micro Devices".
    // We can't tell ROCm vs Vulkan from probe alone — default to 'amd' (Vulkan)
    // so cpuFallback services skip the variant suffix, and let the user opt
    // into ROCm explicitly if they want it.
    try {
      const output = execSync('lspci 2>/dev/null | grep -i "vga\\|3d\\|display" || true', {
        encoding: 'utf-8',
        timeout: 10_000,
      })
      if (/AMD|Advanced Micro Devices/i.test(output)) return 'amd'
    } catch {
      // Fall through
    }
  }

  return 'none'
}
