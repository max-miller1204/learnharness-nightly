import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, KeyboardAvoidingView, Platform, ScrollView, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { PROTOCOL_ROUTES, type ServerInfo, type SessionStateResponse } from "../../../src/client-protocol/index.ts";
import { clearBearer, loadDirectory, readBearer, saveDirectory, type SavedServer, type ServerDirectory } from "./device-storage";
import { ApiError, type MobileApi } from "./protocol";
import { nativeApi } from "./native-api";
import { errorText } from "./use-session";
import { Pairing } from "./Pairing";
import { Workspace } from "./Workspace";
import { Button, Notice, styles } from "./ui";

interface Connection {
  api: MobileApi;
  info: ServerInfo;
  key: number;
}

function Mobile() {
  const [directory, setDirectory] = useState<ServerDirectory>();
  const [connection, setConnection] = useState<Connection>();
  const [pairOrigin, setPairOrigin] = useState<string>();
  const [pairing, setPairing] = useState(false);
  const [failed, setFailed] = useState<SavedServer>();
  const [connecting, setConnecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [launch, setLaunch] = useState(0);
  const [active, setActive] = useState(AppState.currentState !== "background" && AppState.currentState !== "inactive");
  const serial = useRef(0);
  const scope = useRef<AbortController | null>(null);
  const lock = useRef(false);

  const connect = useCallback(async (server: SavedServer, freshToken?: string) => {
    scope.current?.abort();
    const controller = new AbortController();
    const signal = controller.signal;
    scope.current = controller;
    const key = ++serial.current;
    setConnection(undefined);
    setPairing(false);
    setFailed(undefined);
    setConnecting(true);
    setError("");
    try {
      const info = await nativeApi(server.origin).descriptor(signal);
      const token = freshToken ?? await readBearer(server.origin);
      if (signal.aborted) return;
      if (!token) {
        setPairOrigin(server.origin);
        setPairing(true);
        return;
      }
      const api = nativeApi(server.origin, token);
      const state = await api.get<SessionStateResponse>(PROTOCOL_ROUTES.session, signal);
      if (signal.aborted) return;
      if (!state.authenticated) {
        await clearBearer(server.origin);
        if (signal.aborted) return;
        setError("Pair this phone again to connect.");
        setPairOrigin(server.origin);
        setPairing(true);
        return;
      }
      setConnection({ api, info, key });
    } catch (error) {
      if (!signal.aborted) { setFailed(server); setError(errorText(error)); }
    } finally {
      if (!signal.aborted) setConnecting(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    loadDirectory().then((saved) => {
      if (!alive) return;
      setDirectory(saved);
      setStorageError("");
      const preferred = saved.servers.find(({ origin }) => origin === saved.defaultOrigin);
      if (preferred) void connect(preferred);
    }).catch(() => { if (alive) setStorageError("Couldn't read saved servers."); });
    return () => { alive = false; scope.current?.abort(); };
  }, [connect, launch]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setActive(state === "active"));
    return () => subscription.remove();
  }, []);

  const connectionFault = useCallback((error: unknown) => {
    if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 426)) return false;
    if (!connection || connection.key !== serial.current) return true;
    ++serial.current;
    scope.current?.abort();
    setConnection(undefined);
    const server = { origin: connection.api.origin, name: connection.info.name };
    if (error.status === 426) {
      setError(error.message);
      setFailed(server);
    } else {
      // Clear only the credential for the connection that got revoked.
      setConnecting(true);
      void clearBearer(server.origin).then(() => {
        setError("This device's session was revoked. Pair again to reconnect.");
        setPairOrigin(server.origin);
        setPairing(true);
      }).catch(() => {
        setFailed(server);
        setError("Couldn't clear this server's saved credential.");
      }).finally(() => setConnecting(false));
    }
    return true;
  }, [connection]);

  function showServers() {
    ++serial.current;
    scope.current?.abort();
    setConnecting(false);
    setConnection(undefined);
    setPairing(false);
    setError("");
  }

  async function makeDefault(origin: string) {
    if (!directory || lock.current) return;
    lock.current = true;
    setSaving(true);
    const next = { ...directory, defaultOrigin: origin };
    try {
      await saveDirectory(next);
      setDirectory(next);
    } catch {
      setError("Couldn't save the default server.");
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }

  async function onPaired(server: SavedServer, token: string) {
    if (!directory) return;
    const next = { ...directory, servers: [...directory.servers.filter(({ origin }) => origin !== server.origin), server] };
    await saveDirectory(next);
    setDirectory(next);
    await connect(server, token);
  }

  if (connection) return <Workspace key={connection.key} api={connection.api} initialInfo={connection.info} active={active} servers={showServers} connectionFault={connectionFault} />;

  if (pairing) return (
    <>
      <Notice>{error}</Notice>
      <Pairing initialOrigin={pairOrigin} cancel={showServers} onPaired={onPaired} />
    </>
  );

  return (
    <ScrollView contentContainerStyle={styles.section}>
      <Text accessibilityRole="header" style={styles.title}>LearnHarness Nightly</Text>
      <Text style={styles.subtitle}>Saved servers</Text>
      <Notice>{storageError || error}</Notice>
      {connecting && <Text accessibilityLiveRegion="polite" style={styles.muted}>Connecting…</Text>}
      {!directory && storageError && <Button onPress={() => setLaunch((value) => value + 1)}>Retry</Button>}
      {failed && <View style={styles.row}>
        <Button disabled={connecting || saving} onPress={() => void connect(failed)}>Retry connection</Button>
      </View>}
      {directory?.servers.map((server) => (
        <View key={server.origin} style={styles.card}>
          <Text style={styles.subtitle}>{server.name}</Text>
          <Text style={styles.muted}>{server.origin}</Text>
          <View style={styles.row}>
            <Button primary disabled={connecting || saving} onPress={() => void connect(server)}>Open</Button>
            {directory.defaultOrigin === server.origin ? <Text style={styles.muted}>Default</Text>
              : <Button disabled={connecting || saving} onPress={() => void makeDefault(server.origin)}>Make default</Button>}
          </View>
        </View>
      ))}
      {directory && <View style={styles.row}><Button disabled={connecting || saving} onPress={() => {
        setFailed(undefined);
        setPairOrigin(undefined);
        setError("");
        setPairing(true);
      }}>Pair a server</Button></View>}
    </ScrollView>
  );
}

export function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.page}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <Mobile />
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
