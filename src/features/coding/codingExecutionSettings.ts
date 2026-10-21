export type CodingExecutionMode = 'inline_review' | 'autonomous_auto_apply';

export interface CodingExecutionSettings {
  executionMode: CodingExecutionMode;
  autoAuthorizeAttachedProject: boolean;
}

const SETTINGS_KEY = 'coding-execution-settings-v1';

export const DEFAULT_CODING_EXECUTION_SETTINGS: CodingExecutionSettings = {
  executionMode: 'inline_review',
  autoAuthorizeAttachedProject: true,
};

export function readCodingExecutionSettings(): CodingExecutionSettings {
  try {
    const value = localStorage.getItem(SETTINGS_KEY);
    if (!value) return DEFAULT_CODING_EXECUTION_SETTINGS;
    const parsed = JSON.parse(value) as Partial<CodingExecutionSettings>;
    return {
      executionMode: parsed.executionMode === 'autonomous_auto_apply'
        ? 'autonomous_auto_apply'
        : 'inline_review',
      autoAuthorizeAttachedProject: parsed.autoAuthorizeAttachedProject !== false,
    };
  } catch {
    return DEFAULT_CODING_EXECUTION_SETTINGS;
  }
}

export function writeCodingExecutionSettings(settings: CodingExecutionSettings): boolean {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}
