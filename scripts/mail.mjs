// Starts/stops a local GreenMail SMTP+IMAP server for development and the mail tests.
// SMTP on 3025, IMAP on 3143 (plain). Any address gets a mailbox on first use; any password works.
import { execSync } from 'node:child_process';

const NAME = 'kinetic-greenmail';
const IMAGE = 'greenmail/standalone:2.1.3';
const cmd = process.argv[2] ?? 'up';
const sh = (c) => execSync(c, { stdio: 'pipe' }).toString().trim();

if (cmd === 'up') {
  const running = sh(`docker ps -q -f name=^${NAME}$`);
  if (running) {
    console.log(`${NAME} already running`);
  } else {
    sh(`docker rm -f ${NAME} 2>/dev/null || true`);
    const opts = '-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled';
    sh(`docker run -d --name ${NAME} -p 3025:3025 -p 3143:3143 -e GREENMAIL_OPTS="${opts}" ${IMAGE}`);
    console.log(`${NAME} started: SMTP localhost:3025, IMAP localhost:3143`);
  }
} else if (cmd === 'down') {
  sh(`docker rm -f ${NAME} 2>/dev/null || true`);
  console.log(`${NAME} stopped`);
} else {
  console.error('usage: node scripts/mail.mjs up|down');
  process.exit(1);
}
