#!/usr/bin/env node

import 'hard-rejection/register.js'

import { Parser } from 'acorn'
import jsx from 'acorn-jsx'
import { spawn, spawnSync } from 'child_process'
import stamp from 'console-stamp'
import { walk } from 'estree-walker'
import { readFile } from 'fs/promises'
import { globby, isGitIgnored } from 'globby'
import LCP from 'lcp'
import { set, uniq } from 'lodash-es'
import mem from 'mem'
import path from 'path'
import { readPackage } from 'read-pkg'
import { readPackageUp } from 'read-pkg-up'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

const NODE_COLOR_SCHEME_NAME = 'set312'
const NODE_COLOR_SCHEME_SIZE = 12
const GRAPH_STYLES = ['rankdir=LR']
const NODE_STYLES_DEFAULT = [
  'shape=box',
  'style=filled',
  `colorscheme=${NODE_COLOR_SCHEME_NAME}`,
  'fontname=Helvetica'
]
const NODE_STYLES_CYCLE = [
  'colorscheme=X11',
  'fillcolor=yellow',
  'color=red',
  'fontcolor=red',
  'penwidth=2'
]
const EDGE_STYLES_DEFAULT = []
const EDGE_STYLES_CYCLE = ['color=red', 'penwidth=2']
const EDGE_STYLES_NON_PRODUCTION = ['style=dashed']

const parser = Parser.extend(jsx())

const isIgnored = await isGitIgnored()

const has = (object, key) => Object.hasOwnProperty.call(object, key)

const isImportGlobDeclaration = (node) =>
  node.type === 'ImportDeclaration' && node.source.value.includes('*')

const addModuleImportGlob = async (
  deps,
  rootPath,
  pkgDir,
  extensions,
  refPath,
  glob
) => {
  const { name: dependent } = await readPackage({ cwd: pkgDir })
  const matches = (
    await globby(glob, {
      cwd: refPath,
      absolute: true
    })
  ).filter(
    (file) =>
      !isIgnored(file) &&
      extensions.includes(path.extname(file).substring(1).toLowerCase()) &&
      !path.relative(rootPath, file).startsWith('.')
  )
  const dependencies = await Promise.all(
    matches.map(
      async (file) => (await readPackageUp({ cwd: file })).packageJson.name
    )
  )
  const filteredDependencies = uniq(
    dependencies.filter(
      (dependency) => dependency != null && dependency !== dependent
    )
  )
  for (const dependency of filteredDependencies) {
    set(deps, [dependent, dependency, 'sources', 'dependencies'], null)
  }
}

const addModuleBundlerImports = async (
  deps,
  rootPath,
  pkgDir,
  extensions,
  modId,
  allowParseError
) => {
  const refPath = path.dirname(modId)
  const code = await readFile(modId, 'utf8')
  let ast
  try {
    ast = parser.parse(code, {
      sourceType: 'module',
      ecmaVersion: 'latest',
      allowHashBang: true
    })
  } catch (error) {
    if (allowParseError) {
      console.warn(`${modId}: ${error}`)
    } else {
      const wrappedErr = new Error(`Failed to parse ${modId}: ${error}`)
      wrappedErr.cause = error
      throw wrappedErr
    }
  }
  const tasks = []
  walk(ast, {
    enter (node) {
      // TODO Support require.resolve()
      if (isImportGlobDeclaration(node)) {
        const glob = node.source.value
        tasks.push(
          addModuleImportGlob(deps, rootPath, pkgDir, extensions, refPath, glob)
        )
      }
    }
  })
  await Promise.all(tasks)
}

const addPkgBundlerImports = async (
  deps,
  rootPath,
  pkgDir,
  extensions,
  allowParseError
) => {
  const extGlob =
    extensions.length === 1 ? extensions[0] : '{' + extensions.join(',') + '}'
  const modIds = (
    await globby(['*.' + extGlob, '**/*/*.' + extGlob, '!**/node_modules/**'], {
      cwd: pkgDir,
      absolute: true
    })
  ).filter((modId) => !isIgnored(modId))
  await Promise.all(
    modIds.map(async (modId) => {
      await addModuleBundlerImports(
        deps,
        rootPath,
        pkgDir,
        extensions,
        modId,
        allowParseError
      )
    })
  )
}

const addBundlerImports = async (
  deps,
  rootPath,
  pkgDirs,
  extensions,
  allowParseError
) => {
  await Promise.all(
    pkgDirs.map(async (pkgDir) => {
      await addPkgBundlerImports(
        deps,
        rootPath,
        pkgDir,
        extensions,
        allowParseError
      )
    })
  )
}

const buildDeps = async (
  rootPath,
  bundlerImports,
  extensions,
  allowParseError
) => {
  const { workspaces } = await readPackage({ cwd: rootPath })
  const pkgDirs = await globby(workspaces, {
    cwd: rootPath,
    absolute: true,
    onlyDirectories: true
  })
  const deps = {}
  await Promise.all(
    pkgDirs.map(async (pkgDir) => {
      const { name } = await readPackage({ cwd: pkgDir })
      deps[name] = {}
    })
  )
  await Promise.all(
    pkgDirs.map(async (pkgDir) => {
      const pkg = await readPackage({ cwd: pkgDir })
      for (const source of [
        'dependencies',
        'devDependencies',
        'optionalDependencies'
      ]) {
        if (pkg[source] == null) {
          continue
        }
        const matchingDeps = Object.keys(pkg[source]).filter((name) =>
          has(deps, name)
        )
        for (const depName of matchingDeps) {
          set(deps, [pkg.name, depName, 'sources', source], null)
        }
      }
    })
  )
  if (bundlerImports) {
    await addBundlerImports(
      deps,
      rootPath,
      pkgDirs,
      extensions,
      allowParseError
    )
  }
  return deps
}

