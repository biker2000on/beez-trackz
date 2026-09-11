export const AUDIO_FILE_ACCEPT =
  "audio/*,.m4a,.mp4,.mp3,.wav,.ogg,.oga,.opus,.webm,.flac,.aac";
const audioTypes: Record<string, string> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  webm: "audio/webm",
  flac: "audio/flac",
  aac: "audio/aac",
};

/** Android document providers sometimes omit MIME or label M4A as video/mp4. */
export function prepareAudioFile(file: File): Blob {
  if (!file.size)
    throw new Error("This recording is empty. Choose another audio file.");
  if (file.size > 64 * 1024 * 1024)
    throw new Error("Choose a recording smaller than 64 MB.");
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const type = audioTypes[extension] ?? file.type.split(";")[0].toLowerCase();
  if (!Object.values(audioTypes).includes(type))
    throw new Error(
      "Choose an M4A, MP3, WAV, OGG, Opus, WebM, MP4, FLAC or AAC recording.",
    );
  return file.slice(0, file.size, type);
}
