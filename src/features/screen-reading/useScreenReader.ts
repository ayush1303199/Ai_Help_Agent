import { useCallback, useEffect, useState } from 'react';
import { writeAppState } from '../../config/appStateStorage.ts';
import { captureScreenForReading } from './screenReadingService';

interface UseScreenReaderOptions {
  storageKey?: string;
  disabled?: boolean;
  onError: (message: string) => void;
  onScreenCaptured: (image: string) => Promise<void>;
}

export function useScreenReader({
  storageKey = 'screen-reading-enabled',
  disabled = false,
  onError,
  onScreenCaptured,
}: UseScreenReaderOptions) {
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === 'true';
    } catch {
      return false;
    }
  });
  const [screenReading, setScreenReading] = useState(false);

  const readScreen = useCallback(async () => {
    if (!enabled || disabled || screenReading) return;
    if (!window.electronAPI?.captureScreen) {
      onError('Screen reading is available in the Electron desktop app.');
      return;
    }

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
      if (enabled && !disabled && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'r') {
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
  }, [disabled, enabled, readScreen]);

  const setEnabledState = useCallback((next: boolean) => {
    try {
      writeAppState(storageKey, String(next));
      setEnabled(next);
    } catch {
      onError('Screen-reading preference could not be saved because browser storage is unavailable.');
    }
  }, [onError, storageKey]);

  return { readScreen, screenReading, enabled, setEnabled: setEnabledState };
}
