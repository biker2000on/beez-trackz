import { describe, it, expect, beforeAll, vi } from 'vitest';
import { formatDuration, blobToBase64 } from '@/lib/audio-utils';

describe('formatDuration', () => {
  it('formats zero seconds', () => {
    expect(formatDuration(0)).toBe('00:00');
  });

  it('formats seconds less than a minute', () => {
    expect(formatDuration(59)).toBe('00:59');
  });

  it('formats exactly one minute', () => {
    expect(formatDuration(60)).toBe('01:00');
  });

  it('formats more than an hour', () => {
    expect(formatDuration(3661)).toBe('61:01');
  });

  it('pads single digit minutes and seconds', () => {
    expect(formatDuration(65)).toBe('01:05');
  });

  it('handles large durations', () => {
    expect(formatDuration(599)).toBe('09:59');
  });
});

describe('blobToBase64', () => {
  beforeAll(() => {
    // Mock FileReader for Node environment
    if (typeof FileReader === 'undefined') {
      global.FileReader = class FileReader {
        result: string | ArrayBuffer | null = null;
        onloadend: ((this: FileReader, ev: ProgressEvent) => any) | null = null;
        onerror: ((this: FileReader, ev: ProgressEvent) => any) | null = null;

        readAsDataURL(blob: Blob) {
          // Mock implementation - convert blob to base64
          const reader = new (global as any).FileReader();
          this.result = 'data:text/plain;base64,SGVsbG8sIEJlZXMh';
          setTimeout(() => {
            if (this.onloadend) {
              this.onloadend({} as ProgressEvent);
            }
          }, 0);
        }
      } as any;
    }
  });

  it('converts a simple blob to base64', async () => {
    const testString = 'Hello, Bees!';
    const blob = new Blob([testString], { type: 'text/plain' });
    const result = await blobToBase64(blob);

    expect(result).toContain('data:text/plain;base64,');
    expect(result.length).toBeGreaterThan(0);
  });

  it('handles empty blob', async () => {
    const blob = new Blob([], { type: 'text/plain' });
    const result = await blobToBase64(blob);

    expect(result).toContain('data:text/plain;base64,');
  });
});
