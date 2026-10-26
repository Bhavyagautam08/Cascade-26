// The Device native module (android/.../AppFilesModule.kt): the always-on mic's foreground service, and
// this phone's own local addresses.
import { NativeModules } from 'react-native';

export type LocalAddress = { address: string; prefix: number; interface: string };
export type LastExit = { reason: string; description: string; timestamp: number; pssKb: number } | null;

type DeviceT = {
  lastExit(): Promise<LastExit>;
  startListening(): Promise<boolean>;
  stopListening(): Promise<boolean>;
  localAddresses(): Promise<LocalAddress[]>;
};

const native = NativeModules.Device as DeviceT | undefined;
if (!native) throw new Error('the Device native module is missing from this build (MainApplication.kt)');

export const device: DeviceT = native;