const markCycles = (deps) => {
  const queue = Object.keys(deps).map((dependent) => [dependent, []])
  const seen = {}
  let cycleCount = 0

  const onCycle = (trail) => {
    console.warn('Cycle detected: ' + trail.join(' -> '))
    for (let i = 1; i < trail.length; ++i) {
      set(deps, [trail[i - 1], trail[i], 'cycle'], true)
    }
    for (const pkgName of trail) {
      seen[pkgName] = null
    }
    ++cycleCount
  }

  while (queue.length > 0) {
    const [pkgName, ancestors] = queue.shift()
    if (has(seen, pkgName)) {
      continue
    }
    const newAncestors = [...ancestors, pkgName]
    for (const dependency of Object.keys(deps[pkgName] || {})) {
      if (ancestors.includes(dependency)) {
        onCycle([...ancestors, pkgName, dependency])
      } else {
        queue.push([dependency, newAncestors])
      }
    }
  }

  return cycleCount
}

const writeDot = (deps, out) => {
  const nodes = {}
  const { length: lcpLength } = new LCP(Object.keys(deps)).lcp()
  const label = (str) => '"' + str.substring(lcpLength) + '"'
  const write = (str) => {
    out.write(str + '\n')
  }
  write('digraph g {')
  for (const style of GRAPH_STYLES) {
    write(`  ${style}`)
  }
  for (const [dependent, dependencyData] of Object.entries(deps)) {
    set(nodes, [dependent, '_'], null)
    for (const [dependency, { sources = {}, cycle }] of Object.entries(
      dependencyData
    )) {
      const styles = [...EDGE_STYLES_DEFAULT]
      if (cycle) {
        set(nodes, [dependent, 'cycle'], true)
        styles.push(...EDGE_STYLES_CYCLE)
      }
      if (!has(sources, 'dependencies')) {
        styles.push(...EDGE_STYLES_NON_PRODUCTION)
      }
      write(`  ${label(dependent)} -> ${label(dependency)} [${styles}]`)
    }
  }
  let idx = 0
  const getFillColor = mem(() => {
    const color = idx + 1
    idx = (idx + 1) % NODE_COLOR_SCHEME_SIZE
    return color
  })
  for (const [pkgName, { cycle }] of Object.entries(nodes)) {
    const styles = [...NODE_STYLES_DEFAULT]
    const comps = pkgName.substring(lcpLength).split('-')
    const prefix = comps[0] + (comps.length > 1 ? '-' : '')
    const color = getFillColor(prefix)
    styles.push('fillcolor=' + color)
    if (cycle) {
      styles.push(...NODE_STYLES_CYCLE)
    }
    write(`  ${label(pkgName)} [${styles}]`)
  }
  write('}')
  out.end()
}

const generateImage = (deps, outputFile) =>
  new Promise((resolve, reject) => {
    const outputType = path.extname(outputFile).substring(1).toLowerCase()
    const proc = spawn('dot', ['-T' + outputType, '-o', outputFile], {
      stdio: ['pipe', 'ignore', 'inherit'],
      env: process.env
    })
    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Exited with ${code}`))
      } else {
        resolve()
      }
    })
    proc.on('error', reject)
    writeDot(deps, proc.stdin)
  })

const ensureDotExecutable = () => {
  try {
    const { error } = spawnSync('dot', ['-?'], {
      stdio: 'ignore',
      env: process.env
    })
    if (error) {
      throw error
    }
  } catch (error) {
    throw new Error(`Failed to spawn dot: ${error}`)
  }
}

const main = async () => {
  stamp(console, { pattern: 'HH:MM:ss' })
  ensureDotExecutable()
  const {
    path: rootPathRel,
    output: outputFileRel,
    extensions: extensionsStr,
    bundlerImports,
    allowParseError
  } = yargs(hideBin(process.argv))
    .option('path', {
      type: 'string',
      alias: 'p',
      default: '.'
    })
    .option('output', {
      type: 'string',
      alias: 'o',
      default: 'dependencies.svg'
    })
    .option('extensions', {
      type: 'string',
      default: 'js'
    })
    .option('bundler-imports', {
      type: 'boolean',
      default: false
    })
    .option('allow-parse-error', {
      type: 'boolean',
      default: false
    })
    .strict()
    .parse()
  const extensions = extensionsStr
    .split(',')
    .map((ext) => ext.trim().toLowerCase())
  const rootPath = path.resolve(process.cwd(), rootPathRel)
  const outputFile = path.resolve(rootPath, outputFileRel)
  console.info(`Building dependency graph for ${rootPath}`)
  const deps = await buildDeps(
    rootPath,
    bundlerImports,
    extensions,
    allowParseError
  )
  console.info(`Found ${Object.keys(deps).length} package(s)`)
  console.info('Discovering dependency cycles')
  const cycleCount = markCycles(deps)
  if (cycleCount > 0) {
    console.warn(`Found ${cycleCount} dependency cycle(s)`)
  } else {
    console.info('No dependency cycles found')
  }
  console.info(`Writing dependency graph to ${outputFile}`)
  await generateImage(deps, outputFile)
  console.info('Completed')
  process.exit(cycleCount)
}

main()
