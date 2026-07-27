import { allowedMediaTypeSchema, type AllowedMediaType } from "@scribe-drop/contracts";

const M4A_PICKER_MEDIA_TYPES = new Set([
  "",
  "application/octet-stream",
  "audio/m4a",
  "audio/mp4a-latm",
  "audio/mpeg4",
  "audio/x-m4a",
]);

interface SelectedMediaMetadata {
  readonly name: string;
  readonly type: string;
}

export function normalizeSelectedMediaType(
  media: SelectedMediaMetadata,
): AllowedMediaType | undefined {
  const [mediaType = ""] = media.type.trim().toLowerCase().split(";", 1);
  const allowedMediaType = allowedMediaTypeSchema.safeParse(mediaType);
  if (allowedMediaType.success) {
    return allowedMediaType.data;
  }

  if (/\.m4a$/iu.test(media.name.trim()) && M4A_PICKER_MEDIA_TYPES.has(mediaType)) {
    return "audio/mp4";
  }
  return undefined;
}
