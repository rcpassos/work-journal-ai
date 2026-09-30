/**
 * Literal supporting text nested under a Task's Markdown bullet. A fence longer
 * than every backtick run in the text keeps even pasted fences inside the block.
 * Prefixing each line by the list indentation preserves the original text,
 * including blank lines and indentation, without creating additional records.
 */
export function renderTaskDetails(details: string | null): string {
  if (details === null) return ''
  const runs = details.match(/`+/g) ?? []
  const fence = '`'.repeat(runs.reduce((length, run) => Math.max(length, run.length + 1), 3))
  return '\n' + [fence, ...details.split('\n'), fence].map(line => `  ${line}`).join('\n')
}
