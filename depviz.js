#!/usr/bin/env node

require('hard-rejection/register')
const globby = require('globby')
const readPkg = require('read-pkg')
const readPkgUp = require('read-pkg-up')
const LCP = require('lcp')
const { parse } = require('acorn')
const { walk } = require('estree-walker')
const pMap = require('p-map')
const _ = require('lodash')
const { promises: fs } = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const GRAPH_STYLES = ['rankdir=LR']
const NODE_STYLES_DEFAULT = ['shape=box', 'fontname=Helvetica']
const NODE_STYLES_CYCLE = ['color=red', 'fontcolor=red', 'penwidth=2']
const EDGE_STYLES_DEFAULT = []
const EDGE_STYLES_CYCLE = ['color=red', 'penwidth=2']
const EDGE_STYLES_NON_PRODUCTION = ['style=dashed']

const isRequireContextMemberExpression = node =>
  node.type === 'MemberExpression' &&
  node.object.name === 'require' &&
  node.property.name === 'context'

// TODO Mirror Webpack's algorithm more closely
const onRequireContext = (
  deps,
  pkgsPath,
  pkgId,
  refPath,
  directory,
  useSubDirectory,
  regExp
) => {
  const { name: dependent } = readPkg.sync({ cwd: path.join(pkgsPath, pkgId) })
  const dirPath = path.join(refPath, directory)
  const globOpts = {
    cwd: dirPath,
    dot: true,
    onlyFiles: false,
    deep: useSubDirectory
  }
  const dependencyModules = globby
    .sync(['**', '!**/node_modules/**'], globOpts)
    .filter(
      mod =>
        regExp.test('./' + mod) ||
        regExp.test('./' + mod.replace(/\.[^./]+$/, ''))
    )
    .map(mod => path.join(dirPath, mod))
    .map(mod => path.relative(pkgsPath, mod))
  const dependencies = _.uniq(
    dependencyModules
      .map(mod => {
        const cwd = path.join(pkgsPath, path.dirname(mod))
        const {
          pkg: { name: dependency }
        } = readPkgUp.sync({ cwd })
        return dependency
      })
      .filter(dependency => dependency !== dependent)
  )
  for (const dependency of dependencies) {
    _.set(deps, [dependent, dependency, 'sources', 'dependencies'], null)
  }
}

const addRequireContexts = async (deps, pkgsPath, pkgIds) => {
  await Promise.all(
    pkgIds.map(async pkgId => {
      const sources = await globby([
        path.join(pkgsPath, pkgId, '**/*.js'),
        '!**/node_modules/**'
      ])
      await pMap(
        sources,
        async file => {
          const refPath = path.dirname(file)
          const code = await fs.readFile(file, 'utf8')
          const ast = parse(code, { sourceType: 'module', allowHashBang: true })
          walk(ast, {
            enter (node, parent) {
              if (!isRequireContextMemberExpression(node)) {
                return
              }
              const [
                { value: directory },
                { value: useSubDirectory } = { value: false },
                { value: regExp } = { value: /^\.\// }
              ] = parent.arguments
              onRequireContext(
                deps,
                pkgsPath,
                pkgId,
                refPath,
                directory,
                useSubDirectory,
                regExp
              )
            }
          })
        },
        // TODO Make configurable
        { concurrency: 5 }
      )
    })
  )
}

const buildDeps = async rootPath => {
  // TODO Get monorepo/workspace paths from package.json
  const pkgsPath = path.join(rootPath, 'packages')
  const pkgIds = (await fs.readdir(pkgsPath, { withFileTypes: true }))
    .filter(ent => ent.isDirectory())
    .map(ent => ent.name)
  const deps = {}
  await Promise.all(
    pkgIds.map(async pkgId => {
      const { name } = await readPkg({ cwd: path.join(pkgsPath, pkgId) })
      deps[name] = {}
    })
  )
  await Promise.all(
    pkgIds.map(async pkgId => {
      const pkg = await readPkg({ cwd: path.join(pkgsPath, pkgId) })
      for (const source of [
        'dependencies',
        'devDependencies',
        'optionalDependencies'
      ]) {
        if (pkg[source] == null) {
          continue
        }
        const matchingDeps = Object.keys(pkg[source]).filter(name =>
          deps.hasOwnProperty(name)
        )
        for (const depName of matchingDeps) {
          _.set(deps, [pkg.name, depName, 'sources', source], null)
        }
      }
    })
  )
  await addRequireContexts(deps, pkgsPath, pkgIds)
  return deps
}

const markCycles = deps => {
  const queue = Object.keys(deps).map(dependent => [dependent, []])
  const seen = {}

  const onCycle = trail => {
    console.warn('Cycle detected: ' + trail.join(' -> '))
    for (let i = 1; i < trail.length; ++i) {
      _.set(deps, [trail[i - 1], trail[i], 'cycle'], true)
    }
    for (const pkgName of trail) {
      seen[pkgName] = null
    }
  }

  while (queue.length > 0) {
    const [pkgName, ancestors] = queue.shift()
    if (seen.hasOwnProperty(pkgName)) {
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
}

const writeDot = (deps, out) => {
  const nodes = {}
  const { length } = new LCP(Object.keys(deps)).lcp()
  const label = str => '"' + str.substr(length) + '"'
  const write = str => {
    out.write(str + '\n')
  }
  write('digraph g {')
  for (const style of GRAPH_STYLES) {
    write(`  ${style}`)
  }
  for (const [dependent, dependencyData] of Object.entries(deps)) {
    _.set(nodes, [dependent, '_'], null)
    for (const [dependency, { sources = {}, cycle }] of Object.entries(
      dependencyData
    )) {
      const styles = [...EDGE_STYLES_DEFAULT]
      if (cycle) {
        _.set(nodes, [dependent, 'cycle'], true)
        styles.push(...EDGE_STYLES_CYCLE)
      }
      if (!sources.hasOwnProperty('dependencies')) {
        styles.push(...EDGE_STYLES_NON_PRODUCTION)
      }
      write(`  ${label(dependent)} -> ${label(dependency)} [${styles}]`)
    }
  }
  for (const [pkgName, { cycle }] of Object.entries(nodes)) {
    const styles = [...NODE_STYLES_DEFAULT]
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

const main = async ([rootPath = '.', outputFile = 'dependencies.svg']) => {
  rootPath = path.resolve(process.cwd(), rootPath)
  outputFile = path.resolve(rootPath, outputFile)
  const deps = await buildDeps(rootPath)
  markCycles(deps)
  await generateImage(deps, outputFile)
}

main(process.argv.slice(2))
