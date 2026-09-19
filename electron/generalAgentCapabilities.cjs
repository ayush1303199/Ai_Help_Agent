const RISK_LEVELS = Object.freeze([
  'READ_ONLY',
  'LOW_RISK',
  'USER_DATA',
  'EXTERNAL_COMMUNICATION',
  'FINANCIAL',
  'ACCOUNT_CHANGE',
  'DESTRUCTIVE',
]);

const PROVIDER_LIFECYCLES = Object.freeze([
  'AVAILABLE',
  'LOGIN_REQUIRED',
  'PERMISSION_REQUIRED',
  'TEMPORARILY_UNAVAILABLE',
  'AUTOMATION_BLOCKED',
  'CAPTCHA_REQUIRED',
  'UNSUPPORTED',
]);

const CAPABILITY_CATEGORIES = Object.freeze([
  'WEB_RESEARCH',
  'WEB_NAVIGATION',
  'INFORMATION_EXTRACTION',
  'WEB_COMPARISON',
  'SHOPPING',
  'GROCERY',
  'FOOD',
  'FOOD_RESEARCH',
  'PRODUCT_COMPARISON',
  'PRICE_TRACKING',
  'TRAVEL_RESEARCH',
  'BUS',
  'FLIGHT',
  'TRAIN',
  'HOTEL',
  'TAXI',
  'TRAVEL_BOOKING',
  'EMAIL',
  'MESSAGING',
  'SOCIAL_MEDIA',
  'COMMENTS',
  'NOTIFICATIONS',
  'CALENDAR',
  'MEETINGS',
  'REMINDERS',
  'TASKS',
  'DOCUMENTS',
  'PDF',
  'SPREADSHEET',
  'FORMS',
  'FILE_MANAGEMENT',
  'DESKTOP_APPS',
  'BROWSER',
  'COMMUNICATION_APPS',
  'DEVELOPMENT_APPS',
  'ACCOUNT_WORKFLOWS',
  'FORM_SUBMISSION',
  'AUTHENTICATED_WORKFLOW',
  'RESEARCH',
  'SUMMARIZATION',
  'COMPARISON',
  'MONITORING',
  'COMMERCE',
  'PAYMENTS_HANDOFF',
  'ORDERS',
  'RETURNS',
  'TRACKING',
  'GENERAL_COMPUTER_TASK',
]);

function capability(name, description, allowedActions, options = {}) {
  return {
    name,
    description,
    allowedActions: [...new Set(allowedActions)],
    riskLevel: options.riskLevel || 'READ_ONLY',
    requiredPermissions: [...new Set(options.requiredPermissions || [])],
    requiredConfirmation: Boolean(options.requiredConfirmation),
    supportedProviders: [...new Set(options.supportedProviders || [])],
    verificationStrategy: options.verificationStrategy || 'explicit-observation',
    recoveryStrategy: options.recoveryStrategy || 'replan-or-stop',
  };
}

