import { findProjectRoot } from '../../constants.js'
import { readConfig, writeConfig } from '../../config.js'

const USAGE = `Usage:
  booth config set <key> <value>   Set a config value
  booth config get <key>           Get a config value
  booth config list                Show all config`

export async function configCommand(args: string[]): Promise<void> {
  const sub = args[0]

  if (!sub || sub === '--help' || sub === '-h') {
    console.log(USAGE)
    process.exit(0)
  }

  const projectRoot = findProjectRoot()

  switch (sub) {
    case 'set': {
      const key = args[1]
      const value = args[2]
      if (!key || value === undefined) {
        console.error('Usage: booth config set <key> <value>')
        process.exit(1)
      }
      writeConfig(projectRoot, key, value)
      console.log(`[booth] config: ${key} = ${value}`)
      break
    }
    case 'get': {
      const key = args[1]
      if (!key) {
        console.error('Usage: booth config get <key>')
        process.exit(1)
      }
      const config = readConfig(projectRoot)
      const val = config[key]
      if (val === undefined) {
        console.log(`[booth] config: ${key} is not set`)
      } else {
        console.log(val)
      }
      break
    }
    case 'list': {
      const config = readConfig(projectRoot)
      const entries = Object.entries(config)
      if (entries.length === 0) {
        console.log('[booth] config: empty')
      } else {
        for (const [k, v] of entries) {
          console.log(`${k} = ${v}`)
        }
      }
      break
    }
    default:
      console.error(`Unknown config subcommand: ${sub}`)
      console.log(USAGE)
      process.exit(1)
  }
}
