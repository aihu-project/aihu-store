import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'bun'

const staging = await mkdtemp(join(tmpdir(), 'aihu-store-pack-'))

try {
  const source = JSON.parse(await readFile('package.json', 'utf8')) as {
    name: string
    version: string
    files?: string[]
    exports?: unknown
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
  }
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
  const requiredFiles = source.files ?? []
  for (const expected of requiredFiles) {
    const present = expected.endsWith('/')
      ? [...files].some((file) => file.startsWith(expected))
      : files.has(expected) || [...files].some((file) => file.startsWith(`${expected}/`))
    if (!present) throw new Error(`package archive is missing required file pattern ${expected}`)
  }

  function exportTargets(value: unknown): string[] {
    if (typeof value === 'string') return [value]
    if (!value || typeof value !== 'object') return []
    return Object.values(value).flatMap(exportTargets)
  }
  for (const target of exportTargets(source.exports)) {
    const path = target.replace(/^\.\//, '')
    if (path.includes('*')) continue
    if (!files.has(path)) throw new Error(`package archive is missing export target ${target}`)
  }

  const packed = JSON.parse(await $`tar -xOf ${archivePath} package/package.json`.text()) as {
    name?: string
    version?: string
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
  }
  if (packed.name !== source.name) throw new Error(`unexpected package name: ${packed.name}`)
  if (packed.version !== source.version) {
    throw new Error(`packed version ${packed.version} does not match source ${source.version}`)
  }
  const sourceDeps = source.dependencies ?? {}
  const packedDeps = packed.dependencies ?? {}
  if (JSON.stringify(packedDeps) !== JSON.stringify(sourceDeps)) {
    throw new Error(
      `packed dependencies do not match source: ${JSON.stringify({ source: sourceDeps, packed: packedDeps })}`,
    )
  }
  const dependencySections = [
    source.dependencies,
    source.devDependencies,
    source.peerDependencies,
    source.optionalDependencies,
    packed.dependencies,
    packed.devDependencies,
    packed.peerDependencies,
    packed.optionalDependencies,
  ]
  for (const section of dependencySections) {
    for (const [name, range] of Object.entries(section ?? {})) {
      if (range.startsWith('workspace:')) {
        throw new Error(`workspace dependency leaked into package metadata: ${name}@${range}`)
      }
    }
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