const CAPABILITY_DEFINITIONS = [
  capability('WEB_RESEARCH', 'Collect information from approved web sources.', ['search', 'discover', 'extract', 'summarize'], { supportedProviders: ['isolated-browser'] }),
  capability('WEB_NAVIGATION', 'Navigate approved public web pages.', ['navigate', 'click', 'scroll', 'go_back', 'wait'], { supportedProviders: ['isolated-browser'] }),
  capability('INFORMATION_EXTRACTION', 'Extract bounded text and structured facts.', ['get_page', 'extract_text', 'screenshot'], { supportedProviders: ['isolated-browser', 'document-parser'] }),
  capability('WEB_COMPARISON', 'Compare evidence collected from multiple web sources.', ['search', 'compare', 'rank', 'summarize'], { supportedProviders: ['isolated-browser'] }),
  capability('SHOPPING', 'Research products and prepare shopping actions.', ['search', 'get_details', 'compare', 'prepare', 'track'], { supportedProviders: ['isolated-browser'] }),
  capability('GROCERY', 'Research groceries and prepare a delivery cart.', ['search', 'get_details', 'compare', 'prepare', 'track'], { supportedProviders: ['isolated-browser'] }),
  capability('FOOD', 'Discover food options and prepare an order.', ['search', 'get_details', 'compare', 'prepare', 'track'], { supportedProviders: ['isolated-browser'] }),
  capability('FOOD_RESEARCH', 'Find and compare food options without ordering or paying.', ['search', 'get_details', 'compare', 'extract', 'summarize'], { supportedProviders: ['isolated-browser'] }),
  capability('PRODUCT_COMPARISON', 'Compare products using explicit evidence and preferences.', ['search', 'get_details', 'compare', 'rank'], { supportedProviders: ['isolated-browser'] }),
  capability('PRICE_TRACKING', 'Monitor a price or availability signal.', ['discover', 'get_details', 'track'], { supportedProviders: ['isolated-browser', 'monitoring-scheduler'] }),
  capability('TRAVEL_RESEARCH', 'Research travel options without booking them.', ['search', 'get_details', 'compare', 'rank'], { supportedProviders: ['isolated-browser'] }),
  capability('BUS', 'Research and prepare bus travel options.', ['search', 'get_details', 'compare', 'prepare', 'track'], { supportedProviders: ['isolated-browser'] }),
  capability('FLIGHT', 'Research and prepare flight options.', ['search', 'get_details', 'compare', 'prepare', 'track'], { supportedProviders: ['isolated-browser'] }),
  capability('TRAIN', 'Research and prepare train options.', ['search', 'get_details', 'compare', 'prepare', 'track'], { supportedProviders: ['isolated-browser'] }),
  capability('HOTEL', 'Research and prepare hotel options.', ['search', 'get_details', 'compare', 'prepare', 'track'], { supportedProviders: ['isolated-browser'] }),
  capability('TAXI', 'Research and prepare taxi options.', ['search', 'get_details', 'compare', 'prepare', 'track'], { supportedProviders: ['isolated-browser'] }),
  capability('TRAVEL_BOOKING', 'Prepare and execute a travel booking after confirmation.', ['prepare', 'validate', 'requestConfirmation', 'execute', 'verify', 'cancel'], { riskLevel: 'FINANCIAL', requiredConfirmation: true, supportedProviders: ['isolated-browser'], verificationStrategy: 'booking-reference-or-confirmation-page' }),
  capability('EMAIL', 'Read, classify, summarize, and draft email.', ['read', 'search', 'summarize', 'draft', 'reply', 'send'], { riskLevel: 'USER_DATA', requiredPermissions: ['authenticated-communication'], supportedProviders: ['authenticated-communication'], recoveryStrategy: 'login-handoff-or-stop' }),
  capability('MESSAGING', 'Read and prepare messages in approved services.', ['read', 'search', 'draft', 'reply', 'send'], { riskLevel: 'USER_DATA', requiredPermissions: ['authenticated-communication'], supportedProviders: ['authenticated-communication'], recoveryStrategy: 'login-handoff-or-stop' }),
  capability('SOCIAL_MEDIA', 'Read social content and prepare posts or replies.', ['read', 'search', 'summarize', 'draft', 'reply', 'publish'], { riskLevel: 'USER_DATA', requiredPermissions: ['authenticated-communication'], supportedProviders: ['authenticated-communication'], recoveryStrategy: 'login-handoff-or-stop' }),
  capability('COMMENTS', 'Read and draft responses to comments.', ['read', 'summarize', 'draft', 'reply'], { riskLevel: 'USER_DATA', requiredPermissions: ['authenticated-communication'], supportedProviders: ['authenticated-communication'] }),
  capability('NOTIFICATIONS', 'Read and summarize notifications.', ['read', 'search', 'summarize'], { riskLevel: 'USER_DATA', requiredPermissions: ['authenticated-communication'], supportedProviders: ['authenticated-communication'] }),
  capability('CALENDAR', 'Read availability and prepare calendar changes.', ['read', 'search', 'find_free_time', 'prepare', 'create', 'reschedule', 'cancel'], { riskLevel: 'USER_DATA', requiredPermissions: ['authenticated-communication'], supportedProviders: ['authenticated-communication'], recoveryStrategy: 'verify-event-or-stop' }),
  capability('MEETINGS', 'Prepare meetings using calendar and communication capabilities.', ['read', 'find_free_time', 'prepare', 'create', 'reschedule', 'cancel'], { riskLevel: 'USER_DATA', requiredPermissions: ['authenticated-communication'], supportedProviders: ['authenticated-communication'] }),
  capability('REMINDERS', 'Prepare visible reminder tasks.', ['prepare', 'create', 'cancel'], { riskLevel: 'USER_DATA', requiredPermissions: ['scheduler'], supportedProviders: ['monitoring-scheduler'] }),
  capability('TASKS', 'Prepare visible task-list changes.', ['read', 'prepare', 'create', 'complete', 'cancel'], { riskLevel: 'USER_DATA', requiredPermissions: ['scheduler'], supportedProviders: ['monitoring-scheduler'] }),
  capability('DOCUMENTS', 'Read and transform user-approved documents.', ['read', 'extract', 'summarize', 'compare', 'create'], { riskLevel: 'USER_DATA', requiredPermissions: ['document-access'], supportedProviders: ['document-parser', 'local-file-session'] }),
  capability('PDF', 'Extract bounded text and facts from PDF files.', ['read', 'extract', 'summarize', 'compare'], { riskLevel: 'USER_DATA', requiredPermissions: ['document-access'], supportedProviders: ['document-parser', 'local-file-session'] }),
  capability('SPREADSHEET', 'Prepare structured spreadsheet data.', ['read', 'extract', 'compare', 'create'], { riskLevel: 'USER_DATA', requiredPermissions: ['document-access'], supportedProviders: ['document-parser', 'local-file-session'] }),
  capability('FORMS', 'Understand and fill safe form fields before submission.', ['read', 'prepare', 'fill', 'validate', 'submit'], { riskLevel: 'USER_DATA', requiredPermissions: ['browser-session'], supportedProviders: ['isolated-browser'], recoveryStrategy: 'pause-before-submit-or-stop' }),
  capability('FILE_MANAGEMENT', 'Find and prepare changes to user-selected files.', ['find', 'read', 'prepare', 'rename', 'organize'], { riskLevel: 'USER_DATA', requiredPermissions: ['file-access'], supportedProviders: ['local-file-session'] }),
  capability('DESKTOP_APPS', 'Use an explicit allowlist of desktop applications.', ['open', 'focus', 'screenshot', 'wait'], { riskLevel: 'LOW_RISK', requiredPermissions: ['desktop-allowlist'], supportedProviders: ['controlled-desktop'] }),
  capability('BROWSER', 'Use an isolated browser session with structured actions.', ['navigate', 'get_page', 'extract_text', 'click', 'type', 'scroll', 'go_back', 'wait', 'screenshot'], { riskLevel: 'LOW_RISK', requiredPermissions: ['browser-session'], supportedProviders: ['isolated-browser'] }),
  capability('COMMUNICATION_APPS', 'Open approved communication applications without unrestricted control.', ['open', 'focus', 'read', 'draft'], { riskLevel: 'USER_DATA', requiredPermissions: ['desktop-allowlist'], supportedProviders: ['controlled-desktop'] }),
  capability('DEVELOPMENT_APPS', 'Open approved development applications for inspection or handoff.', ['open', 'focus', 'screenshot'], { riskLevel: 'LOW_RISK', requiredPermissions: ['desktop-allowlist'], supportedProviders: ['controlled-desktop'] }),
  capability('ACCOUNT_WORKFLOWS', 'Handle authenticated account workflows through user-controlled handoff.', ['login_handoff', 'prepare', 'validate', 'verify'], { riskLevel: 'ACCOUNT_CHANGE', requiredConfirmation: true, requiredPermissions: ['browser-session'], supportedProviders: ['isolated-browser'], recoveryStrategy: 'login-handoff-or-stop' }),
  capability('FORM_SUBMISSION', 'Submit a prepared form only after explicit confirmation.', ['prepare', 'requestConfirmation', 'submit', 'verify'], { riskLevel: 'EXTERNAL_COMMUNICATION', requiredConfirmation: true, requiredPermissions: ['browser-session'], supportedProviders: ['isolated-browser'], verificationStrategy: 'result-page-or-reference' }),
  capability('AUTHENTICATED_WORKFLOW', 'Run a user-authenticated workflow without exposing credentials.', ['login_handoff', 'read', 'prepare', 'verify'], { riskLevel: 'USER_DATA', requiredPermissions: ['authenticated-communication'], supportedProviders: ['authenticated-communication'], recoveryStrategy: 'login-handoff-or-stop' }),
  capability('RESEARCH', 'Collect, deduplicate, compare, and summarize evidence.', ['search', 'collect', 'deduplicate', 'compare', 'summarize'], { supportedProviders: ['isolated-browser', 'document-parser'] }),
  capability('SUMMARIZATION', 'Summarize bounded, user-approved content.', ['summarize'], { riskLevel: 'USER_DATA', supportedProviders: ['isolated-browser', 'document-parser', 'authenticated-communication'] }),
  capability('COMPARISON', 'Rank options using explicit user preferences and evidence.', ['compare', 'rank', 'summarize'], { supportedProviders: ['isolated-browser', 'document-parser'] }),
  capability('MONITORING', 'Run visible, bounded, information-only monitoring tasks.', ['discover', 'track', 'verify'], { supportedProviders: ['isolated-browser', 'monitoring-scheduler'] }),
  capability('COMMERCE', 'Prepare commerce actions while keeping financial execution gated.', ['search', 'compare', 'prepare', 'requestConfirmation', 'execute', 'verify', 'track'], { riskLevel: 'FINANCIAL', requiredConfirmation: true, supportedProviders: ['isolated-browser'], verificationStrategy: 'order-reference-or-status-page' }),
  capability('PAYMENTS_HANDOFF', 'Hand payment entry to the user without exposing payment data to the model.', ['prepare', 'payment_handoff', 'verify'], { riskLevel: 'FINANCIAL', requiredConfirmation: true, requiredPermissions: ['user-payment-handoff'], supportedProviders: ['isolated-browser'], verificationStrategy: 'payment-status-only', recoveryStrategy: 'unknown-result-stop' }),
  capability('ORDERS', 'Prepare, track, and verify orders without duplicate submission.', ['prepare', 'requestConfirmation', 'execute', 'verify', 'track', 'cancel'], { riskLevel: 'FINANCIAL', requiredConfirmation: true, supportedProviders: ['isolated-browser'], verificationStrategy: 'order-reference-or-status-page', recoveryStrategy: 'check-existing-result-before-retry' }),
  capability('RETURNS', 'Prepare a return or cancellation for user approval.', ['discover', 'prepare', 'requestConfirmation', 'execute', 'verify'], { riskLevel: 'EXTERNAL_COMMUNICATION', requiredConfirmation: true, supportedProviders: ['isolated-browser'] }),
  capability('TRACKING', 'Read order or booking status without changing external state.', ['read', 'track', 'verify'], { riskLevel: 'USER_DATA', supportedProviders: ['isolated-browser'] }),
  capability('GENERAL_COMPUTER_TASK', 'Route an otherwise uncategorized bounded computer task.', ['open', 'focus', 'click', 'type', 'keypress', 'scroll', 'screenshot', 'wait'], { riskLevel: 'LOW_RISK', requiredPermissions: ['desktop-allowlist'], supportedProviders: ['controlled-desktop'] }),
];

