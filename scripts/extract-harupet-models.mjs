import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootReal = realpathSync.native(root)
const sourceDir = resolve(root, '.tmp', 'harupet-source')
const modelsDir = resolve(root, 'public', 'models')

const launcher = {
  file: 'harupet.user.js',
  url: 'https://cdn.harucdn.com/harupet.user.js',
  sha256: '59aef309e8f214908cc379878b7a9f7104c67918c1054f36a46166a62513f15f',
}

const sources = [
  {
    id: 'haruhi',
    file: 'model_haruhi.js',
    url: 'https://cdn.harucdn.com/model_haruhi.js',
    sha256: 'adeca5fdce41e31b3c2a1333cb217365c0fc54b8fba5b81c6710bf1e6628f53d',
    base64Length: 566100,
    manifestFile: 'haruhi.model3.json',
    sizes: [458, 127424, 261600, 2986, 6307, 1710, 1674, 2390, 1526, 6599, 2776, 2461, 2749, 2032, 650, 636, 298, 298],
  },
  {
    id: 'mikuru',
    file: 'model_mikuru.js',
    url: 'https://cdn.harucdn.com/model_mikuru.js',
    sha256: '61f29a9b67c51269168e34d5d8f7808c7c86ee5cfe89e70dfc2ca5a71ef704cf',
    base64Length: 1470492,
    manifestFile: 'mikuru.model3.json',
    sizes: [458, 145600, 923326, 7090, 7515, 1054, 1339, 2799, 1496, 1456, 2030, 2084, 1899, 2067, 297, 297, 266, 266, 262, 262, 335, 335, 335],
  },
  {
    id: 'yuki',
    file: 'model_yuki.js',
    url: 'https://cdn.harucdn.com/model_yuki.js',
    sha256: 'db6551ea69d889cf1c7d16fdd3372536126511e6bd739a7d34b28fbec197af2a',
    base64Length: 507540,
    manifestFile: 'yuki.model3.json',
    sizes: [458, 83584, 284344, 1470, 3400, 1239, 2402, 1244, 929, 979, 302, 302],
  },
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function isWithin(base, candidate) {
  const pathFromBase = relative(base, candidate)
  return pathFromBase === '' || (!pathFromBase.startsWith(`..${sep}`) && pathFromBase !== '..' && !isAbsolute(pathFromBase))
}

function assertInsideRoot(target) {
  assert(isWithin(root, target), `Path escapes project root: ${target}`)
}

function assertSafeExistingChain(target) {
  assertInsideRoot(target)
  assert(!lstatSync(root).isSymbolicLink(), 'Project root must not be a link')
  assert(isWithin(rootReal, realpathSync.native(root)), 'Project root resolves outside itself')

  const pathFromRoot = relative(root, target)
  if (!pathFromRoot) return

  let cursor = root
  for (const part of pathFromRoot.split(sep)) {
    cursor = join(cursor, part)
    if (!existsSync(cursor)) break
    assert(!lstatSync(cursor).isSymbolicLink(), `Linked path is not allowed: ${cursor}`)
    assert(isWithin(rootReal, realpathSync.native(cursor)), `Resolved path escapes project root: ${cursor}`)
  }
}

function ensureSafeDirectory(target) {
  assertSafeExistingChain(target)
  mkdirSync(target, { recursive: true })
  assertSafeExistingChain(target)
}

function safeWrite(target, buffer, checkOnly) {
  assertInsideRoot(target)
  if (checkOnly) {
    assertSafeExistingChain(target)
    assert(existsSync(target), `Missing generated file: ${target}`)
    assert(readFileSync(target).equals(buffer), `Generated file differs: ${target}`)
    return
  }

  ensureSafeDirectory(dirname(target))
  if (existsSync(target)) {
    assertSafeExistingChain(target)
    assert(lstatSync(target).isFile(), `Output is not a file: ${target}`)
  }
  writeFileSync(target, buffer)
}

function readVerifiedSource(file, expectedHash) {
  const target = resolve(sourceDir, file)
  assertInsideRoot(target)
  assertSafeExistingChain(target)
  assert(existsSync(target), `Missing source file: ${target}`)
  assert(lstatSync(target).isFile(), `Source is not a file: ${target}`)
  const buffer = readFileSync(target)
  assert(sha256(buffer) === expectedHash, `SHA-256 mismatch for ${file}`)
  return buffer
}

function readJsonObject(source, start) {
  assert(source[start] === '{', 'Manifest must begin with an object')
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const json = source.slice(start, index + 1)
        return { value: JSON.parse(json), end: index + 1 }
      }
    }
  }
  throw new Error('Manifest object is not balanced')
}

