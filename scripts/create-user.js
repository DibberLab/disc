#!/usr/bin/env node
'use strict';

/* scripts/create-user.js — create or reset a login account.
 *
 *   node scripts/create-user.js <username>
 *
 * Prompts for a password with the terminal echo suppressed. This is also
 * how you reset an existing user's password — it's an upsert on username.
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

async function main() {
  const args = process.argv.slice(2);
  const username = args[0];
  if (!username) {
    console.error('usage: node scripts/create-user.js <username> [--password <pw>]');
    process.exit(1);
  }

  const flagIndex = args.indexOf('--password');
  let password = flagIndex !== -1 ? args[flagIndex + 1] : process.env.DG_SEED_PASSWORD;

  if (!password) {
    const first = await readPasswordInteractive(`Password for ${username}: `);
    const second = await readPasswordInteractive('Confirm password: ');
    if (first !== second) {
      console.error('Passwords did not match.');
      process.exit(1);
    }
    password = first;
  }

  if (!password || password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  db.open(DB_FILE);
  const hash = auth.hashPassword(password);
  const d = db.handle();
  const existing = auth.findUserByUsername(username);

  if (existing) {
    d.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, existing.id);
    console.log(`Password updated for existing user "${username}".`);
  } else {
    d.prepare(
      'INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'
    ).run(username, hash, db.nowIso());
    console.log(`Created user "${username}" with default putter/driver maxes.`);
  }

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
