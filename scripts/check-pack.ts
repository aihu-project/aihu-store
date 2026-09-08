import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'bun'

const staging = await mkdtemp(join(tmpdir(), 'aihu-store-pack-'))

try {
  await $`bun run build`
  const archiveOutput = await $`npm pack --json --ignore-scripts`.text()
  const [entry] = JSON.parse(archiveOutput) as Array<{
    filename: string
    files: Array<{ path: string }>
  }>
  if (!entry?.filename) throw new Error('npm pack returned no archive')

  const archivePath = join(staging, entry.filename)
  await $`mv ${entry.filename} ${archivePath}`
  const files = new Set(entry.files.map((file) => file.path))
  for (const expected of ['dist/index.js', 'dist/index.d.ts', 'README.md', 'LICENSE']) {
    if (!files.has(expected)) throw new Error(`package archive is missing ${expected}`)
  }

  const packed = JSON.parse(await $`tar -xOf ${archivePath} package/package.json`.text()) as {
    name?: string
    version?: string
    dependencies?: Record<string, string>
  }
  if (packed.name !== '@aihu/store') throw new Error(`unexpected package name: ${packed.name}`)
  if (!packed.version || !/^0\.1\.3$/.test(packed.version)) {
    throw new Error(`unexpected package version: ${packed.version}`)
  }
  for (const [name, range] of Object.entries(packed.dependencies ?? {})) {
    if (range.startsWith('workspace:')) {
      throw new Error(`workspace dependency leaked into package: ${name}@${range}`)
    }
  }
  if (packed.dependencies?.['@aihu/context'] !== '^0.2.0') {
    throw new Error('package must consume the published @aihu/context ^0.2.0 range')
  }

  const consumer = join(staging, 'consumer')
  await $`mkdir -p ${consumer}`
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'aihu-store-pack-consumer',
        private: true,
        type: 'module',
        dependencies: { '@aihu/store': `file:${archivePath}` },
        devDependencies: { typescript: '^5.6.2' },
      },
      null,
      2,
    ),
  )
  await writeFile(
    join(consumer, 'index.ts'),
    "import { defineStore, hydrateStores, serializeStores } from '@aihu/store'\nconst useCounter = defineStore('pack-check', () => ({ count: () => 1, setCount: () => {}, ping: () => 'ok' }))\nconst store = useCounter()\nstore.ping()\nserializeStores()\nhydrateStores({})\n",
  )
  await writeFile(
    join(consumer, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['index.ts'],
      },
      null,
      2,
    ),
  )
  await $`bun install --cwd ${consumer}`
  process.chdir(consumer)
  await $`bun x tsc --noEmit`
  console.log(`pack and isolated consumer checks passed: ${entry.filename}`)
} finally {
  await rm(staging, { recursive: true, force: true })
}
