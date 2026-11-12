/**
 * Pauses all other audio or video elements on the page except the one currently active.
 * Ensures only one audio or video plays at a time.
 */
export function pauseOtherMedia(activeMedia: HTMLMediaElement): void {
  if (typeof document === 'undefined') return;
  const allMedia = document.querySelectorAll<HTMLMediaElement>('audio, video');
  allMedia.forEach(media => {
    if (media !== activeMedia && !media.paused) {
      try {
        media.pause();
      } catch {
        // Ignore playback pause errors
      }
    }
  });
}
