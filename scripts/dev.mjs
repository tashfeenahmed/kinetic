// Runs the API server (with auto-restart) and the Vite dev server together.
import { spawn } from 'node:child_process';

const procs = [
  spawn('npm', ['run', 'dev', '-w', 'server'], { stdio: 'inherit', env: { ...process.env, PUBLIC_URL: process.env.PUBLIC_URL ?? 'http://localhost:5173' } }),
  spawn('npm', ['run', 'dev', '-w', 'web'], { stdio: 'inherit' }),
];
const stop = () => { for (const p of procs) p.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => { if (code) stop(); });
