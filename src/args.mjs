import { usage } from './errors.mjs'

// Minimal argv parser: --flag value, --flag=value, boolean flags, and positionals.
export function parseArgs(argv, { booleans = [] } = {}) {
  const positionals = []
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--') && a.length > 2) {
      let [key, value] = a.slice(2).split(/=(.*)/s)
      if (key.startsWith('no-') && booleans.includes(key.slice(3))) {
        options[key.slice(3)] = false
        continue
      }
      if (booleans.includes(key)) {
        options[key] = value === undefined ? true : value !== 'false'
        continue
      }
      if (value === undefined) {
        if (i + 1 >= argv.length) throw usage(`--${key} needs a value`)
        value = argv[++i]
      }
      options[key] = value
    } else {
      positionals.push(a)
    }
  }
  return { positionals, options }
}
