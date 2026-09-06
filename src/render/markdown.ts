/** Value text is data even inside a hover which enables command links. */
export function literalBlock(text: string): string {
  let width = 3;
  for (const run of text.matchAll(/`+/g)) {
    width = Math.max(width, run[0].length + 1);
  }
  const fence = '`'.repeat(width);
  return `${fence}\n${text}\n${fence}`;
}

export function literalCell(text: string, newline = ' '): string {
  return text.replace(/([\\`*_{}\[\]()#+.!|<>~])/g, '\\$1')
    .replace(/\r?\n/g, newline);
}
