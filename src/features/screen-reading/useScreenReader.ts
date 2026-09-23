import { useCallback, useEffect, useState } from 'react';
import { captureScreenForReading } from './screenReadingService';

interface UseScreenReaderOptions {
  disabled?: boolean;
  onError: (message: string) => void;
  onScreenCaptured: (image: string) => Promise<void>;
}

export function useScreenReader({
  disabled = false,
  onError,
  onScreenCaptured,
}: UseScreenReaderOptions) {
  const [enabled, setEnabled] = useState(() => localStorage.getItem('screen-reading-enabled') === 'true');
  const [screenReading, setScreenReading] = useState(false);

  const readScreen = useCallback(async () => {
    if (!enabled || disabled || screenReading || !window.electronAPI?.captureScreen) return;

    setScreenReading(true);
    onError('');
    try {
      const image = await captureScreenForReading();
      await onScreenCaptured(image);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not read the shared screen.');
    } finally {
      setScreenReading(false);
    }
  }, [disabled, enabled, onError, onScreenCaptured, screenReading]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (enabled && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        void readScreen();
      }
    };
    window.addEventListener('keydown', onShortcut);
    const removeElectronShortcut = window.electronAPI?.onScreenReadShortcut?.(() => {
      void readScreen();
    });

    return () => {
      window.removeEventListener('keydown', onShortcut);
      removeElectronShortcut?.();
    };
  }, [enabled, readScreen]);

  const setEnabledState = useCallback((next: boolean) => {
    setEnabled(next);
    localStorage.setItem('screen-reading-enabled', String(next));
  }, []);

  return { readScreen, screenReading, enabled, setEnabled: setEnabledState };
}
