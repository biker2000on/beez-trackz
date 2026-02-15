/**
 * Audio utility functions for recording and processing audio
 */

/**
 * Preferred audio MIME type with fallback
 * webm/opus is preferred for quality and compression, mp4 for compatibility
 */
export const AUDIO_MIME_TYPE = (() => {
  if (typeof window === 'undefined') return 'audio/webm;codecs=opus';

  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
    return 'audio/webm;codecs=opus';
  }
  if (MediaRecorder.isTypeSupported('audio/webm')) {
    return 'audio/webm';
  }
  if (MediaRecorder.isTypeSupported('audio/mp4')) {
    return 'audio/mp4';
  }
  return 'audio/webm'; // fallback
})();

/**
 * Maximum recording duration in seconds (30 minutes)
 */
export const MAX_RECORDING_DURATION = 30 * 60;

/**
 * Formats duration in seconds to MM:SS string
 * @param seconds - Duration in seconds
 * @returns Formatted string like "02:35"
 */
export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Converts a Blob to Base64 string
 * @param blob - The Blob to convert
 * @returns Promise resolving to base64 string (with data URL prefix)
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Failed to convert blob to base64'));
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
