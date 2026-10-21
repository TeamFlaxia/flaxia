declare module 'gifenc' {
  export type RgbTriplet = [number, number, number];

  export interface FrameOptions {
    palette?: RgbTriplet[];
    delay?: number;
    repeat?: number;
    transparent?: boolean;
    transparentIndex?: number;
    colorDepth?: number;
    dispose?: number;
    first?: boolean;
  }

  export interface GIFEncoder {
    reset(): void;
    writeHeader(): void;
    writeFrame(index: Uint8Array, width: number, height: number, options?: FrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    buffer: ArrayBuffer;
  }

  export function GIFEncoder(options?: { initialCapacity?: number; auto?: boolean }): GIFEncoder;
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: 'rgb565' | 'rgb444' | 'rgba4444'; oneBitAlpha?: number | boolean },
  ): RgbTriplet[];
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: RgbTriplet[],
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array;
}
