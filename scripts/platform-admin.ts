import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { pathToFileURL } from 'node:url';
import { PlatformStore } from '../server/platform-store.ts';

export async function privatePassword(): Promise<string> {
  if (!stdin.isTTY || !stdin.setRawMode) throw new Error('La entrada privada requiere una terminal.');
  stderr.write('Contraseña (6 a 200 caracteres): ');
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise<string>((resolveInput, reject) => {
    let secret = '';
    const finish = (error?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stderr.write('\n');
      if (error) reject(error);
      else resolveInput(secret);
    };
    const onData = (chunk: string | Buffer) => {
      for (const character of String(chunk)) {
        if (character === '\u0003' || character === '\u0004') {
          finish(new Error('Operación cancelada.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') secret = secret.slice(0, -1);
        else if (character >= ' ' && secret.length < 201) secret += character;
      }
    };
    stdin.on('data', onData);
  });
}

async function readInput(command: string): Promise<Record<string, unknown>> {
  if (!stdin.isTTY) {
    let text = '';
    for await (const chunk of stdin) {
      text += chunk;
      if (Buffer.byteLength(text) > 16 * 1024) throw new Error('La entrada JSON es demasiado grande.');
    }
    const input: unknown = JSON.parse(text);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Se requiere un objeto JSON.');
    return input as Record<string, unknown>;
  }
  const reader = createInterface({ input: stdin, output: stderr });
  const name = command === 'bootstrap' ? await reader.question('Nombre: ') : undefined;
  const email = await reader.question('Correo: ');
  reader.close();
  return { name, email, password: await privatePassword() };
}

async function main() {
  const args = process.argv.slice(2),
    command = args.shift();
  if (
    !['bootstrap', 'recover', 'recovery'].includes(command ?? '') ||
    args.length !== 2 ||
    args[0] !== '--data' ||
    !args[1]
  )
    throw new Error(
      'Uso: node scripts/platform-admin.ts bootstrap|recover --data <directorio>. Las credenciales se leen en la terminal o como JSON por stdin.',
    );
  const input = await readInput(command!);
  if (
    typeof input.email !== 'string' ||
    typeof input.password !== 'string' ||
    (command === 'bootstrap' && typeof input.name !== 'string')
  )
    throw new Error('Faltan campos de credenciales.');
  const store = new PlatformStore(resolve(args[1]));
  try {
    if (command === 'bootstrap') {
      await store.bootstrap({ name: input.name as string, email: input.email, password: input.password });
      stdout.write('Propietario de plataforma creado.\n');
    } else {
      await store.administrativeRecovery({ email: input.email, password: input.password });
      stdout.write('Contraseña actualizada y sesiones revocadas.\n');
    }
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    stderr.write(
      (error instanceof Error && error.name !== 'SyntaxError' ? error.message : 'Entrada JSON inválida.') + '\n',
    );
    process.exitCode = 1;
  });
}
