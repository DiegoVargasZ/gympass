import { parentPort, workerData } from 'node:worker_threads';
import { readGymMemberCounts } from './gym-member-counts.ts';

parentPort.postMessage(readGymMemberCounts(workerData.root, workerData.ids));
