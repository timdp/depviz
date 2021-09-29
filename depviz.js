#!/usr/bin/env node

require('hard-rejection/register')
const { parse } = require('acorn')
const Bottleneck = require('bottleneck')
const stamp = require('console-stamp')
const { walk } = require('estree-walker')
const globby = require('globby')
const LCP = require('lcp')
const { set, uniq } = require('lodash')
const mem = require('mem')
const readPkg = require('read-pkg')
const readPkgUp = require('read-pkg-up')
const yargs = require('yargs')
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { promisify } = require('util')

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
const CONCURRENCY = os.cpus().length

const readFile = promisify(fs.readFile)

const readdir = promisify(fs.readdir)

const readPkgCwd = mem(cwd => readPkg({ cwd }))

const has = (object, key) => Object.hasOwnProperty.call(object, key)

const isRequireContextMemberExpression = node =>
  node.type === 'MemberExpression' &&
  node.object.name === 'require' &&
  node.property.name === 'context'

const isImportGlobDeclaration = node =>
  node.type === 'ImportDeclaration' && node.source.value.includes('*')

// TODO Mirror Webpack's algorithm more closely
const addModuleRequireContext = async (
  schedule,
  deps,
  pkgsPath,
  pkgId,
  refPath,
  directory,
  useSubDirectory,
  regExp
) => {
  const { name: dependent } = await schedule(() =>
    readPkgCwd(path.join(pkgsPath, pkgId))
  )
  const dirPath = path.join(refPath, directory)
  const globOpts = {
    cwd: dirPath,
    dot: true,
    onlyFiles: false,
    deep: useSubDirectory
  }
  const dependencyModules = (
    await schedule(() => globby(['**', '!**/node_modules/**'], globOpts))
  )
    .filter(
      mod =>
        regExp.test('./' + mod) ||
        regExp.test('./' + mod.replace(/\.[^./]+$/, ''))
    )
    .map(mod => path.join(dirPath, mod))
    .map(mod => path.relative(pkgsPath, mod))
  const dependencies = await Promise.all(
    dependencyModules.map(async mod => {
      const cwd = path.join(pkgsPath, path.dirname(mod))
      const {
        packageJson: { name: dependency }
      } = await schedule(() => readPkgUp({ cwd }))
      return dependency
    })
  )
  const filteredDependencies = uniq(
    dependencies.filter(dependency => dependency !== dependent)
  )
  for (const dependency of filteredDependencies) {
    set(deps, [dependent, dependency, 'sources', 'dependencies'], null)
  }
}

const addModuleImportGlob = async (
  schedule,
  deps,
  pkgsPath,
  pkgId,
  refPath,
  glob
) => {
  const { name: dependent } = await schedule(() =>
    readPkgCwd(path.join(pkgsPath, pkgId))
  )
  const matches = await schedule(() => globby(path.join(refPath, glob)))
  const dependencies = await Promise.all(
    matches.map(async file => {
      const relPath = path.relative(pkgsPath, file)
      if (relPath.startsWith('.')) {
        return null
      }
      const pkgDir = relPath.split(path.sep)[0]
      const pkgPath = path.join(pkgsPath, pkgDir)
      const { name } = await readPkgCwd(pkgPath)
      return name
    })
  )
  const filteredDependencies = uniq(
    dependencies.filter(
      dependency => dependency != null && dependency !== dependent
    )
  )
  for (const dependency of filteredDependencies) {
    set(deps, [dependent, dependency, 'sources', 'dependencies'], null)
  }
}

