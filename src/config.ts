import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { boothPath } from './constants.js'

const CONFIG_FILE = 'config.json'

export type BoothConfig = Record<string, unknown>

export function configPath(projectRoot: string): string {
  return boothPath(projectRoot, CONFIG_FILE)
}

export function readConfig(projectRoot: string): BoothConfig {
  const path = configPath(projectRoot)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

export function writeConfig(projectRoot: string, key: string, value: unknown): void {
  const config = readConfig(projectRoot)
  config[key] = value
  const path = configPath(projectRoot)
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
}
