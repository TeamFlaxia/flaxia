export class AudioVisualizer {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private canvas: HTMLCanvasElement;
  private audioElement: HTMLAudioElement;
  private animationId: number | null = null;
  private isPlaying: boolean = false;
  private resizeObserver: ResizeObserver | null = null;

  // Main-thread drawing state
  private drawWidth = 0;
  private drawHeight = 0;
  private pixelRatio = 1;
  private bufferLength = 0;
  private dataArray: Uint8Array<ArrayBuffer> | null = null;

  constructor(audioElement: HTMLAudioElement, canvasElement: HTMLCanvasElement) {
    this.audioElement = audioElement;
    this.canvas = canvasElement;
    this.setupAudioContext();
    this.setupEventListeners();
    this.setupResizeObserver();
  }

  private setupAudioContext(): void {
    try {
      this.audioContext = new (
        window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!
      )();
      this.analyser = this.audioContext.createAnalyser();

      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;

      this.bufferLength = this.analyser.frequencyBinCount;
      this.dataArray = new Uint8Array(this.bufferLength);

      // Connecting a media element to the graph redirects its output. This
      // must happen AFTER src is assigned — re-assigning src afterwards severs
      // the element→graph connection on some browsers.
      this.source = this.audioContext.createMediaElementSource(this.audioElement);
      this.source.connect(this.analyser);
      this.analyser.connect(this.audioContext.destination);
    } catch (error) {
      console.warn('Audio Visualizer: Web Audio API not supported', error);
    }
  }

  private setupResizeObserver(): void {
    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width === 0 || height === 0) return;

      this.drawWidth = width;
      this.drawHeight = height;

      this.pixelRatio = window.devicePixelRatio || 1;
      this.canvas.width = width * this.pixelRatio;
      this.canvas.height = height * this.pixelRatio;

      const ctx = this.canvas.getContext('2d');
      if (ctx) {
        ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
      }
    });
    this.resizeObserver.observe(this.canvas);
  }

  private setupEventListeners(): void {
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
    if (!this.analyser || !this.dataArray) return;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    const w = this.drawWidth;
    const h = this.drawHeight;
    if (w === 0 || h === 0) return;

    const drawSpectrum = () => {
      if (!this.isPlaying || !this.analyser) return;

      this.animationId = requestAnimationFrame(drawSpectrum);

      this.analyser.getByteFrequencyData(this.dataArray!);

      // Clear with fade trail
      ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
      ctx.fillRect(0, 0, w, h);

      const barWidth = (w / this.bufferLength) * 2.5;
      let x = 0;

      for (let i = 0; i < this.bufferLength; i++) {
        const barHeight = (this.dataArray![i] / 255) * h * 0.8;
        if (barHeight < 1) {
          x += barWidth;
          continue;
        }

        const gradient = ctx.createLinearGradient(0, h - barHeight, 0, h);
        gradient.addColorStop(0, 'rgba(34, 197, 94, 0.95)');
        gradient.addColorStop(0.5, 'rgba(74, 222, 128, 0.9)');
        gradient.addColorStop(1, 'rgba(22, 101, 52, 0.8)');

        ctx.fillStyle = gradient;
        ctx.fillRect(x, h - barHeight, barWidth - 2, barHeight);

        x += barWidth;
      }
    };

    drawSpectrum();
  }

  public cleanup(): void {
    this.stop();

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

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