function extractPayload(source, config) {
  const payloadMatches = [...source.matchAll(/'([A-Za-z0-9+/]{100000,}={0,2})'/g)]
  assert(payloadMatches.length === 1, `Expected one model payload in ${config.file}`)
  const payloadMatch = payloadMatches[0]
  const base64 = payloadMatch[1]
  assert(base64.length === config.base64Length, `Base64 length mismatch for ${config.file}`)

  const sizeLiteral = JSON.stringify(config.sizes)
  const sizeIndex = source.indexOf(sizeLiteral, payloadMatch.index + payloadMatch[0].length)
  assert(sizeIndex >= 0 && sizeIndex - (payloadMatch.index + payloadMatch[0].length) < 512, `Size table is not adjacent in ${config.file}`)

  const aliasLiteral = "['m'],"
  const aliasIndex = source.indexOf(aliasLiteral, sizeIndex + sizeLiteral.length)
  assert(aliasIndex >= 0 && aliasIndex - (sizeIndex + sizeLiteral.length) < 32, `Manifest alias is not adjacent in ${config.file}`)

  const manifestStart = aliasIndex + aliasLiteral.length
  const manifestResult = readJsonObject(source, manifestStart)
  const expectedTail = `,0,/[^\"]+\\.(json|moc3|png|webp)/g,'font/otf'`
  assert(source.startsWith(expectedTail, manifestResult.end), `Asset matcher changed in ${config.file}`)

  const decoded = Buffer.from(base64, 'base64')
  assert(decoded.toString('base64') === base64, `Base64 is not canonical in ${config.file}`)
  const expectedBytes = config.sizes.reduce((sum, size) => sum + size, 0)
  assert(decoded.length === expectedBytes, `Decoded length mismatch for ${config.file}`)

  return { decoded, manifest: manifestResult.value }
}

function validateRelativeAssetPath(assetPath) {
  assert(typeof assetPath === 'string' && assetPath.length > 0, 'Asset path must be a non-empty string')
  assert(assetPath === assetPath.replaceAll('\\', '/'), `Backslashes are not allowed in asset path: ${assetPath}`)
  assert(!assetPath.startsWith('/') && !/^[A-Za-z]:/.test(assetPath), `Absolute asset path is not allowed: ${assetPath}`)
  assert(assetPath.split('/').every(part => part && part !== '.' && part !== '..'), `Unsafe asset path: ${assetPath}`)
  assert(/^[A-Za-z0-9._/-]+$/.test(assetPath), `Unexpected asset path characters: ${assetPath}`)
  assert(!/(?:cubism|core)/i.test(assetPath), `Core-like asset is not allowed: ${assetPath}`)
}

function readWebpDimensions(buffer) {
  assert(buffer.length >= 30, 'WebP file is too short')
  assert(buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP', 'Invalid WebP signature')
  const chunk = buffer.toString('ascii', 12, 16)

  if (chunk === 'VP8X') {
    return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 }
  }
  if (chunk === 'VP8L') {
    assert(buffer[20] === 0x2f, 'Invalid VP8L signature')
    const bits = buffer.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8 ') {
    for (let index = 20; index <= Math.min(buffer.length - 7, 64); index += 1) {
      if (buffer[index] === 0x9d && buffer[index + 1] === 0x01 && buffer[index + 2] === 0x2a) {
        return {
          width: buffer.readUInt16LE(index + 3) & 0x3fff,
          height: buffer.readUInt16LE(index + 5) & 0x3fff,
        }
      }
    }
  }
  throw new Error(`Unsupported WebP chunk: ${chunk}`)
}

