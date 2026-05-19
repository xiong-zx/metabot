import { useEffect, useRef } from 'react';

interface Props {
  content: string;
}

/**
 * Render stored HTML inside a sandboxed iframe via srcDoc.
 * Deliberately omits `allow-scripts` — stored HTML is data, not code.
 */
export function HtmlDocFrame({ content }: Props) {
  const ref = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    const resize = () => {
      try {
        const h = iframe.contentDocument?.body?.scrollHeight;
        if (h && h > 0) iframe.style.height = `${Math.min(h + 16, 4000)}px`;
      } catch { /* cross-origin shouldn't happen with srcdoc, but be defensive */ }
    };
    iframe.addEventListener('load', resize);
    const t = window.setTimeout(resize, 100);
    return () => {
      iframe.removeEventListener('load', resize);
      window.clearTimeout(t);
    };
  }, [content]);

  return (
    <iframe
      ref={ref}
      title="document"
      srcDoc={content}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      className="doc-iframe"
    />
  );
}
