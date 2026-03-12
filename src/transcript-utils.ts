export function extractTextContent(message: { content?: string | Array<{ type: string; text?: string }> }): string {
  if (!message?.content) return ''
  // User messages: content is a plain string
  if (typeof message.content === 'string') return message.content
  // Assistant messages: content is an array of blocks
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter(block => block.type === 'text' && block.text)
    .map(block => block.text!)
    .join('\n')
}
