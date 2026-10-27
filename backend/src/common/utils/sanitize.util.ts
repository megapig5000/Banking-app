export function sanitizeHtml(input: string): string {
  if (!input) return input;
  return input.replace(/[<&>]/g, (char) => {
    const map: Record<string, string> = {
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
    };
    return map[char] || char;
  });
}
