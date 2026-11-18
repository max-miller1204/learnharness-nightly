import { useEffect, useRef, useState } from "react";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { Platform, ScrollView, Text, View } from "react-native";
import { type SavedServer, saveBearer } from "./device-storage";
import { nativeApi } from "./native-api";
import { httpsOrigin, pairingCode, readPairingLink } from "./protocol";
import { errorText } from "./use-session";
import { Button, Field, Notice, styles } from "./ui";

export function Pairing({ initialOrigin, cancel, onPaired }: {
  initialOrigin?: string;
  cancel: () => void;
  onPaired: (server: SavedServer, token: string) => Promise<void>;
}) {
  const [address, setAddress] = useState(initialOrigin ?? "");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const scanArmed = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const issued = useRef<{ server: SavedServer; code: string; token: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current?.abort(); };
  }, []);

  function fillFromLink(link: string) {
    try {
      const pair = readPairingLink(link);
      scanArmed.current = false;
      setScanning(false);
      setAddress(pair.origin);
      setCode(pair.code);
      setError("");
    } catch {
      setError("Use the pairing link from lh pair or Settings → Devices.");
    }
  }

  async function scan() {
    try {
      const access = permission?.granted ? permission : await requestPermission();
      if (!mounted.current) return;
      if (!access.granted) {
        setError("Camera access is unavailable. Paste the link or enter the address and code.");
        return;
      }
      scanArmed.current = true;
      setError("");
      setScanning(true);
    } catch {
      if (mounted.current) setError("Couldn't open the camera. Paste the link or enter the address and code.");
    }
  }

  async function paste() {
    try {
      const link = await Clipboard.getStringAsync();
      if (mounted.current) fillFromLink(link);
    } catch {
      if (mounted.current) setError("Couldn't read the clipboard. Enter the address and code.");
    }
  }

  async function connect() {
    if (operation.current) return;
    const scope = new AbortController();
    operation.current = scope;
    const signal = scope.signal;
    setBusy(true);
    setError("");
    try {
      const origin = httpsOrigin(address);
      const credential = pairingCode(code);
      let saved = issued.current;
      if (!saved || saved.server.origin !== origin || saved.code !== credential) {
        const api = nativeApi(origin);
        const descriptor = await api.descriptor(signal);
        const token = await api.exchange(credential, Platform.OS, signal);
        if (signal.aborted) return;
        saved = { server: { origin, name: descriptor.name }, code: credential, token };
        issued.current = saved;
      }
      await saveBearer(origin, saved.token);
      if (!signal.aborted) await onPaired(saved.server, saved.token);
    } catch (error) {
      if (!signal.aborted) setError(errorText(error));
    } finally {
      operation.current = null;
      if (!signal.aborted) setBusy(false);
    }
  }

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.section}>
      <Text accessibilityRole="header" style={styles.title}>Pair a server</Text>
      <Text style={styles.text}>Use the QR code from lh pair or Settings → Devices.</Text>
      <View style={styles.row}>
        <Button disabled={busy} onPress={() => void scan()}>Scan QR code</Button>
        <Button disabled={busy} onPress={() => void paste()}>Paste pairing link</Button>
      </View>
      {scanning && (
        <View style={{ height: 235, borderRadius: 8, overflow: "hidden" }}>
          <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onMountError={() => {
              scanArmed.current = false;
              setScanning(false);
              setError("Couldn't open the camera. Paste the link or enter the address and code.");
            }}
            onBarcodeScanned={({ data }) => { if (scanArmed.current) fillFromLink(data); }} />
          <Button onPress={() => { scanArmed.current = false; setScanning(false); }}>Close camera</Button>
        </View>
      )}
      <Field label="Server address" placeholder="https://server.example.ts.net" value={address} onChangeText={setAddress}
        autoCapitalize="none" autoCorrect={false} keyboardType="url" editable={!busy} />
      <Field label="Pairing code" placeholder="XXXX-XXXX-XXXX" value={code} onChangeText={setCode}
        autoCapitalize="characters" autoCorrect={false} secureTextEntry editable={!busy} />
      <Notice>{error}</Notice>
      <View style={styles.row}>
        <Button primary disabled={busy || !address.trim() || !code.trim()} onPress={() => void connect()}>{busy ? "Connecting…" : "Connect"}</Button>
        <Button disabled={busy} onPress={cancel}>Saved servers</Button>
      </View>
    </ScrollView>
  );
}
