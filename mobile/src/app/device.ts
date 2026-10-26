// The Device native module (android/.../AppFilesModule.kt): the always-on mic's foreground service, and
// this phone's own local addresses.
import { NativeModules } from 'react-native';

export type LocalAddress = { address: string; prefix: number; interface: string };

type DeviceT = {
  startListening(): Promise<boolean>;
  stopListening(): Promise<boolean>;
  localAddresses(): Promise<LocalAddress[]>;
};

const native = NativeModules.Device as DeviceT | undefined;
if (!native) throw new Error('the Device native module is missing from this build (MainApplication.kt)');

export const device: DeviceT = native;
