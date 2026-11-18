import { useEffect, useState } from "react";
import { uuid } from "expo";
import { File, UploadTask, UploadType } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import type { AttachmentSend } from "../../../src/client-protocol/index.ts";
import { AttachmentDraft, photoFileName, type DraftFile, type PickedFile, type PutFile } from "./attachments";
import type { MobileApi } from "./protocol";
import { errorText } from "./use-session";

export type PickKind = "camera" | "photos" | "files";

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
const PHOTO_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: "images", quality: 0.8,
  preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
};

function photos(result: ImagePicker.ImagePickerResult): PickedFile[] {
  if (result.canceled) return [];
  const now = new Date();
  return result.assets.map((asset) => {
    const mimeType = asset.mimeType ?? "image/jpeg";
    return { name: photoFileName(asset.fileName, mimeType, now), uri: asset.uri, mimeType, size: new File(asset.uri).size };
  });
}

/** The picked files, or a note to show instead. */
async function pick(kind: PickKind): Promise<PickedFile[] | string> {
  if (kind === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return "Camera access is off. Allow it for LearnHarness Nightly in Settings to take photos.";
    return photos(await ImagePicker.launchCameraAsync(PHOTO_OPTIONS));
  }
  if (kind === "photos") {
    return photos(await ImagePicker.launchImageLibraryAsync({ ...PHOTO_OPTIONS, allowsMultipleSelection: true }));
  }
  const result = await File.pickFileAsync({ multipleFiles: true });
  if (result.canceled) return [];
  return result.result.map((file) => ({ name: file.name, uri: file.uri, mimeType: file.type || "application/octet-stream", size: file.size }));
}

/** One composer's attachments: an existing chat's, or without `chatId` the opening draft's. */
export function useAttachments(api: MobileApi, chatId?: string) {
  const [, redraw] = useState(0);
  const [draft] = useState(() => new AttachmentDraft({ api, chatId, put, newId: () => uuid.v4(), changed: () => redraw((n) => n + 1) }));
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
