import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Linking, useWindowDimensions } from "react-native";
import { WebView } from "react-native-webview";
import { httpsLink, parseMarkdown, proseCss, renderMarkdown } from "./render-markdown";
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

/** A math view calls this when it mounts, and the function it returns once it
 *  has reported its height (or failed or gone away), so opening a session can
 *  wait for them (open-settle.ts pendingCounter). */
export const MathLoading = createContext<(() => () => void) | null>(null);

/** `hidden` keeps screen readers out of the text, for a label its parent already reads (a quiz choice row). */
export function Markdown({ text, small, hidden }: { text: string; small?: boolean; hidden?: boolean }) {
  const parsed = useMemo(() => parseMarkdown(text), [text]);
  if (!parsed.tokens.length) return null;
  if (!parsed.hasMath) return <NativeMarkdown tokens={parsed.tokens} openLink={confirmExternalLink} small={small} />;
  return <MathMarkdown parsed={parsed} small={small} hidden={hidden} />;
}

function MathMarkdown({ parsed, small, hidden }: { parsed: ReturnType<typeof parseMarkdown>; small?: boolean; hidden?: boolean }) {
  const { c } = useTheme();
  const { fontScale } = useWindowDimensions();
  const [height, setHeight] = useState(26);
  const [failed, setFailed] = useState(false);
  const begin = useContext(MathLoading);
  const done = useRef<(() => void) | null>(null);
  const reported = () => done.current?.();
  useEffect(() => {
    if (!begin) return;
    const end = begin();
    done.current = end;
    return () => { end(); done.current = null; };
  }, [begin]);
  const font = proseCss(small, fontScale);
  const source = useMemo(() => ({
    html: `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-lh-size'; base-uri 'none'; form-action 'none'">
      <style>
        html,body { margin:0; padding:0; background:transparent; color:${c.text};
          font: ${font} system-ui,sans-serif; overflow-wrap:anywhere; }
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
      </style></head><body${hidden ? ' aria-hidden="true"' : ""}><div id="content">${renderMarkdown(parsed)}</div>
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
  }), [c, font, hidden, parsed]);
  if (failed) return <NativeMarkdown tokens={parsed.tokens} openLink={confirmExternalLink} small={small} />;

  // The local document reports its size and link taps. It cannot navigate or load external content.
  return (
    <WebView source={source} originWhitelist={["*"]} onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
      // An Android web view is its own accessibility node; a parent that hides its children doesn't reach it.
      {...(hidden ? { importantForAccessibility: "no-hide-descendants" as const, accessibilityElementsHidden: true, focusable: false } : {})}
      scrollEnabled={false} allowsLinkPreview={false} allowFileAccess={false} setSupportMultipleWindows={false} domStorageEnabled={false}
      style={{ backgroundColor: "transparent", height }} containerStyle={{ flex: 0, height }}
      onError={() => { setFailed(true); reported(); }} onRenderProcessGone={() => { setFailed(true); reported(); }}
      onMessage={({ nativeEvent }) => {
        // A height, which may be 0 for an empty block, or a tapped link.
        if (/^\d+$/.test(nativeEvent.data)) {
          const measured = Number(nativeEvent.data);
          if (measured > 0) setHeight(measured + 2);
          reported();
        } else confirmExternalLink(nativeEvent.data);
      }} />
  );
}
