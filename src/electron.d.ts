interface Window {
  electronAPI?: {
    openOverlay: () => Promise<void>;
    toggleOverlay: () => Promise<void>;
    closeOverlay: () => Promise<void>;
  };
}
