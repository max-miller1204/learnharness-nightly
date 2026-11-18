import { useMemo, useState } from "react";
import { Alert, Linking, useWindowDimensions } from "react-native";
import { WebView } from "react-native-webview";
import { httpsLink, parseMarkdown, proseType, renderMarkdown } from "./render-markdown";
import { NativeMarkdown } from "./NativeMarkdown";
import { useTheme } from "./theme";

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

export function Markdown({ text, small }: { text: string; small?: boolean }) {
  const parsed = useMemo(() => parseMarkdown(text), [text]);
  if (!parsed.tokens.length) return null;
  if (!parsed.hasMath) return <NativeMarkdown tokens={parsed.tokens} openLink={confirmExternalLink} small={small} />;
  return <MathMarkdown parsed={parsed} small={small} />;
}

function MathMarkdown({ parsed, small }: { parsed: ReturnType<typeof parseMarkdown>; small?: boolean }) {
  const { c } = useTheme();
  const { fontScale } = useWindowDimensions();
  const [height, setHeight] = useState(26);
  const [failed, setFailed] = useState(false);
  const type = proseType(small);
  const source = useMemo(() => ({
    html: `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-lh-size'; base-uri 'none'; form-action 'none'">
      <style>
        html,body { margin:0; padding:0; background:transparent; color:${c.text};
          font: ${type.fontSize * fontScale}px/${type.lineHeight * fontScale}px system-ui,sans-serif; overflow-wrap:anywhere; }
        #content { display:flow-root; }
        #content > :first-child { margin-top:0; }
        #content > :last-child { margin-bottom:0; }
        pre, .katex-display { overflow-x:auto; }
        a { color:${c.text}; }
        strong { color:${c.strong}; } em { color:${c.italic}; }
        h1,h2,h3,h4,h5,h6 { font-weight:900; }
        pre, code { font-family:ui-monospace,monospace; background:${c.well}; color:${c.code}; border:1px solid ${c.border}; border-radius:4px; }
        pre { padding:12px 16px; border-radius:12px; }
        pre code { border:0; }
        blockquote { margin-inline:0; padding-inline-start:12px; border-inline-start:3px solid ${c.rail}; }
        table { border-collapse:collapse; border:1px solid ${c.border}; }
        td,th { padding:4px 8px; border:1px solid ${c.border}; }
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
  }), [c, fontScale, parsed, type.fontSize, type.lineHeight]);
  if (failed) return <NativeMarkdown tokens={parsed.tokens} openLink={confirmExternalLink} small={small} />;

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
