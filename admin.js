import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import path from 'node:path';
import { initializeOwner, resetOwnerPassword, validatePassword } from './lib.js';

async function prompt(label, hidden = false) {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Run this command in an interactive terminal. Passwords are never accepted through command arguments.');
  stdout.write(label);
  if (!hidden) {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    try { return await new Promise(resolve => rl.question('', resolve)); }
    finally { rl.close(); }
  }
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = stdin.isRaw;
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true); stdin.resume();
    const finish = error => {
      stdin.off('keypress', onKey); stdin.setRawMode(wasRaw ?? false); stdin.pause(); stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onKey = (character, key = {}) => {
      if (key.ctrl && key.name === 'c') { finish(new Error('Cancelled.')); return; }
      if (key.name === 'return' || key.name === 'enter') { finish(); return; }
      if (key.name === 'backspace') { value = Array.from(value).slice(0, -1).join(''); return; }
      if (key.ctrl && key.name === 'u') { value = ''; return; }
      if (typeof character === 'string' && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/.test(character)) value += character;
    };
    stdin.on('keypress', onKey);
  });
}

try {
  const command = process.argv[2];
  if (!['init', 'reset-password'].includes(command) || process.argv.length !== 3) {
    throw new Error('Usage: node admin.js init | reset-password');
  }
  const username = command === 'init' ? (await prompt('Owner username: ')).trim() : null;
  const password = await prompt('Password (15–128 characters; hidden): ', true);
  validatePassword(password);
  const confirmation = await prompt('Repeat password (hidden): ', true);
  if (password !== confirmation) throw new Error('Passwords do not match. No changes were made.');
  const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
  if (command === 'init') await initializeOwner(dataDir, username, password);
  else await resetOwnerPassword(dataDir, password);
  stdout.write(command === 'init' ? 'Owner created. You can now sign in to Harbor.\n' : 'Password reset. All existing sessions have been signed out.\n');
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
