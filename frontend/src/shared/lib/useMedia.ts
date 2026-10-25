import { useEffect, useState } from 'react';

const DESKTOP = '(min-width: 768px)'; // Tailwind `md`

/** شاشة كبيرة (لوحات متجاورة) أم موبايل (لوحة واحدة في كل مرة). */
export function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(() => typeof window === 'undefined' || window.matchMedia(DESKTOP).matches);
  useEffect(() => {
    const media = window.matchMedia(DESKTOP);
    const onChange = () => setDesktop(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return desktop;
}
