import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createBackup, inspectBackup } from './backups.ts';
import { importBackupFile } from './backup-transfer.ts';
import { capturePlatformBackup } from './platform-backup-job.ts';
import { inspectPlatformExport } from './platform-backup-export.ts';

const { action, args } = workerData;
try {
  let value;
  if (action === 'inspect') value = inspectBackup(args.directory, args.id, args.maxSchema, args.owner);
  else if (action === 'import') value = importBackupFile(args.directory, args.file, args.maxSchema, args.owner);
  else if (action === 'inspect-platform') value = inspectPlatformExport(args.root, args.id);
  else if (action === 'create') {
    const raw = new DatabaseSync(args.source, { readOnly: true });
    try { value = createBackup(raw, args.source, args.directory, args.kind); }
    finally { raw.close(); }
  } else if (action === 'platform') value = capturePlatformBackup(args.root, args.directory, args.sources);
  else throw Error('Trabajo de respaldo no compatible.');
  parentPort.postMessage({ value });
} catch (error) {
  parentPort.postMessage({ error: error.message, status: error.status });
}
