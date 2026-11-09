import { useEffect, useState, type ImgHTMLAttributes } from 'react';
import { getPlatformContext, getPlatformSignal, platformFetch } from './platform-context';

export default function ScopedImage({ src, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const context = getPlatformContext();
  const scoped = !!context && !!src?.startsWith('/api/gyms/' + encodeURIComponent(context.gymId) + '/');
  const [image, setImage] = useState<{ source: string; url: string } | null>(null);
  const contextSignal = getPlatformSignal();

  useEffect(() => {
    if (!scoped || !src) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, contextSignal]);
    let objectUrl: string | undefined;
    const clear = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = undefined;
      setImage(null);
    };
    signal.addEventListener('abort', clear, { once: true });
    setImage(null);
    void (async () => {
      const response = await platformFetch(src, { signal });
      if (!response.ok) return;
      const blob = await response.blob();
      if (signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setImage({ source: src, url: objectUrl });
    })().catch(() => {
      if (!signal.aborted) clear();
    });
    return () => {
      controller.abort();
      signal.removeEventListener('abort', clear);
    };
  }, [src, scoped, contextSignal]);

  return <img {...props} src={scoped ? (image?.source === src ? image?.url : undefined) : src} />;
}
