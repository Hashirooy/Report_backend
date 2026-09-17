import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, env, exit } from 'node:process';

import { PrismaClient } from '@prisma/client';

import { hashPassword } from '../common/auth/password.js';

/**
 * Creates the first administrator, because there is no public sign-up and the
 * user API itself requires an administrator to call it.
 *
 *   npm run create:admin -- --email me@example.com --name "Gleb"
 *
 * The password comes from ADMIN_PASSWORD or is asked for interactively, never
 * from an argument: arguments end up in shell history and in the process list.
 */
async function main(): Promise<void> {
  const email = arg('--email')?.trim().toLowerCase();
  const name = arg('--name')?.trim() || email;

  if (!email) {
    throw new Error('usage: npm run create:admin -- --email <address> [--name <name>]');
  }

  const password = env.ADMIN_PASSWORD ?? (await ask('password (min 12 chars): '));
  if (password.length < 12) throw new Error('password must be at least 12 characters');

  const prisma = new PrismaClient();
  try {
    if (await prisma.user.findUnique({ where: { email } })) {
      throw new Error(`user "${email}" already exists; change it through the API instead`);
    }

    const user = await prisma.user.create({
      data: {
        email,
        name: name!,
        role: 'admin',
        passwordHash: await hashPassword(password),
      },
    });
    stdout.write(`created administrator ${user.id} <${user.email}>\n`);
  } finally {
    await prisma.$disconnect();
  }
}

const arg = (flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};

/** Echo stays on: this runs in a terminal the operator already controls. */
async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

main().catch((error: Error) => {
  stdout.write(`${error.message}\n`);
  exit(1);
});
