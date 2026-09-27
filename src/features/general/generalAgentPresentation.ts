export function generalUserFailureMessage(category?: string | null) {
  if (category === 'TOOL_COMPATIBILITY') {
    return 'The selected AI model cannot use the required browsing operation right now. I am not claiming the task is complete.';
  }
  if (category === 'RATE_LIMIT') {
    return 'The AI provider is temporarily unavailable. The task was not completed.';
  }
  if (category === 'CONTEXT_TOO_LARGE' || category === 'BLOCKED_CONTEXT_LIMIT') {
    return 'The request was too large for the current model. I reduced the context and retried safely.';
  }
  if (category === 'SECURITY_BLOCK' || category === 'CAPTCHA' || category === 'BLOCKED_PAGE') {
    return 'I encountered a security block while checking that site. Let me try another way.';
  }
  return 'The AI provider could not complete this request. I am not claiming the task is complete.';
}

export function generalUserProgressMessage(message?: string | null) {
  if (!message) return 'Working on it now.';
  const normalized = message
    .replace(/\bPLANNING\b/gi, 'Checking the request')
    .replace(/\bEXECUTING\b/gi, 'Taking the next step')
    .replace(/\bOBSERVING\b/gi, 'Reviewing the result')
    .replace(/\bVERIFYING\b/gi, 'Confirming the result')
    .replace(/\bPENDING\b/gi, 'In progress')
    .replace(/\bRETRYING\b/gi, 'Retrying safely')
    .replace(/\bWAITING_FOR_CONFIRMATION\b/gi, 'Awaiting your confirmation');
  return normalized.trim() || 'Working on it now.';
}

export function generalUserStatus(task: GeneralTaskState) {
  if (task.phase === 'WAITING_FOR_CONFIRMATION') return 'Confirmation required';
  if (task.phase === 'COMPLETED' || task.phase === 'COMPLETED_WITH_LIMITATIONS') return 'Done';
  if (task.phase === 'FAILED') return 'Could not complete';
  if (task.phase === 'BLOCKED') return 'Blocked safely';
  if (task.phase === 'CANCELLED') return 'Stopped';
  return generalUserProgressMessage(task.progressMessage);
}

export function generalSafeObservationSummary(observation: Record<string, unknown> | null | undefined) {
  if (!observation) return 'I checked the relevant page and am narrowing the best result.';
  const title = typeof observation.title === 'string' && observation.title.trim() ? observation.title.trim() : null;
  const url = typeof observation.url === 'string' ? observation.url.toLowerCase() : '';
  const results = Array.isArray(observation.results) ? observation.results : [];
  const pageState = typeof observation.pageState === 'string' ? observation.pageState : null;
  const errorState = observation.errorState && typeof observation.errorState === 'object'
    ? observation.errorState as Record<string, unknown>
    : null;
  let message = 'I checked the relevant page and narrowed it to the best option.';
  if (errorState && typeof errorState.message === 'string' && errorState.message.trim()) {
    message = errorState.message.trim();
  } else if (pageState === 'BLOCKED' || pageState === 'SECURITY_BLOCK') {
    message = 'The page blocked automated access, so I switched to a safer option.';
  } else if (
    (url.includes('google.com/search')
      || url.includes('bing.com/search')
      || url.includes('duckduckgo.com/?q=')
      || url.includes('duckduckgo.com/html/?q=')
      || url.includes('search.yahoo.com/search'))
    && results.length === 0
  ) {
    message = 'The search page did not expose usable result cards, so I have not treated it as a course result.';
  } else if (title) {
    message = `I checked ${title} and narrowed it to the most relevant result.`;
  }
  return message;
}