const DEFAULT_PROVIDER_DEFINITIONS = [
  {
    providerId: 'isolated-browser',
    displayName: 'Isolated browser session',
    description: 'Provider slot for a task-scoped browser context; no personal cookies are imported.',
    capabilities: ['BROWSER', 'WEB_RESEARCH', 'WEB_NAVIGATION', 'INFORMATION_EXTRACTION', 'WEB_COMPARISON', 'SHOPPING', 'GROCERY', 'FOOD', 'FOOD_RESEARCH', 'PRODUCT_COMPARISON', 'PRICE_TRACKING', 'TRAVEL_RESEARCH', 'BUS', 'FLIGHT', 'TRAIN', 'HOTEL', 'TAXI', 'TRAVEL_BOOKING', 'FORMS', 'ACCOUNT_WORKFLOWS', 'FORM_SUBMISSION', 'MONITORING', 'COMMERCE', 'PAYMENTS_HANDOFF', 'ORDERS', 'RETURNS', 'TRACKING'],
    lifecycle: 'AVAILABLE',
    implemented: true,
    supportsFallback: true,
  },
  {
    providerId: 'controlled-desktop',
    displayName: 'Controlled desktop session',
    description: 'Provider slot for explicit application allowlist actions.',
    capabilities: ['DESKTOP_APPS', 'COMMUNICATION_APPS', 'DEVELOPMENT_APPS', 'GENERAL_COMPUTER_TASK'],
    lifecycle: 'AVAILABLE',
    implemented: false,
    supportsFallback: false,
  },
  {
    providerId: 'authenticated-communication',
    displayName: 'Authenticated communication session',
    description: 'Provider slot requiring user-controlled login handoff.',
    capabilities: ['EMAIL', 'MESSAGING', 'SOCIAL_MEDIA', 'COMMENTS', 'NOTIFICATIONS', 'CALENDAR', 'MEETINGS', 'AUTHENTICATED_WORKFLOW', 'SUMMARIZATION'],
    lifecycle: 'LOGIN_REQUIRED',
    implemented: false,
    supportsFallback: false,
  },
  {
    providerId: 'document-parser',
    displayName: 'Bounded document parser',
    description: 'Provider slot for user-approved document extraction.',
    capabilities: ['INFORMATION_EXTRACTION', 'DOCUMENTS', 'PDF', 'SPREADSHEET', 'RESEARCH', 'SUMMARIZATION', 'COMPARISON'],
    lifecycle: 'AVAILABLE',
    implemented: false,
    supportsFallback: false,
  },
  {
    providerId: 'local-file-session',
    displayName: 'User-approved file session',
    description: 'Provider slot for explicitly selected local files, separate from Developer project access.',
    capabilities: ['DOCUMENTS', 'PDF', 'SPREADSHEET', 'FILE_MANAGEMENT'],
    lifecycle: 'PERMISSION_REQUIRED',
    implemented: false,
    supportsFallback: false,
  },
  {
    providerId: 'monitoring-scheduler',
    displayName: 'Visible monitoring scheduler',
    description: 'Provider slot for bounded, user-visible recurring information checks.',
    capabilities: ['PRICE_TRACKING', 'REMINDERS', 'TASKS', 'MONITORING'],
    lifecycle: 'PERMISSION_REQUIRED',
    implemented: false,
    supportsFallback: false,
  },
];

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function validateCapability(definition) {
  if (!definition || typeof definition !== 'object' || !CAPABILITY_CATEGORIES.includes(definition.name)) {
    throw new Error('Invalid General Agent capability name.');
  }
  if (!definition.description || !Array.isArray(definition.allowedActions) || !Array.isArray(definition.supportedProviders)) {
    throw new Error(`Capability ${definition.name} is missing required metadata.`);
  }
  if (!RISK_LEVELS.includes(definition.riskLevel)) throw new Error(`Capability ${definition.name} has an invalid risk level.`);
  return clone(definition);
}

