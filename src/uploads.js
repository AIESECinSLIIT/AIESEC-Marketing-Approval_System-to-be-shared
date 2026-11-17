export const MAX_FILE_SIZE = 50 * 1024 * 1024;
export const FILE_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};
export const FILE_ACCEPT = [
  ...Object.keys(FILE_TYPES).map((x) => `.${x}`),
  ...new Set(Object.values(FILE_TYPES)),
].join(",");
export function uploadMime(file) {
  const type = (file.type || "").toLowerCase();
  if (Object.values(FILE_TYPES).includes(type)) return type;
  // Mobile file pickers sometimes omit MIME or use an unhelpful generic type.
  if (!type || ["application/octet-stream", "video/x-quicktime"].includes(type))
    return FILE_TYPES[file.name.split(".").pop().toLowerCase()] || "";
  return "";
}
export function validateUploads(files) {
  if (files.length > 8) throw new Error("Upload up to 8 files.");
  for (const file of files) {
    if (!file.size) throw new Error(`${file.name} is empty.`);
    if (file.size > MAX_FILE_SIZE)
      throw new Error(
        `${file.name} is larger than 50 MB. Upload it to Google Drive and paste its file link below.`,
      );
    if (!uploadMime(file))
      throw new Error("Use JPG, PNG, WebP, GIF, PDF, MP4, MOV or WebM files.");
  }
}
