import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import path from 'node:path';
import { initializeOwner, resetOwnerPassword, validatePassword } from './lib.js';
import { checkInstallation } from './preflight.js';

async function prompt(label, hidden = false) {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Run this command in an interactive terminal. Passwords are never accepted through command arguments.');
  if (!hidden) {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, answer) => {
        if (settled) return;
        settled = true;
        rl.off('SIGINT', onCancel); rl.off('close', onClose); stdin.off('error', onError);
        rl.close();
        if (error) { stdout.write('\n'); reject(error); }
        else resolve(answer);
      };
      const onCancel = () => finish(new Error('Cancelled.'));
      const onClose = () => finish(new Error('Input ended. No changes were made.'));
      const onError = error => finish(error);
      rl.once('SIGINT', onCancel); rl.once('close', onClose); stdin.once('error', onError);
      // Readline redraws its own prompt; a label written before question('') is erased.
      try { rl.question(label, answer => finish(null, answer)); }
      catch (error) { finish(error); }
    });
  }
  return new Promise((resolve, reject) => {
    let value = '';
    let settled = false;
    const wasRaw = stdin.isRaw;
    const finish = error => {
      if (settled) return;
      settled = true;
      stdin.off('keypress', onKey); stdin.off('end', onEnd); stdin.off('close', onEnd); stdin.off('error', onError);
      try { stdin.setRawMode(wasRaw ?? false); }
      catch (restoreError) { error ??= restoreError; }
      stdin.pause(); stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onEnd = () => finish(new Error('Input ended. No changes were made.'));
    const onError = error => finish(error);
    const onKey = (character, key = {}) => {
      if (key.ctrl && key.name === 'c') { finish(new Error('Cancelled.')); return; }
      if (key.ctrl && key.name === 'd') { onEnd(); return; }
      if (key.name === 'return' || key.name === 'enter') { finish(); return; }
      if (key.name === 'backspace') { value = Array.from(value).slice(0, -1).join(''); return; }
      if (key.ctrl && key.name === 'u') { value = ''; return; }
      if (typeof character === 'string' && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/.test(character)) value += character;
    };
    stdin.on('keypress', onKey); stdin.once('end', onEnd); stdin.once('close', onEnd); stdin.once('error', onError);
    try {
      readline.emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdout.write(label);
      stdin.resume();
    } catch (error) { finish(error); }
  });
}

try {
  const command = process.argv[2];
  if (!['check', 'init', 'reset-password'].includes(command) || process.argv.length !== 3) {
    throw new Error('Usage: node admin.js check | init | reset-password');
  }
  if (command === 'check') {
    const checked = checkInstallation();
    stdout.write(`Installation check passed.\nData directory: ${JSON.stringify(checked.dataDir)}\nStorage root: ${JSON.stringify(checked.storageRoot)}\nPublic address: ${checked.appOrigin}\n`);
  } else {
    // Recovery remains available even when origin or file storage needs repair.
    if (command === 'init') checkInstallation();
    const username = command === 'init' ? (await prompt('Owner username: ')).trim() : null;
    const password = await prompt('Password (15–128 characters; hidden): ', true);
    validatePassword(password);
    const confirmation = await prompt('Repeat password (hidden): ', true);
    if (password !== confirmation) throw new Error('Passwords do not match. No changes were made.');
    const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
    if (command === 'init') {
      await initializeOwner(dataDir, username, password);
      stdout.write(`Owner created. Sign in as ${JSON.stringify(username)}.\n`);
    } else {
      const owner = await resetOwnerPassword(dataDir, password);
      stdout.write(`Password reset for ${JSON.stringify(owner.username)}. All existing sessions have been signed out.\n`);
    }
  }
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
