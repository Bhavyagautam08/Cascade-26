declare module 'whisper.rn' {
  export type WhisperTranscription = {
    result: string;
    isAborted: boolean;
  };

  export type WhisperContext = {
    transcribe(path: string, options?: { language?: string; prompt?: string; maxThreads?: number }): {
      promise: Promise<WhisperTranscription>;
    };
    release(): Promise<void>;
  };

  export type WhisperVadContext = {
    detectSpeech(path: string, options?: {
      threshold?: number;
      minSpeechDurationMs?: number;
      minSilenceDurationMs?: number;
      maxSpeechDurationS?: number;
      speechPadMs?: number;
    }): Promise<{ t0: number; t1: number }[]>;
    release(): Promise<void>;
  };

  export function initWhisper(options: { filePath: string; useGpu?: boolean }): Promise<WhisperContext>;
  export function initWhisperVad(options: { filePath: string; useGpu?: boolean; nThreads?: number }): Promise<WhisperVadContext>;
}
