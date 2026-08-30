import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const sourceDir = resolve('src/data')
const outputDir = resolve('dist/data')

await mkdir(outputDir, { recursive: true })
for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.json')) {
    await copyFile(resolve(sourceDir, entry.name), resolve(outputDir, entry.name))
  }
}
