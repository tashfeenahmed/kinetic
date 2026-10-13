/**
 * Sets a temporary password for an account, for when the only admin is locked out.
 * Run on the machine Kinetic runs on (it needs the data folder):
 *
 *   npm run reset-password -- you@company.com
 *
 * Prints the temporary password; Kinetic asks for a new one at the next sign-in.
 * Without an email it lists the accounts and their roles.
 */
import { loadConfig } from '../src/config.ts';
import { Db } from '../src/db/db.ts';
import { hashPassword, randomToken } from '../src/lib/crypto.ts';

const config = loadConfig({ workers: false });
const db = new Db(config.dbPath);
const email = process.argv[2]?.trim().toLowerCase();

if (!email) {
  const users = db.all(`SELECT u.email, group_concat(w.name || ' (' || m.role || ')', ', ') AS access FROM users u
    LEFT JOIN workspace_members m ON m.user_id = u.id LEFT JOIN workspaces w ON w.id = m.workspace_id GROUP BY u.id ORDER BY u.id`);
  console.log('Usage: npm run reset-password -- <email>\n\nAccounts:');
  for (const u of users) console.log(`  ${u.email}  ${u.access ?? '(no workspace)'}`);
  process.exit(users.length ? 0 : 1);
}

const user = db.get('SELECT id, email FROM users WHERE email = ?', [email]);
if (!user) { console.error(`No account with the email ${email}. Run without an email to list accounts.`); process.exit(1); }
const password = randomToken(9);
db.update('users', user.id, { password_hash: hashPassword(password), must_change_password: 1, updated_at: new Date().toISOString() });
db.run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
console.log(`Temporary password for ${user.email}: ${password}\nSign in with it; Kinetic then asks you to choose a new one.`);
