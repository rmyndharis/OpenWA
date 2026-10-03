import { useEffect } from 'react';

/**
 * Custom hook to set document title dynamically.
 * Automatically appends the " | XenWA" suffix.
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${title} | XenWA`;

    return () => {
      document.title = previousTitle;
    };
  }, [title]);
}
