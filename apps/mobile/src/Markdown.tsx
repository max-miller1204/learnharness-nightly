import { useMemo } from "react";
import { Alert, Linking } from "react-native";
import { markdownOf } from "./message-math";
import { httpsLink } from "./render-markdown";
import { NativeMarkdown } from "./NativeMarkdown";

export function confirmExternalLink(value: string) {
  const url = httpsLink(value);
  if (!url) return;
  Alert.alert("Open in browser?", url, [
    { text: "Cancel", style: "cancel" },
    { text: "Open", onPress: () => {
      void Linking.openURL(url).catch(() => Alert.alert("Couldn't open the browser."));
    } },
  ]);
}

export function Markdown({ text }: { text: string }) {
  const parsed = useMemo(() => markdownOf(text), [text]);
  if (!parsed.tokens.length) return null;
  return <NativeMarkdown tokens={parsed.tokens} openLink={confirmExternalLink} />;
}
