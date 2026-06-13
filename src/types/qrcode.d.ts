/**
 * Minimal ambient types for the `qrcode` package — only the surface botmux uses
 * (`toBuffer` → PNG). Avoids pulling @types/qrcode for one function.
 */
declare module 'qrcode' {
  interface QRCodeToBufferOptions {
    type?: 'png';
    /** Output image width in px (the QR is scaled to fit). */
    width?: number;
    /** Quiet-zone size in modules. */
    margin?: number;
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  }
  export function toBuffer(text: string, options?: QRCodeToBufferOptions): Promise<Buffer>;
  const _default: { toBuffer: typeof toBuffer };
  export default _default;
}
