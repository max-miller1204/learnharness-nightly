// Stand-in for expo-file-system in Node tests. A Files pick returns the files
// a test puts in globalThis.pickedFiles, and every upload is accepted.
class File {
  constructor(uri) { this.uri = String(uri); this.exists = false; }
  static async pickFileAsync() { return { canceled: false, result: (globalThis.pickedFiles ?? []).splice(0) }; }
  delete() {}
}
class Directory {
  constructor(...parts) { this.uri = parts.map((part) => part.uri ?? part).join("/"); this.exists = false; }
  create() {}
  delete() {}
}
class UploadTask {
  async uploadAsync() { return { status: 204, body: "" }; }
  release() {}
}
module.exports = { File, Directory, UploadTask, UploadType: { BINARY_CONTENT: 0 }, Paths: { cache: { uri: "file:///cache/" } } };
