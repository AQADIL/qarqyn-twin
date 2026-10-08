import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { verifyDatabase, snapshotDatabase } from '../server/operations.js';

const [command, ...args] = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  if (!['--source', '--destination'].includes(args[index]) || !args[index + 1])
    throw new Error('Use backup|verify|restore --source PATH [--destination NEW_PATH].');
  options[args[index].slice(2)] = resolve(args[index + 1]);
}
if (!['backup', 'verify', 'restore'].includes(command) || !options.source)
  throw new Error('Use backup|verify|restore --source PATH [--destination NEW_PATH].');
verifyDatabase(options.source);
if (command === 'verify')
  console.log(JSON.stringify({ ok: true, ...verifyDatabase(options.source) }));
else {
  if (!options.destination)
    throw new Error('A new --destination path is required. Existing files are never overwritten.');
  const source = new DatabaseSync(options.source, { readOnly: true });
  try {
    const result = snapshotDatabase(source, options.destination);
    console.log(
      JSON.stringify({
        ok: true,
        ...result,
        instruction:
          command === 'restore'
            ? 'Stop the server, set DATABASE_PATH to the new destination, then start the server. Owner credentials are taken from its environment.'
            : 'Store the backup outside the application host.'
      })
    );
  } finally {
    source.close();
  }
}