const addModuleBundlerImports = async (
  schedule,
  deps,
  pkgsPath,
  pkgId,
  modId,
  allowParseError
) => {
  const refPath = path.dirname(modId)
  const code = await schedule(() => readFile(modId, 'utf8'))
  let ast
  try {
    ast = parse(code, {
      sourceType: 'module',
      ecmaVersion: 'latest',
      allowHashBang: true
    })
  } catch (err) {
    if (allowParseError) {
      console.warn(`${modId}: ${err}`)
    } else {
      const wrappedErr = new Error(`Failed to parse ${modId}: ${err}`)
      wrappedErr.cause = err
      throw wrappedErr
    }
  }
  const tasks = []
  walk(ast, {
    enter (node, parent) {
      if (isRequireContextMemberExpression(node)) {
        const [
          { value: directory },
          { value: useSubDirectory } = { value: false },
          { value: regExp } = { value: /^\.\// }
        ] = parent.arguments
        tasks.push(
          addModuleRequireContext(
            schedule,
            deps,
            pkgsPath,
            pkgId,
            refPath,
            directory,
            useSubDirectory,
            regExp
          )
        )
      } else if (isImportGlobDeclaration(node)) {
        const glob = node.source.value
        tasks.push(
          addModuleImportGlob(schedule, deps, pkgsPath, pkgId, refPath, glob)
        )
      }
    }
  })
  await Promise.all(tasks)
}

const addPkgBundlerImports = async (
  schedule,
  deps,
  pkgsPath,
  pkgId,
  allowParseError
) => {
  const modIds = await schedule(() =>
    globby([path.join(pkgsPath, pkgId, '**/*.js'), '!**/node_modules/**'])
  )
  await Promise.all(
    modIds.map(modId =>
      addModuleBundlerImports(
        schedule,
        deps,
        pkgsPath,
        pkgId,
        modId,
        allowParseError
      )
    )
  )
}

const addBundlerImports = async (
  schedule,
  deps,
  pkgsPath,
  pkgIds,
  allowParseError
) => {
  await Promise.all(
    pkgIds.map(pkgId =>
      addPkgBundlerImports(schedule, deps, pkgsPath, pkgId, allowParseError)
    )
  )
}

const buildDeps = async (
  schedule,
  rootPath,
  bundlerImports,
  allowParseError
) => {
  // TODO Get monorepo/workspace paths from package.json
  const pkgsPath = path.join(rootPath, 'packages')
  const pkgIds = (
    await schedule(() => readdir(pkgsPath, { withFileTypes: true }))
  )
    .filter(ent => ent.isDirectory())
    .map(ent => ent.name)
  const deps = {}
  await Promise.all(
    pkgIds.map(async pkgId => {
      const { name } = await schedule(() =>
        readPkgCwd(path.join(pkgsPath, pkgId))
      )
      deps[name] = {}
    })
  )
  await Promise.all(
    pkgIds.map(async pkgId => {
      const pkg = await schedule(() => readPkgCwd(path.join(pkgsPath, pkgId)))
      for (const source of [
        'dependencies',
        'devDependencies',
        'optionalDependencies'
      ]) {
        if (pkg[source] == null) {
          continue
        }
        const matchingDeps = Object.keys(pkg[source]).filter(name =>
          has(deps, name)
        )
        for (const depName of matchingDeps) {
          set(deps, [pkg.name, depName, 'sources', source], null)
        }
      }
    })
  )
  if (bundlerImports) {
    await addBundlerImports(schedule, deps, pkgsPath, pkgIds, allowParseError)
  }
  return deps
}

const markCycles = deps => {
  const queue = Object.keys(deps).map(dependent => [dependent, []])
  const seen = {}
  let cycleCount = 0

  const onCycle = trail => {
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
  const label = str => '"' + str.substr(lcpLength) + '"'
  const write = str => {
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
    const comps = pkgName.substr(lcpLength).split('-')
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
    const outputType = path
      .extname(outputFile)
      .substr(1)
      .toLowerCase()
    const proc = spawn('dot', ['-T' + outputType, '-o', outputFile], {
      stdio: 'pipe',
      env: process.env
    })
    proc.on('exit', code => {
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
  } catch (err) {
    throw new Error(`Failed to spawn dot: ${err}`)
  }
}

const main = async () => {
  stamp(console, { pattern: 'HH:MM:ss' })
  ensureDotExecutable()
  const { bundlerImports, allowParseError, _: args = [] } = yargs
    .option('bundler-imports', {
      type: 'boolean',
      default: false,
      alias: 'require-context'
    })
    .option('allow-parse-error', {
      type: 'boolean',
      default: false
    })
    .strict()
    .parse()
  const [rootPathRel = '.', outputFileRel = 'dependencies.svg'] = args
  const rootPath = path.resolve(process.cwd(), rootPathRel)
  const outputFile = path.resolve(rootPath, outputFileRel)
  console.info(`Building dependency graph for ${rootPath}`)
  const limiter = new Bottleneck({ maxConcurrent: CONCURRENCY })
  const schedule = fn => limiter.schedule(fn)
  const deps = await buildDeps(
    schedule,
    rootPath,
    bundlerImports,
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
