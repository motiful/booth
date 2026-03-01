import { Daemon } from './index.js'

const projectRoot = process.argv[2]
if (!projectRoot) {
  console.error('Usage: daemon/run.ts <projectRoot>')
  process.exit(1)
}

const daemon = new Daemon({ projectRoot })
await daemon.start()
