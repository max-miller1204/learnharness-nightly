import { useEffect, useState } from "react";
import { uuid } from "expo";
import { Directory, File, Paths, UploadTask, UploadType } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";
import type { AttachmentSend } from "../../../src/client-protocol/index.ts";
import { MAX_ATTACHMENT_FILE_BYTES } from "../../../src/core/attachment-limits.ts";
import { AttachmentDraft, photoNames, type DraftFile, type PickedFile, type PutFile } from "./attachments";
import { sniffImageType, stripLocation } from "./photo-bytes";
import type { MobileApi } from "./protocol";
import { errorText } from "./use-session";

export type PickKind = "camera" | "photos" | "files";

/** Android names a Files pick only once it is copied, and nothing this large is copied. */
export const TOO_BIG_TO_NAME = "A picked file exceeds the 50 MiB per-file limit.";

const put: PutFile = async (file, url, headers, progress, signal) => {
  const task = new UploadTask(new File(file.uri), url, {
    httpMethod: "PUT", uploadType: UploadType.BINARY_CONTENT, headers, mimeType: file.mimeType,
    sessionType: "foreground", signal, onProgress: ({ bytesSent }) => progress(bytesSent),
  });
  try {
    const { status, body } = await task.uploadAsync();
    return { status, body };
  } finally {
    task.release();
  }
};

// JPEG at 80%. Compatible turns iPhone HEIC into JPEG, which the teacher's tools can read.
// Location data is stripped after the pick (photo-bytes.ts).
const PHOTO_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: "images", quality: 0.8,
  preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
};

/** A file or folder this app made in its cache, or undefined for anything else. */
const owned = (uri: string) => uri.startsWith(Paths.cache.uri) ? uri : undefined;

/** Deletes a copy the app made (`PickedFile.cleanup`). */
function release(path: string) {
  if (!owned(path)) return;
  const folder = new Directory(path);
  if (folder.exists) folder.delete();
  else {
    const file = new File(path);
    if (file.exists) file.delete();
  }
}

function freshFolder(): Directory {
  const folder = new Directory(Paths.cache, "attachments", uuid.v4());
  folder.create({ intermediates: true });
  return folder;
}

/** The pick's photos, declared by the bytes the picker wrote (Android
 *  re-encodes HEIC, GIF and WebP as JPEG) and without location data. */
async function photos(result: ImagePicker.ImagePickerResult, keepNames: boolean): Promise<PickedFile[]> {
  if (result.canceled) return [];
  const made: string[] = [];
  try {
    const shots = await Promise.all(result.assets.map(async (asset) => {
      const bytes = await new File(asset.uri).bytes();
      const mimeType = sniffImageType(bytes) ?? asset.mimeType ?? "image/jpeg";
      const clean = stripLocation(bytes);
      if (!clean) return { fileName: asset.fileName, mimeType, uri: asset.uri, size: bytes.length, cleanup: owned(asset.uri) };
      const folder = freshFolder();
      made.push(folder.uri);
      const copy = new File(folder, "photo.jpg");
      copy.create();
      await copy.write(clean);
      release(asset.uri);
      return { fileName: asset.fileName, mimeType, uri: copy.uri, size: clean.length, cleanup: folder.uri };
    }));
    const names = photoNames(shots, new Date(), keepNames);
    return shots.map(({ mimeType, uri, size, cleanup }, index) => ({ name: names[index]!, uri, mimeType, size, cleanup }));
  } catch (error) {
    made.forEach(release);
    throw error;
  }
}

/** Android's file picker returns content URIs whose last segment is an ID such
 *  as "document:21". A copy into a fresh cache folder takes the provider's
 *  display name, so the chip and the teacher see the real filename. Nothing
 *  over the largest accepted size is copied, so the copies stay bounded. */
async function files(picked: readonly File[]): Promise<PickedFile[] | string> {
  if (picked.some((file) => file.uri.startsWith("content:") && file.size > MAX_ATTACHMENT_FILE_BYTES)) return TOO_BIG_TO_NAME;
  const made: string[] = [];
  try {
    const out: PickedFile[] = [];
    for (const file of picked) {
      const mimeType = file.type || "application/octet-stream";
      if (!file.uri.startsWith("content:")) {
        out.push({ name: file.name, uri: file.uri, mimeType, size: file.size, cleanup: owned(file.uri) });
        continue;
      }
      const folder = freshFolder();
      made.push(folder.uri);
      await file.copy(folder);
      const [copy] = folder.list();
      if (!(copy instanceof File)) throw new Error("Couldn't read the picked file. Try again.");
      out.push({ name: copy.name, uri: copy.uri, mimeType: file.type || copy.type || "application/octet-stream", size: copy.size, cleanup: folder.uri });
    }
    return out;
  } catch (error) {
    made.forEach(release);
    throw error;
  }
}

/** The picked files, or a note to show instead. */
async function pick(kind: PickKind): Promise<PickedFile[] | string> {
  if (kind === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return "Camera access is off. Allow it for LearnHarness Nightly in Settings to take photos.";
    return photos(await ImagePicker.launchCameraAsync(PHOTO_OPTIONS), false);
  }
  if (kind === "photos") {
    return photos(await ImagePicker.launchImageLibraryAsync({ ...PHOTO_OPTIONS, allowsMultipleSelection: true }), Platform.OS === "ios");
  }
  const result = await File.pickFileAsync({ multipleFiles: true });
  return result.canceled ? [] : files(result.result);
}

/** One composer's attachments: an existing chat's, or without `chatId` the opening draft's. */
export function useAttachments(api: MobileApi, chatId?: string) {
  const [, redraw] = useState(0);
  const [draft] = useState(() => new AttachmentDraft({ api, chatId, put, release, newId: () => uuid.v4(), changed: () => redraw((n) => n + 1) }));
  useEffect(() => {
    draft.open();
    return () => draft.dispose();
  }, [draft]);

  return {
    rows: draft.rows,
    notice: draft.notice,
    async choose(kind: PickKind) {
      draft.say(undefined);
      try {
        const picked = await pick(kind);
        if (typeof picked === "string") draft.say(picked);
        else if (picked.length) draft.add(picked);
      } catch (error) {
        draft.say(errorText(error));
      }
    },
    retry: (row: DraftFile) => draft.retry(row),
    remove: (row: DraftFile) => draft.remove(row),
    prepare: (identity: string) => draft.prepare(identity),
    accept: (send: AttachmentSend) => draft.accept(send),
    draftId: () => draft.draftId(),
  };
}

export type Attachments = ReturnType<typeof useAttachments>;
