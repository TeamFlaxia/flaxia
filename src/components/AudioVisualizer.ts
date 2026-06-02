export class AudioVisualizer {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private canvas: HTMLCanvasElement;
  private audioElement: HTMLAudioElement;
  private animationId: number | null = null;
  private isPlaying: boolean = false;

  constructor(audioElement: HTMLAudioElement, canvasElement: HTMLCanvasElement) {
    this.audioElement = audioElement;
    this.canvas = canvasElement;
    this.setupAudioContext();
    this.setupEventListeners();
  }

  private setupAudioContext(): void {
    try {
      // Create audio context
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.analyser = this.audioContext.createAnalyser();

      // Configure analyser
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;

      // Connect audio element to analyser
      this.source = this.audioContext.createMediaElementSource(this.audioElement);
      this.source.connect(this.analyser);
      this.analyser.connect(this.audioContext.destination);
    } catch (error) {
      console.warn('Audio Visualizer: Web Audio API not supported', error);
    }
  }

  private setupEventListeners(): void {
    // Listen for audio play/pause events
    this.audioElement.addEventListener('play', () => {
      this.isPlaying = true;
      this.start();
    });

    this.audioElement.addEventListener('pause', () => {
      this.isPlaying = false;
      this.stop();
    });

    this.audioElement.addEventListener('ended', () => {
      this.isPlaying = false;
      this.stop();
    });
  }

  public start(): void {
    if (!this.audioContext || !this.analyser || this.animationId) return;

    // Resume audio context if suspended (for autoplay policies)
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch((error) => {
        console.warn('Audio Visualizer: Failed to resume audio context', error);
      });
    }

    this.draw();
  }

  public stop(): void {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  private draw(): void {
    if (!this.analyser || !this.audioContext) return;

    const canvas = this.canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const drawSpectrum = () => {
      if (!this.isPlaying || !this.analyser) return;

      this.animationId = requestAnimationFrame(drawSpectrum);

      // Get frequency data
      this.analyser.getByteFrequencyData(dataArray);

      // Clear canvas
      ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
      ctx.fillRect(0, 0, rect.width, rect.height);

      // Draw spectrum bars
      const barWidth = (rect.width / bufferLength) * 2.5;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * rect.height * 0.8;

        // Create gradient for each bar
        const gradient = ctx.createLinearGradient(0, rect.height - barHeight, 0, rect.height);
        gradient.addColorStop(0, 'rgba(59, 130, 246, 0.8)'); // Blue
        gradient.addColorStop(0.5, 'rgba(34, 211, 238, 0.9)'); // Cyan
        gradient.addColorStop(1, 'rgba(147, 51, 234, 0.8)'); // Purple

        ctx.fillStyle = gradient;
        ctx.fillRect(x, rect.height - barHeight, barWidth - 2, barHeight);

        x += barWidth;
      }
    };

    drawSpectrum();
  }

  public cleanup(): void {
    this.stop();

    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }

    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
}
