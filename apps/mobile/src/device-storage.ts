import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { bearerKey } from "./protocol";

export interface SavedServer {
  origin: string;
  name: string;
}

export interface ServerDirectory {
  servers: SavedServer[];
  defaultOrigin?: string;
}

const DIRECTORY = "learnharness.servers";
const KEYCHAIN = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export async function loadDirectory(): Promise<ServerDirectory> {
  const value = await AsyncStorage.getItem(DIRECTORY);
  return value ? JSON.parse(value) as ServerDirectory : { servers: [] };
}

export const saveDirectory = (directory: ServerDirectory) => AsyncStorage.setItem(DIRECTORY, JSON.stringify(directory));
export const readBearer = (origin: string) => SecureStore.getItemAsync(bearerKey(origin), KEYCHAIN);
export const saveBearer = (origin: string, token: string) => SecureStore.setItemAsync(bearerKey(origin), token, KEYCHAIN);
export const clearBearer = (origin: string) => SecureStore.deleteItemAsync(bearerKey(origin), KEYCHAIN);
