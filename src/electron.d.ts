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
    buildDeveloperIndex: () => Promise<{ capabilities: { parser: string; typeResolution: boolean; guaranteedCallGraph: boolean; supportedExtensions: string[] }; files: string[]; cacheHits: number }>;
    searchDeveloperSymbols: (query: string) => Promise<Array<{ name: string; path: string; line: number; kind: string }>>;
    assembleDeveloperContext: (payload: { query: string; maxTokens?: number }) => Promise<{ tokenCount: number; budget: number; items: unknown[]; diversity: number; cached: boolean }>;
    runDeveloperVerification: (script: string) => Promise<{ ok: boolean; script: string; exitCode: number | null; stdout: string; stderr: string; durationMs: number }>;
    inspectDeveloperGit: (kind: 'status' | 'diff') => Promise<{ args: string[]; stdout: string; stderr: string }>;
    createDeveloperProposal: (raw: string, snapshots: Array<{ path: string; hash: string }>, verificationScript?: string | null) => Promise<{ id: string; state: string; lifecycleState?: string; files: Array<{ path: string; hash: string }> }>;
    approveDeveloperProposal: (id: string) => Promise<{ id: string; state: string }>;
    applyDeveloperProposal: (id: string) => Promise<{ id: string; state: string }>;
    undoDeveloperProposal: (id: string) => Promise<{ id: string; state: string }>;
    getDeveloperProposal: (id: string) => Promise<{ id: string; state: string }>;
    getDeveloperSession: () => Promise<{ sessionId: string }>;
    resumeDeveloperSession: (sessionId: string) => Promise<{ sessionId: string }>;
    cancelDeveloperTask: () => Promise<void>;
  };
}