function validateProvider(definition) {
  if (!definition || typeof definition !== 'object' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(definition.providerId || '')) {
    throw new Error('Invalid General Agent provider id.');
  }
  if (!Array.isArray(definition.capabilities) || definition.capabilities.some((name) => !CAPABILITY_CATEGORIES.includes(name))) {
    throw new Error(`Provider ${definition.providerId} has invalid capabilities.`);
  }
  if (!PROVIDER_LIFECYCLES.includes(definition.lifecycle)) throw new Error(`Provider ${definition.providerId} has an invalid lifecycle.`);
  return {
    providerId: definition.providerId,
    displayName: String(definition.displayName || definition.providerId).slice(0, 120),
    description: String(definition.description || '').slice(0, 500),
    capabilities: [...new Set(definition.capabilities)],
    lifecycle: definition.lifecycle,
    implemented: Boolean(definition.implemented),
    supportsFallback: definition.supportsFallback !== false,
  };
}

class GeneralCapabilityRegistry {
  constructor() {
    this.capabilities = new Map(CAPABILITY_DEFINITIONS.map((definition) => [definition.name, validateCapability(definition)]));
    this.providers = new Map(DEFAULT_PROVIDER_DEFINITIONS.map((definition) => [definition.providerId, validateProvider(definition)]));
  }

