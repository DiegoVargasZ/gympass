// File transfers stream to disk; this is a disk/transfer allowance, not an allocation in RAM.
export const maxBackupTransferBytes = 4 * 1024 * 1024 * 1024;
export const backupTransferLimitLabel = '4 GiB';
export const maxBufferedBackupBytes = 256 * 1024 * 1024;
