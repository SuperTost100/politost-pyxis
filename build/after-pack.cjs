const { execSync } = require('node:child_process')
const { rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

// macOS 27 leaves Finder metadata on the unpacked app. codesign calls that
// detritus and refuses the bundle in place. A copy made with ditto --norsrc
// in /tmp signs cleanly, and that signed bundle is what we put back.
module.exports = async function afterPack(context) {
  const name = `${context.packager.appInfo.productFilename}.app`
  const app = join(context.appOutDir, name)
  const clean = join(tmpdir(), `pyxis-sign-${process.pid}.app`)
  rmSync(clean, { recursive: true, force: true })
  execSync(`ditto --norsrc ${JSON.stringify(app)} ${JSON.stringify(clean)}`)
  execSync(`codesign --sign - --force --timestamp=none ${JSON.stringify(clean)}`, { stdio: 'inherit' })
  rmSync(app, { recursive: true, force: true })
  execSync(`ditto ${JSON.stringify(clean)} ${JSON.stringify(app)}`)
  rmSync(clean, { recursive: true, force: true })
}