function validateAsset(assetPath, buffer) {
  if (assetPath.endsWith('.json')) {
    JSON.parse(buffer.toString('utf8'))
    return null
  }
  if (assetPath.endsWith('.moc3')) {
    assert(buffer.toString('ascii', 0, 4) === 'MOC3', `Invalid MOC3 signature: ${assetPath}`)
    return null
  }
  if (assetPath.endsWith('.webp')) return readWebpDimensions(buffer)
  if (assetPath.endsWith('.png')) {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    assert(buffer.subarray(0, 8).equals(signature), `Invalid PNG signature: ${assetPath}`)
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  throw new Error(`Unsupported asset type: ${assetPath}`)
}

function assetTarget(modelId, assetPath) {
  validateRelativeAssetPath(assetPath)
  const target = resolve(modelsDir, modelId, ...assetPath.split('/'))
  assertInsideRoot(target)
  return target
}

function prepareModel(config) {
  const sourceBuffer = readVerifiedSource(config.file, config.sha256)
  const sourceText = new TextDecoder('utf-8', { fatal: true }).decode(sourceBuffer)
  const { decoded, manifest } = extractPayload(sourceText, config)
  assert(manifest?.Version === 3 && manifest.FileReferences, `Invalid model manifest in ${config.file}`)

  const references = JSON.stringify(manifest).match(/[^\"]+\.(?:json|moc3|png|webp)/g) ?? []
  assert(references.length + 1 === config.sizes.length, `Reference count mismatch for ${config.file}`)
  assert(new Set(references).size === references.length, `Duplicate asset reference in ${config.file}`)
  references.forEach(validateRelativeAssetPath)

  const slices = []
  let offset = 0
  for (const size of config.sizes) {
    slices.push(decoded.subarray(offset, offset + size))
    offset += size
  }
  assert(offset === decoded.length, `Slice coverage mismatch for ${config.file}`)

  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const files = [{ path: config.manifestFile, buffer: manifestBuffer, texture: null }]
  for (let index = 0; index < references.length; index += 1) {
    const assetPath = references[index]
    const buffer = slices[index + 1]
    files.push({ path: assetPath, buffer, texture: validateAsset(assetPath, buffer) })
  }

  return {
    config,
    sourceBytes: sourceBuffer.length,
    decodedBytes: decoded.length,
    files,
  }
}

const argumentsList = process.argv.slice(2)
assert(argumentsList.every(argument => argument === '--check'), `Unknown argument: ${argumentsList.join(' ')}`)
assert(argumentsList.length <= 1, 'Duplicate --check argument')
const checkOnly = argumentsList.includes('--check')

assertSafeExistingChain(sourceDir)
assertSafeExistingChain(modelsDir)
const launcherBuffer = readVerifiedSource(launcher.file, launcher.sha256)
const models = sources.map(prepareModel)

const provenance = {
  schemaVersion: 1,
  generatedBy: 'scripts/extract-harupet-models.mjs',
  ownershipBasis: 'Organization-owned character models, as stated by the project owner.',
  exclusion: 'Executable bundles and their embedded Cubism Core/runtime are not included.',
  launcher: {
    url: launcher.url,
    file: `.tmp/harupet-source/${launcher.file}`,
    bytes: launcherBuffer.length,
    sha256: launcher.sha256,
  },
  models: models.map(model => ({
    character: model.config.id,
    url: model.config.url,
    bundleFile: `.tmp/harupet-source/${model.config.file}`,
    bundleBytes: model.sourceBytes,
    bundleSha256: model.config.sha256,
    decodedBytes: model.decodedBytes,
    excludedPlaceholderBytes: model.config.sizes[0],
    files: model.files.map(file => ({
      path: `${model.config.id}/${file.path}`,
      bytes: file.buffer.length,
      sha256: sha256(file.buffer),
      ...(file.texture ? { texture: file.texture } : {}),
    })),
  })),
}

for (const model of models) {
  for (const file of model.files) {
    safeWrite(assetTarget(model.config.id, file.path), file.buffer, checkOnly)
  }
}

const provenanceBuffer = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, 'utf8')
safeWrite(resolve(modelsDir, 'SOURCES.json'), provenanceBuffer, checkOnly)

for (const model of models) {
  const textures = model.files
    .filter(file => file.texture)
    .map(file => `${file.path}=${file.texture.width}x${file.texture.height}`)
    .join(', ')
  console.log(`${checkOnly ? 'Verified' : 'Extracted'} ${model.config.id}: ${model.files.length} files, ${model.decodedBytes} decoded bytes, ${textures}`)
}
