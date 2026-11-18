import { fetch } from "expo/fetch";
import { apiClient } from "./protocol";

export const nativeApi = (origin: string, bearer?: string) => apiClient(fetch, origin, bearer);