  registerCapability(definition) {
    const validated = validateCapability(definition);
    this.capabilities.set(validated.name, validated);
    return clone(validated);
  }

  registerProvider(definition) {
    const validated = validateProvider(definition);
    this.providers.set(validated.providerId, validated);
    return clone(validated);
  }

  setProviderLifecycle(providerId, lifecycle) {
    if (!this.providers.has(providerId)) throw new Error(`Unknown General Agent provider: ${providerId}.`);
    if (!PROVIDER_LIFECYCLES.includes(lifecycle)) throw new Error(`Invalid provider lifecycle: ${lifecycle}.`);
    const provider = this.providers.get(providerId);
    provider.lifecycle = lifecycle;
    return clone(provider);
  }

  getCapability(name) {
    const definition = this.capabilities.get(name);
    return definition ? clone(definition) : null;
  }

  listCapabilities() {
    return [...this.capabilities.values()].map(clone);
  }

  getProvider(providerId) {
    const provider = this.providers.get(providerId);
    return provider ? clone(provider) : null;
  }

  listProviders() {
    return [...this.providers.values()].map(clone);
  }

  getProviderCandidates(capabilityName) {
    const definition = this.capabilities.get(capabilityName);
    if (!definition) throw new Error(`Unknown General Agent capability: ${capabilityName}.`);
    return definition.supportedProviders
      .map((providerId) => this.providers.get(providerId))
      .filter(Boolean)
      .map((provider) => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        lifecycle: provider.lifecycle,
        implemented: provider.implemented,
        ready: provider.implemented && provider.lifecycle === 'AVAILABLE',
        supportsFallback: provider.supportsFallback,
      }))
      .sort((left, right) => Number(right.ready) - Number(left.ready) || left.lifecycle.localeCompare(right.lifecycle));
  }

  route(capabilityNames) {
    return [...new Set(capabilityNames)]
      .filter((name) => this.capabilities.has(name))
      .map((name) => {
        const definition = this.capabilities.get(name);
        return {
          capability: name,
          description: definition.description,
          allowedActions: [...definition.allowedActions],
          riskLevel: definition.riskLevel,
          requiredPermissions: [...definition.requiredPermissions],
          requiredConfirmation: definition.requiredConfirmation,
          verificationStrategy: definition.verificationStrategy,
          recoveryStrategy: definition.recoveryStrategy,
          providerCandidates: this.getProviderCandidates(name),
        };
      });
  }

  resetForTest() {
    this.capabilities = new Map(CAPABILITY_DEFINITIONS.map((definition) => [definition.name, validateCapability(definition)]));
    this.providers = new Map(DEFAULT_PROVIDER_DEFINITIONS.map((definition) => [definition.providerId, validateProvider(definition)]));
  }
}

const registry = new GeneralCapabilityRegistry();

module.exports = {
  RISK_LEVELS,
  PROVIDER_LIFECYCLES,
  CAPABILITY_CATEGORIES,
  GeneralCapabilityRegistry,
  getCapabilityRegistry: () => registry,
  getCapabilityCatalog: () => registry.listCapabilities(),
  getProviderCatalog: () => registry.listProviders(),
  routeCapabilities: (names) => registry.route(names),
};
