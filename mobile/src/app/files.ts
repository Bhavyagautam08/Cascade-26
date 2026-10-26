// This app's folders, from Android (android/.../AppFilesModule.kt). No fixed paths.
import { NativeModules } from 'react-native';

type AppFilesT = {
  externalFilesDir: string | null;
  filesDir: string;
  cacheDir: string;
  fileSize(path: string): Promise<number>;
  deleteFile(path: string): Promise<boolean>;
  writeWav(path: string, chunks: string[], sampleRate: number): Promise<string>;
};

const native = NativeModules.AppFiles as (AppFilesT & { getConstants?: () => Partial<AppFilesT> }) | undefined;
if (!native) throw new Error('the AppFiles native module is missing from this build (MainApplication.kt)');
const consts = native.getConstants ? native.getConstants() : native;

export const files = {
  externalFilesDir: (consts.externalFilesDir ?? null) as string | null,
  cacheDir: consts.cacheDir,
  fileSize: (p: string) => native.fileSize(p),
  deleteFile: (p: string) => native.deleteFile(p),
  writeWav: (p: string, chunks: string[], sampleRate: number) => native.writeWav(p, chunks, sampleRate),
};
