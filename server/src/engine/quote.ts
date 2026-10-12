/** "On <date>, <name> <email> wrote:" block used when replying in a thread. */
export function quoteText(name: string, email: string, sentAt: string, body: string): string {
  const when = new Date(sentAt).toUTCString().replace(/:\d\d GMT$/, ' GMT');
  const quoted = body ? `\n${body.split('\n').map((l) => `> ${l}`).join('\n')}` : '';
  return `\n\nOn ${when}, ${name} <${email}> wrote:${quoted}`;
}
