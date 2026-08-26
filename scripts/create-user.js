#!/usr/bin/env node
'use strict';

/* scripts/create-user.js — create, update, or rename a login account.
 *
 *   node scripts/create-user.js <username> [--display-name <name>] [--rename-to <newUsername>]
 *
 * Prompts for a password with the terminal echo suppressed. This is also
 * how you reset an existing user's password, change their display name (the
 * cosmetic name shown in the app — see 003_display_name.sql), or rename
 * their login username — it's an upsert keyed on the current username, with
 * --rename-to as the one exception (that changes which username it's keyed
 * on, in place).
 *
 * Never pass a password as a bare argument: it would sit in shell history
 * and be visible to anyone on the box via `ps`. The one exception is a
 * scripted first deploy with no interactive terminal, where --password (or
 * the DG_SEED_PASSWORD env var) is a documented, less-preferred escape
 * hatch — prefer the interactive prompt whenever a human is at the keyboard.
 */

const path = require('path');
const readline = require('readline');

const db = require('../server/db');
const auth = require('../server/auth');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'disc.sqlite');

function readPasswordInteractive(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const original = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (str) => {
      // Echo the prompt itself, but not the characters typed after it.
      original(str.startsWith(prompt) ? str : '');
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const username = args[0];
  if (!username) {
    console.error('usage: node scripts/create-user.js <username> [--password <pw>] [--display-name <name>] [--rename-to <newUsername>]');
    process.exit(1);
  }

  const renameTo = flagValue(args, '--rename-to');
  const displayName = flagValue(args, '--display-name');
  let password = flagValue(args, '--password') || process.env.DG_SEED_PASSWORD;

  db.open(DB_FILE);
  const existing = auth.findUserByUsername(username);

  if (renameTo && !existing) {
    console.error(`No account named "${username}" to rename.`);
    process.exit(1);
  }
  if (renameTo && auth.findUserByUsername(renameTo)) {
    console.error(`"${renameTo}" is already taken.`);
    process.exit(1);
  }

  /* Password is required to CREATE an account, optional when only updating
     display name / renaming an existing one — no need to force a password
     prompt just to fix a typo in someone's name. */
  if (!password && (!existing || !renameTo && !displayName)) {
    const first = await readPasswordInteractive(`Password for ${username}: `);
    const second = await readPasswordInteractive('Confirm password: ');
    if (first !== second) {
      console.error('Passwords did not match.');
      process.exit(1);
    }
    password = first;
  }

  if (password && password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const d = db.handle();
  const finalUsername = renameTo || username;

  if (existing) {
    if (renameTo) d.prepare('UPDATE users SET username = ? WHERE id = ?').run(renameTo, existing.id);
    if (displayName !== undefined) {
      d.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName || null, existing.id);
    }
    if (password) d.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password), existing.id);
    console.log(`Updated "${username}"${renameTo ? ` -> "${renameTo}"` : ''}.`);
  } else {
    d.prepare(
      'INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)'
    ).run(finalUsername, displayName || null, auth.hashPassword(password), db.nowIso());
    console.log(`Created user "${finalUsername}" with default putter/driver maxes.`);
  }

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
