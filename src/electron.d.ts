interface Window {
  electronAPI?: {
    openOverlay: () => Promise<void>;
    toggleOverlay: () => Promise<void>;
    closeOverlay: () => Promise<void>;
    chooseDeveloperProject: () => Promise<{ canceled: boolean; projectRoot: string | null }>;
    clearDeveloperProject: () => Promise<void>;
    listDeveloperDirectory: (relativePath?: string) => Promise<Array<{ name: string; type: 'file' | 'directory' }>>;
    readDeveloperFile: (relativePath: string) => Promise<{ path: string; content: string }>;
    searchDeveloperCode: (query: string) => Promise<{ query: string; results: Array<{ path: string; line: number; text: string; matchType: 'filename' | 'content' }>; filesVisited: number; truncated: boolean }>;
  };
}
