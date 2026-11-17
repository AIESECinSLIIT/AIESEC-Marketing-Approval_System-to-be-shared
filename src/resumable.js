import { Upload } from "tus-js-client";

export function uploadResumable({
  file,
  path,
  mime,
  bucket,
  url,
  key,
  token,
  onProgress = () => {},
}) {
  const storageUrl = new URL(url);
  storageUrl.hostname = storageUrl.hostname.replace(
    ".supabase.co",
    ".storage.supabase.co",
  );
  return new Promise((resolve, reject) => {
    const upload = new Upload(file, {
      endpoint: `${storageUrl.origin}/storage/v1/upload/resumable`,
      headers: { authorization: `Bearer ${token}`, apikey: key },
      metadata: {
        bucketName: bucket,
        objectName: path,
        contentType: mime,
        cacheControl: "3600",
      },
      chunkSize: 6 * 1024 * 1024,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      uploadDataDuringCreation: true,
      storeFingerprintForResuming: false,
      onProgress: (bytes) => onProgress(bytes),
      onSuccess: resolve,
      onError: () =>
        reject(
          new Error("Upload failed. Check your connection and try again."),
        ),
    });
    upload.start();
  });
}
