// Contrôles de publication : versions extension/app identiques, tag cohérent,
// entrée CHANGELOG présente. Aucune publication ici, uniquement des vérifications.
const fs = require('fs')
const path = require('path')

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function versionFromTag(tag) {
  const name = String(tag).replace(/^refs\/tags\//, '')
  if (!name.startsWith('v')) return null
  const version = name.slice(1)
  return SEMVER.test(version) ? version : null
}

function changelogHasEntry(changelog, version) {
  return changelog.split(/\r?\n/).some((line) => line.trim() === `## ${version}`)
}

function readText(root, rel, errors) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8')
  } catch (e) {
    errors.push(`${rel} illisible : ${e.message}`)
    return null
  }
}

function readVersion(root, rel, errors) {
  const text = readText(root, rel, errors)
  if (text === null) return null
  try {
    const version = JSON.parse(text).version
    if (typeof version === 'string' && SEMVER.test(version)) return version
    errors.push(`${rel} : version absente ou invalide`)
  } catch {
    errors.push(`${rel} : JSON invalide`)
  }
  return null
}

// Retourne la liste des erreurs (vide si tout est cohérent).
function checkRelease(root, tag) {
  const errors = []
  const ext = readVersion(root, 'extension/package.json', errors)
  const app = readVersion(root, 'app/package.json', errors)
  if (ext && app && ext !== app) {
    errors.push(`versions différentes : extension ${ext}, app ${app}`)
  }
  if (tag !== undefined && tag !== '') {
    const fromTag = versionFromTag(tag)
    if (fromTag === null) errors.push(`tag « ${tag} » invalide (attendu vX.Y.Z)`)
    else if (ext && fromTag !== ext) errors.push(`tag ${tag} différent de la version ${ext}`)
  }
  if (ext) {
    const changelog = readText(root, 'extension/CHANGELOG.md', errors)
    if (changelog !== null && !changelogHasEntry(changelog, ext)) {
      errors.push(`extension/CHANGELOG.md : aucune entrée « ## ${ext} »`)
    }
  }
  return errors
}

module.exports = { checkRelease, versionFromTag, changelogHasEntry }

if (require.main === module) {
  const root = path.resolve(__dirname, '..')
  const tag = process.argv[2] || process.env.RELEASE_TAG
  const errors = checkRelease(root, tag)
  if (errors.length) {
    for (const e of errors) console.error(`release-check : ${e}`)
    process.exit(1)
  }
  console.log('release-check : OK')
}
