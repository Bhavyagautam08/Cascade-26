declare module '@fugood/react-native-audio-pcm-stream' {
  type AudioStreamOptions = {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    audioSource?: number;
    wavFile: string;
    bufferSize?: number;
  };

  const LiveAudioStream: {
    init(options: AudioStreamOptions): Promise<void>;
    start(): void;
    stop(): Promise<void>;
    on(event: 'data', callback: (data: string) => void): void;
  };

  export default LiveAudioStream;
}
