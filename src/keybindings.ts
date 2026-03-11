import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// The dedicated submit key for booth's protectedSendToCC.
// Bypasses vim mode and user Enter rebinding.
export const BOOTH_SUBMIT_TMUX_KEY = 'C-]'  // tmux send-keys syntax
const BOOTH_SUBMIT_CC_KEY = 'ctrl+]'         // CC keybindings.json syntax

interface KeybindingsConfig {
  $schema?: string
  $docs?: string
  bindings?: Array<{
    context: string
    bindings: Record<string, string | null>
  }>
}

const KEYBINDINGS_PATH = join(homedir(), '.claude', 'keybindings.json')

/**
 * Ensure ~/.claude/keybindings.json has ctrl+] → chat:submit in the Chat context.
 * Merges with existing bindings — never overwrites user config.
 */
export function ensureBoothSubmitKey(): void {
  let config: KeybindingsConfig = {}

  if (existsSync(KEYBINDINGS_PATH)) {
    try {
      config = JSON.parse(readFileSync(KEYBINDINGS_PATH, 'utf-8'))
    } catch {
      // Malformed JSON — don't touch it
      return
    }
  }

  if (!config.bindings) config.bindings = []

  let chatBlock = config.bindings.find(b => b.context === 'Chat')
  if (!chatBlock) {
    chatBlock = { context: 'Chat', bindings: {} }
    config.bindings.push(chatBlock)
  }

  // Already configured — no-op
  if (chatBlock.bindings[BOOTH_SUBMIT_CC_KEY] === 'chat:submit') return

  chatBlock.bindings[BOOTH_SUBMIT_CC_KEY] = 'chat:submit'

  if (!config.$schema) config.$schema = 'https://www.schemastore.org/claude-code-keybindings.json'
  if (!config.$docs) config.$docs = 'https://code.claude.com/docs/en/keybindings'

  writeFileSync(KEYBINDINGS_PATH, JSON.stringify(config, null, 2) + '\n')
}
