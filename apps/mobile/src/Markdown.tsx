import { useMemo, useState } from "react";
import { Text, useWindowDimensions } from "react-native";
import { WebView } from "react-native-webview";
import { renderMarkdown } from "./render-markdown";
import { colors, styles } from "./ui";

export function Markdown({ text }: { text: string }) {
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
        pre, code { background:${colors.accentLight}; border-radius:4px; }
        pre { padding:8px; }
        blockquote { margin-inline:0; padding-inline-start:10px; border-inline-start:3px solid ${colors.border}; }
        td,th { padding:4px; border-bottom:1px solid ${colors.border}; }
      </style></head><body><div id="content">${renderMarkdown(text)}</div>
      <script nonce="lh-size">
        const content = document.getElementById('content');
        function resize() { ReactNativeWebView.postMessage(String(Math.ceil(content.getBoundingClientRect().height))); }
        window.addEventListener('load', resize);
        new ResizeObserver(resize).observe(content);
      </script></body></html>`,
  }), [fontScale, text]);
  if (!text.trim()) return null;
  if (failed || !/[\n*_$()[\]{}<>`#\\]/.test(text)) return <Text selectable style={styles.text}>{text}</Text>;

  // Local, sanitized markup and MathML only. The sizing script is the
  // only script allowed. This view never receives an origin or a bearer.
  return (
    <WebView source={source} originWhitelist={["*"]} onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
      scrollEnabled={false} allowFileAccess={false} setSupportMultipleWindows={false} domStorageEnabled={false}
      style={{ backgroundColor: "transparent", height }} containerStyle={{ flex: 0, height }}
      onError={() => setFailed(true)} onMessage={({ nativeEvent }) => {
        const measured = Number(nativeEvent.data);
        if (Number.isFinite(measured) && measured > 0) setHeight(measured + 2);
      }} />
  );
}
