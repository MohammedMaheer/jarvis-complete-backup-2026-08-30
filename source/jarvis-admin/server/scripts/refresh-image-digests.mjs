#!/usr/bin/env node
// Resolve the current GHCR manifest-list digest for every first-party (repo,
// variant, track) tag and write image-digests.json. The compose generator emits
// `repo@sha256:<digest>` from this map so a later GHCR tag overwrite can't change
// what a generated compose pulls (P1.9). Run AFTER a release's images are built:
//
//   node server/scripts/refresh-image-digests.mjs
//   node server/scripts/refresh-image-digests.mjs --out ../jarvis-installer/public/image-digests.json
//
// Public images resolve with no auth. Multi-arch repos publish a manifest LIST,
// whose top-level digest covers every arch — so one pinned digest works cross-arch.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const REGISTRY = 'ghcr.io/alexberardi'
const TRACKS = ['latest', 'dev']

// Plain repos publish just `latest`/`dev`. The two GPU services publish variants;
// note the asymmetry: whisper's CPU build IS the plain (no-suffix) tag, while
// llm-proxy has NO bare tag — every published tag carries a variant suffix.
const PLAIN_REPOS = [
  'jarvis-config-service', 'jarvis-auth', 'jarvis-logs', 'jarvis-command-center',
  'jarvis-tts', 'jarvis-notifications', 'jarvis-settings-server', 'jarvis-web', 'jarvis-admin',
]
const REPO_SUFFIXES = {
  ...Object.fromEntries(PLAIN_REPOS.map((r) => [r, ['']])),
  'jarvis-whisper-api': ['', '-cuda', '-rocm', '-vulkan'],
  'jarvis-llm-proxy-api': ['-cpu', '-cuda', '-rocm', '-vulkan'],
}

function resolveDigest(ref) {
  try {
    const out = execFileSync(
      'docker',
      ['buildx', 'imagetools', 'inspect', ref, '--format', '{{.Manifest.Digest}}'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    return /^sha256:[0-9a-f]{64}$/.test(out) ? out : null
  } catch {
    return null // tag doesn't exist (e.g. a variant/track combo not published) — skip
  }
}

const map = {}
let found = 0
let missing = 0
for (const [repo, suffixes] of Object.entries(REPO_SUFFIXES)) {
  for (const suffix of suffixes) {
    for (const track of TRACKS) {
      const tag = `${track}${suffix}`
      const digest = resolveDigest(`${REGISTRY}/${repo}:${tag}`)
      if (digest) {
        ;(map[repo] ??= {})[tag] = digest
        found++
      } else {
        missing++
        process.stderr.write(`  skip ${repo}:${tag} (not published)\n`)
      }
    }
  }
}

// Stable key order so the committed file diffs cleanly release-to-release.
const sorted = {}
for (const repo of Object.keys(map).sort()) {
  sorted[repo] = {}
  for (const tag of Object.keys(map[repo]).sort()) sorted[repo][tag] = map[repo][tag]
}

const here = dirname(fileURLToPath(import.meta.url))
const outArg = process.argv.indexOf('--out')
const outPath = outArg !== -1 ? resolve(process.argv[outArg + 1]) : join(here, '..', 'src', 'data', 'image-digests.json')
writeFileSync(outPath, JSON.stringify(sorted, null, 2) + '\n')
process.stderr.write(`\nWrote ${found} digests (${missing} tags absent) -> ${outPath}\n`)
