import { useMemo, useState } from "react";
import { Alert, Linking, useWindowDimensions } from "react-native";
import { WebView } from "react-native-webview";
import { httpsLink, parseMarkdown, renderMarkdown } from "./render-markdown";
import { NativeMarkdown } from "./NativeMarkdown";
import { colors } from "./ui";

function confirmExternalLink(value: string) {
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
  const parsed = useMemo(() => parseMarkdown(text), [text]);
  if (!parsed.tokens.length) return null;
  if (!parsed.hasMath) return <NativeMarkdown tokens={parsed.tokens} openLink={confirmExternalLink} />;
  return <MathMarkdown parsed={parsed} />;
}

function MathMarkdown({ parsed }: { parsed: ReturnType<typeof parseMarkdown> }) {
  const { fontScale } = useWindowDimensions();
  const [height, setHeight] = useState(26);
  const [failed, setFailed] = useState(false);
  const source = useMemo(() => ({
    html: `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-lh-size'; base-uri 'none'; form-action 'none'">
      <style>
        html,body { margin:0; padding:0; background:transparent; color:${colors.ink};
          font: ${16 * fontScale}px/1.45 system-ui,sans-serif; overflow-wrap:anywhere; }
        #content { display:flow-root; }
        #content > :first-child { margin-top:0; }
        #content > :last-child { margin-bottom:0; }
        pre, .katex-display { overflow-x:auto; }
        a { color:${colors.accent}; }
        pre, code { background:${colors.accentLight}; border-radius:4px; }
        pre { padding:8px; }
        blockquote { margin-inline:0; padding-inline-start:10px; border-inline-start:3px solid ${colors.border}; }
        td,th { padding:4px; border-bottom:1px solid ${colors.border}; }
      </style></head><body><div id="content">${renderMarkdown(parsed)}</div>
      <script nonce="lh-size">
        const content = document.getElementById('content');
        function resize() { ReactNativeWebView.postMessage(String(Math.ceil(content.getBoundingClientRect().height))); }
        document.addEventListener('click', (event) => {
          const link = event.target.closest?.('a[href]');
          if (!link) return;
          event.preventDefault();
          ReactNativeWebView.postMessage(link.href);
        });
        document.addEventListener('contextmenu', (event) => {
          if (event.target.closest?.('a[href]')) event.preventDefault();
        });
        window.addEventListener('load', resize);
        new ResizeObserver(resize).observe(content);
      </script></body></html>`,
  }), [fontScale, parsed]);
  if (failed) return <NativeMarkdown tokens={parsed.tokens} openLink={confirmExternalLink} />;

  // The local document reports its size and link taps. It cannot navigate or load external content.
  return (
    <WebView source={source} originWhitelist={["*"]} onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
      scrollEnabled={false} allowsLinkPreview={false} allowFileAccess={false} setSupportMultipleWindows={false} domStorageEnabled={false}
      style={{ backgroundColor: "transparent", height }} containerStyle={{ flex: 0, height }}
      onError={() => setFailed(true)} onMessage={({ nativeEvent }) => {
        const measured = Number(nativeEvent.data);
        if (Number.isFinite(measured) && measured > 0) setHeight(measured + 2);
        else confirmExternalLink(nativeEvent.data);
      }} />
  );
}
