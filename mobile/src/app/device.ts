// The Device native module (android/.../AppFilesModule.kt): the always-on mic's foreground service, and
// this phone's own local addresses.
import { NativeEventEmitter, NativeModules } from 'react-native';

export type LocalAddress = { address: string; prefix: number; interface: string };
export type LastExit = { reason: string; description: string; timestamp: number; pssKb: number } | null;

type DeviceT = {
  lastExit(): Promise<LastExit>;
  download(id: string, url: string, path: string, sha256: string, size: number): Promise<string>;
  cancelDownload(id: string): void;
  partialSize(path: string): Promise<number>;
  startListening(): Promise<boolean>;
  stopListening(): Promise<boolean>;
  localAddresses(): Promise<LocalAddress[]>;
};

const native = NativeModules.Device as DeviceT | undefined;
if (!native) throw new Error('the Device native module is missing from this build (MainApplication.kt)');

export const device: DeviceT = native;

export type DownloadEvent = { id: string; state: 'downloading' | 'verifying' | 'done' | 'paused' | 'error'; bytes: number; total: number };
const events = new NativeEventEmitter(NativeModules.Device);
export function onDownload(fn: (e: DownloadEvent) => void): () => void {
  const sub = events.addListener('modelDownload', fn as (e: unknown) => void);
  return () => sub.remove();
}
