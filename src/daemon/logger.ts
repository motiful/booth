import winston from 'winston'
import DailyRotateFile from 'winston-daily-rotate-file'

let _logger: winston.Logger | undefined

export function initLogger(logsDir: string): void {
  _logger = winston.createLogger({
    level: 'debug',
    format: winston.format.printf(({ level, message }) => {
      const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
      return `[${ts}] [${level.toUpperCase()}] ${message}`
    }),
    transports: [
      new DailyRotateFile({
        dirname: logsDir,
        filename: 'daemon-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxFiles: '7d',
      }),
    ],
  })
}

// Safe proxy — no-ops if initLogger() hasn't been called
export const logger = {
  debug: (msg: string) => _logger?.debug(msg),
  info: (msg: string) => _logger?.info(msg),
  warn: (msg: string) => _logger?.warn(msg),
  error: (msg: string) => _logger?.error(msg),
}
