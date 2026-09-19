const {
  CAPABILITY_CATEGORIES,
  getCapabilityRegistry,
} = require('./generalAgentCapabilities.cjs');

const RANKING_MODES = Object.freeze([
  'CHEAPEST',
  'BEST_VALUE',
  'BEST_RATED',
  'FASTEST',
  'MOST_CONVENIENT',
  'BEST_MATCH',
]);

const CATEGORY_RULES = [
  ['GROCERY', /\b(grocer(?:y|ies)|blinkit|zepto|vegetables?|household supplies?)\b/i],
  ['FOOD_RESEARCH', /\b(pizza|biryani|chawal|rice|restaurant|meal|food|menu|swiggy|zomato)\b/i],
  ['FOOD', /\b(food|biryani|chawal|rice|restaurant|meal|swiggy|zomato|menu|delivery)\b/i],
  ['SHOPPING', /\b(shop|shopping|buy|purchase|product|amazon|order|cart|return)\b/i],
  ['PRODUCT_COMPARISON', /\b(compare|comparison|alternative|which (one|is) best|good quality)\b/i],
  ['BUS', /\b(bus(?:es)?|redbus|coach)\b/i],
  ['FLIGHT', /\b(flight|airline|airport|fly)\b/i],
  ['TRAIN', /\b(train|railway)\b/i],
  ['HOTEL', /\b(hotel|stay|room|accommodation)\b/i],
  ['TAXI', /\b(taxi|cab|uber|ola)\b/i],
  ['TRAVEL_BOOKING', /\b(book|reserve|booking|ticket)\b/i],
  ['TRAVEL_RESEARCH', /\b(travel|journey|trip|departure|arrival)\b/i],
  ['EMAIL', /\b(email|emails|mail|inbox|recruiter)\b/i],
  ['MESSAGING', /\b(message|messages|chat|teams|slack|whatsapp)\b/i],
  ['SOCIAL_MEDIA', /\b(linkedin|youtube|instagram|facebook|social|post|publish)\b/i],
  ['COMMENTS', /\b(comment|comments|reply to)\b/i],
  ['CALENDAR', /\b(calendar|schedule|availability|free time|meeting|appointment)\b/i],
  ['REMINDERS', /\b(remind|reminder|tomorrow)\b/i],
  ['FORMS', /\b(form|application|fill in|fill out)\b/i],
  ['PDF', /\b(pdf|invoice|report)\b/i],
  ['SPREADSHEET', /\b(spreadsheet|excel|xlsx|csv|table)\b/i],
  ['DOCUMENTS', /\b(document|docx|file|files|paper)\b/i],
  ['FILE_MANAGEMENT', /\b(file explorer|find file|organize files|rename files|downloaded)\b/i],
  ['DEVELOPMENT_APPS', /\b(vs code|visual studio code|project|codebase|repository)\b/i],
  ['COMMUNICATION_APPS', /\b(open teams|open slack|communication app)\b/i],
  ['DESKTOP_APPS', /\b(open chrome|open edge|open vs code|open notepad|open file explorer|desktop app)\b/i],
  ['MONITORING', /\b(track|monitor|watch|check every|each day|availability)\b/i],
  ['WEB_RESEARCH', /\b(research|look up|find|search|deadline|tell me about)\b/i],
  ['WEB_NAVIGATION', /\b(open|visit|website|web page|browser)\b/i],
  ['SUMMARIZATION', /\b(summar(?:y|ize)|important|extract the key|tell me what)\b/i],
  ['COMPARISON', /\b(compare|comparison|cheapest|best value|best rated|fastest)\b/i],
  ['PRICE_TRACKING', /\b(?:track|monitor|alert|notify|watch)\b.{0,24}\b(?:price|cost|availability)\b|\b(?:price|cost)\b.{0,24}\b(?:drop|change|alert|tracking)\b/i],
];

const ACTION_PATTERNS = Object.freeze({
  destructive: /\b(delete|remove|erase|destroy|cancel account)\b/i,
  financial: /\b(buy|purchase|pay|checkout|order|book|booking|reserve|ticket|payment)\b/i,
  communication: /\b(send|publish|post|reply|comment|submit|share)\b/i,
  account: /\b(change password|account setting|authorize|connect account|sign in|log in|login)\b/i,
  userData: /\b(read|check|summarize|organize|download|calendar|email|message|file)\b/i,
});

const ACTION_ALIASES = Object.freeze([
  ['BOOK', /\b(book|booking|reserve|reservation|ticket)\b/i],
  ['PAY', /\b(pay|payment|checkout)\b/i],
  ['PURCHASE', /\b(buy|purchase|order)\b/i],
  ['COMMUNICATE', /\b(send|publish|post|reply|comment|share)\b/i],
  ['SUBMIT', /\b(submit|fill out|fill in)\b/i],
  ['DELETE', /\b(delete|remove|erase|destroy|cancel account)\b/i],
]);

const NEGATION_SEGMENT_PATTERN = /\b(?:do\s+not|don't|dont|never|without|no)\b([^.!?;]*)/gi;
const SEMANTIC_INTENTS = Object.freeze([
  'RESEARCH',
  'PREPARE',
  'EXECUTE',
  'REFINE',
  'CANCEL',
  'CLARIFY',
  'COMPARE',
  'SUMMARIZE',
  'MONITOR',
]);

function negationSegments(text) {
  return [...normalizedText(text).matchAll(NEGATION_SEGMENT_PATTERN)].map((match) => match[1] || '');
}

function extractForbiddenActions(text) {
  const segments = negationSegments(text);
  return ACTION_ALIASES
    .filter(([, pattern]) => segments.some((segment) => pattern.test(segment)))
    .map(([action]) => action);
}

function extractActionIntent(text, categories = []) {
  const normalized = normalizedText(text);
  const forbiddenActions = extractForbiddenActions(normalized);
  const hasActive = (pattern, actions) => pattern.test(normalized)
    && actions.some((action) => {
      const alias = ACTION_ALIASES.find(([name]) => name === action);
      return alias && alias[1].test(normalized) && !forbiddenActions.includes(action);
    });
  const hasPrepare = /\b(prepare|draft|set up|ready for)\b/i.test(normalized)
    || /\b(?:create|make)\b.{0,24}\b(?:spreadsheet|sheet|table|document|report|file)\b/i.test(normalized);
  const hasExecute = [
    [ACTION_PATTERNS.destructive, ['DELETE']],
    [ACTION_PATTERNS.financial, ['BOOK', 'PAY', 'PURCHASE']],
    [ACTION_PATTERNS.communication, ['COMMUNICATE', 'SUBMIT']],
  ].some(([pattern, actions]) => hasActive(pattern, actions));
  const hasResearch = /\b(find|search|compare|show|research|look up|read|check|summarize|open|inspect|track|discover)\b/i.test(normalized);
  const actionIntent = hasExecute ? 'EXECUTE' : hasPrepare ? 'PREPARE' : hasResearch ? 'RESEARCH' : 'RESEARCH';
  const commercial = categories.some((category) => ['SHOPPING', 'GROCERY', 'FOOD', 'BUS', 'FLIGHT', 'TRAIN', 'HOTEL', 'TAXI', 'TRAVEL_BOOKING', 'COMMERCE', 'ORDERS'].includes(category));
  const executionPolicy = actionIntent === 'RESEARCH' && !commercial ? 'READ_ONLY' : 'PREPARE_ONLY';
  const allowedActions = actionIntent === 'EXECUTE'
    ? ['SEARCH', 'COMPARE', 'SHOW', 'PREPARE', 'CONFIRM', 'EXECUTE']
    : actionIntent === 'PREPARE'
      ? ['SEARCH', 'COMPARE', 'SHOW', 'PREPARE', 'CONFIRM']
      : ['SEARCH', 'COMPARE', 'SHOW'];
  return {
    actionIntent,
    allowedActions,
    forbiddenActions,
    executionPolicy,
    autonomyLevel: actionIntent === 'EXECUTE' ? 'CONFIRM_BEFORE_ACTION' : executionPolicy,
    confirmationRequired: actionIntent !== 'RESEARCH' || commercial,
  };
}

function classifyIntent(text, action = extractActionIntent(text)) {
  const normalized = normalizedText(text);
  if (/\b(?:cancel|abort|never mind|forget it)\b/i.test(normalized)
    || /\bstop\s+(?:this|the task|the agent|it)\b/i.test(normalized)
    || /^\s*stop\s*$/i.test(normalized)) return 'CANCEL';
  if (action.actionIntent === 'EXECUTE') return 'EXECUTE';
  if (/\b(?:what do you mean|which one|clarify|can you explain|more information)\b/i.test(normalized)) return 'CLARIFY';
  if (/\b(?:make it|change (?:the|to)|actually|instead|prefer|only after|same (?:destination|date)|use the previous)\b/i.test(normalized)) return 'REFINE';
  if (/\b(?:compare|comparison|versus|vs\.?|first and third)\b/i.test(normalized)) return 'COMPARE';
  if (/\b(?:summari[sz]e|summary|important points|key points)\b/i.test(normalized)
    || /\b(?:read|check|review)\b.*\b(?:email|emails|inbox|messages?)\b/i.test(normalized)) return 'SUMMARIZE';
  if (/\b(?:monitor|alert|notify|watch|track)\b/i.test(normalized)) return 'MONITOR';
  if (action.actionIntent === 'PREPARE') return 'PREPARE';
  return 'RESEARCH';
}

function extractReferences(text) {
  const normalized = normalizedText(text);
  const match = normalized.match(/\b(the first one|the second one|the third one|the first|the second|the third|the last one|the last|that one|this one|that hotel|that bus|that flight|the cheaper (?:one|bus|option)|the cheapest (?:one|bus|option)|the (?:ac|sleeper) one|the previous (?:result|flight|bus|hotel|option)|the one you recommended)\b/i);
  if (!match) return [];
  return [{ phrase: match[0], status: /\b(first|second|third|last)\b/i.test(match[0]) ? 'ORDINAL' : 'CONTEXTUAL' }];
}

function resolveReference(text, candidates = []) {
  const reference = extractReferences(text)[0];
  if (!reference) return { status: 'NONE' };
  const options = Array.isArray(candidates) ? candidates : [];
  const ordinal = reference.phrase.match(/\b(first|second|third|last)\b/i)?.[1]?.toLowerCase();
  if (ordinal) {
    if (options.length === 0) return { status: 'PENDING_CONTEXT', phrase: reference.phrase, reason: 'Task memory has no prior options to resolve this reference.' };
    const index = { first: 0, second: 1, third: 2, last: options.length - 1 }[ordinal];
    if (index >= 0 && index < options.length) return { status: 'RESOLVED', phrase: reference.phrase, index };
    return { status: 'UNRESOLVED', phrase: reference.phrase, reason: 'The referenced option is not available in task memory.' };
  }
  if (options.length === 1) return { status: 'RESOLVED', phrase: reference.phrase, index: 0 };
  const lowerPhrase = reference.phrase.toLowerCase();
  if (/\b(?:cheaper|cheapest)\b/.test(lowerPhrase)) {
    const priced = options.map((option, index) => ({
      index,
      price: Number(option?.price ?? option?.amount ?? option?.cost),
    })).filter((option) => Number.isFinite(option.price));
    if (priced.length > 0) {
      const lowest = Math.min(...priced.map((option) => option.price));
      const matches = priced.filter((option) => option.price === lowest);
      if (matches.length === 1) return { status: 'RESOLVED', phrase: reference.phrase, index: matches[0].index };
    }
  }
  if (/\b(?:ac|sleeper)\b/.test(lowerPhrase)) {
    const matches = options.map((option, index) => ({ option, index }))
      .filter(({ option }) => new RegExp(lowerPhrase.includes('sleeper') ? 'sleeper' : '\\bac\\b', 'i').test(JSON.stringify(option)));
    if (matches.length === 1) return { status: 'RESOLVED', phrase: reference.phrase, index: matches[0].index };
  }
  return { status: 'AMBIGUOUS', phrase: reference.phrase, reason: 'More than one prior option could match this reference.' };
}

function parseQuantity(value) {
  const quantities = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  if (/^\d+$/.test(String(value))) return Number(value);
  return quantities[String(value || '').toLowerCase()] || null;
}

function extractPassengerCount(text) {
  const match = normalizedText(text).match(/\b(?:for|with)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:passengers?|travell?ers?|people|adults?|persons?)\b|\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:passengers?|travell?ers?|people|adults?|persons?)\b/i);
  return parseQuantity(match?.[1] || match?.[2]);
}

function extractDuration(text) {
  const match = normalizedText(text).match(/\b(?:for|over)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(hours?|days?|nights?|weeks?)\b/i);
  if (!match) return null;
  const quantity = parseQuantity(match[1]);
  return quantity ? { quantity, unit: match[2].toLowerCase().replace(/s$/, '') } : null;
}

const FOOD_LOCATION_MISMATCHES = Object.freeze(['hyderabad', 'pakistan', 'chittoor', 'walajabad', 'hubli']);

function extractBudgetValue(text) {
  const normalized = normalizedText(text);
  const match = normalized.match(
    /(?:under|below|max(?:imum)?|budget(?:\s+of)?)\s*(?:₹|rs\.?|inr|\$)?\s*([\d,]+(?:\.\d+)?)\b|(?:₹|rs\.?|inr|\$)\s*([\d,]+(?:\.\d+)?)\b|(?:\b([\d,]+(?:\.\d+)?)\s*(?:rupees?|rs\.?|inr)\b)/i,
  );
  if (!match) return null;
  const value = Number((match[1] || match[2] || match[3]).replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function cleanFoodLocation(value) {
  return String(value || '')
    .replace(/[,:;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+(?:near|around|close to)$/i, '')
    .slice(0, 160);
}

function extractFoodLocation(text) {
  const normalized = normalizedText(text);
  const match = normalized.match(/\b(?:near|around|close to)\s+(.+?)(?=$|[.!?;]|(?:\s+)(?:without|with\s+no|no|excluding|exclude|but|under|below|max(?:imum)?|budget(?:\s+of)?|for\s+\d+|and\s+(?:no|without))\b)/i);
  return cleanFoodLocation(match?.[1]);
}

function extractFoodIdentity(text) {
  const normalized = normalizedText(text);
  const match = normalized.match(/\b(biryani(?:\s+(?:chawal|rice))?|chawal|rice|pizza|burger|thali|meal|food)\b/i);
  if (!match) return { foodType: null, dish: null };
  const dish = match[1].toLowerCase().replace(/\s+/g, ' ').trim();
  const foodType = /\bbiryani\b/i.test(dish) ? 'BIRYANI' : dish.split(/\s+/)[0].toUpperCase();
  return {
    foodType,
    dish: foodType === 'BIRYANI' && /\b(?:chawal|rice)\b/i.test(dish) ? 'BIRYANI RICE' : foodType === 'BIRYANI' ? 'BIRYANI' : dish.toUpperCase(),
  };
}

function extractLocationTokens(location) {
  return unique(String(location || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !['near', 'the', 'and'].includes(token)));
}

function buildFoodSearchQueries(text, food = null, maxQueries = 4) {
  const normalized = normalizedText(text);
  const identity = food || {
    ...extractFoodIdentity(normalized),
    budget: extractBudgetValue(normalized),
    location: extractFoodLocation(normalized),
  };
  const dish = identity.dish || identity.foodType || 'food';
  const budget = Number.isFinite(Number(identity.budget)) ? Number(identity.budget) : null;
  const location = cleanFoodLocation(identity.location);
  const locationWords = location.split(/\s+/).filter(Boolean);
  const city = locationWords.length > 1 ? locationWords[locationWords.length - 1] : location;
  const locality = locationWords.length > 2 ? locationWords.slice(1).join(' ') : location;
  const price = budget === null ? '' : `₹${budget}`;
  const queries = [
    [price, dish].filter(Boolean).join(' '),
    [price, dish, location].filter(Boolean).join(' '),
    [price, dish, locality || city].filter(Boolean).join(' '),
    [dish, budget === null ? '' : `under ₹${budget}`, location].filter(Boolean).join(' '),
  ];
  return [...new Set(queries.map((query) => query.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, Math.max(1, Math.min(4, maxQueries)));
}

function extractSearchQueryFromUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    const query = parsed.searchParams.get('q') || parsed.searchParams.get('query');
    return query ? query.replace(/\s+/g, ' ').trim().slice(0, 240) : null;
  } catch {
    return null;
  }
}

function candidateText(candidate) {
  return [
    candidate?.title,
    candidate?.name,
    candidate?.snippet,
    candidate?.description,
    candidate?.source,
    candidate?.url,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function sourceQuality(candidate) {
  const value = `${candidate?.source || ''} ${candidate?.url || ''} ${candidate?.sourceType || ''}`.toLowerCase();
  if (/youtube|youtu\.be|video|blog|article|social|facebook|instagram|tiktok/.test(value)) return 'LOW';
  if (/restaurant|menu|zomato|swiggy|google\.[^/]+\/maps|maps\.google|justdial|tripadvisor/.test(value)) return 'HIGH';
  if (/local|listing|business|food/.test(value)) return 'MEDIUM';
  return 'UNKNOWN';
}

function priceEvidence(candidate, text) {
  const explicit = String(candidate?.priceEvidenceType || candidate?.priceVerification || '').toUpperCase();
  if (explicit === 'PRICE_EXPLICITLY_OBSERVED' || candidate?.priceObserved === true) return 'PRICE_EXPLICITLY_OBSERVED';
  if (/\btitle\b/i.test(String(candidate?.priceSource || '')) || /(?:₹|rs\.?|inr|\$)\s*[\d,]+/i.test(String(candidate?.title || ''))) {
    return 'PRICE_CLAIMED_IN_TITLE';
  }
  if (/(?:menu|price|cost|₹|rs\.?|inr)/i.test(text) && sourceQuality(candidate) === 'HIGH') {
    return 'PRICE_EXPLICITLY_OBSERVED';
  }
  return 'PRICE_NOT_VERIFIED';
}

function evaluateFoodCandidate(candidate, food = {}) {
  const text = candidateText(candidate);
  const lower = text.toLowerCase();
  const identity = extractFoodIdentity(`${food.foodType || ''} ${food.dish || ''}`);
  const foodMatch = identity.foodType
    ? (identity.foodType === 'BIRYANI' ? /\bbiryani\b/i.test(lower) : new RegExp(`\\b${identity.foodType.toLowerCase()}\\b`, 'i').test(lower))
    : /\b(food|restaurant|meal|menu|biryani|pizza|burger|thali)\b/i.test(lower);
  const requestedLocation = cleanFoodLocation(food.location || food.deliveryLocation);
  const locationTokens = extractLocationTokens(requestedLocation);
  const matchingTokens = locationTokens.filter((token) => lower.includes(token));
  const mismatch = FOOD_LOCATION_MISMATCHES.some((token) => lower.includes(token) && !locationTokens.includes(token));
  const hasLocalityAnchor = locationTokens
    .filter((token) => !['delhi', 'india'].includes(token))
    .some((token) => lower.includes(token));
  const hasRequestedCity = locationTokens
    .filter((token) => ['delhi', 'india'].includes(token))
    .some((token) => lower.includes(token));
  const locationRelevance = mismatch
    ? 'CONTRADICTED'
    : locationTokens.length === 0
        ? 'NOT_REQUESTED'
        : matchingTokens.length >= Math.min(2, locationTokens.length)
          && (locationTokens.includes('delhi') ? hasLocalityAnchor && hasRequestedCity : true)
          ? 'MATCH'
        : matchingTokens.length > 0
          ? 'PARTIAL'
          : 'NOT_FOUND';
  const priceVerification = priceEvidence(candidate, text);
  const observedPrice = priceVerification === 'PRICE_EXPLICITLY_OBSERVED'
    ? String(candidate?.price || text.match(/(?:₹|rs\.?|inr|\$)\s*[\d,]+(?:\.\d+)?/i)?.[0] || '').trim()
    : '';
  const deliveryEvidence = food.deliveryExcluded
    ? /pickup|pick[- ]up|in[- ]store|dine[- ]?in|take[- ]?away|takeaway/i.test(text)
      ? 'SUPPORTED'
      : /delivery|swiggy|zomato|order online/i.test(text) ? 'CONFLICT' : 'NOT_VERIFIED'
    : 'NOT_REQUESTED';
  const quality = sourceQuality(candidate);
  const sourcePreference = String(food.sourcePreference || '').toUpperCase();
  const sourceConflict = sourcePreference === 'RESTAURANTS' && quality === 'LOW';
  const classification = !foodMatch || mismatch || sourceConflict
    ? 'IRRELEVANT'
    : locationRelevance === 'MATCH'
      && priceVerification === 'PRICE_EXPLICITLY_OBSERVED'
      && deliveryEvidence !== 'CONFLICT'
      && (!food.deliveryExcluded || deliveryEvidence === 'SUPPORTED')
      ? 'MATCH'
      : locationRelevance === 'NOT_FOUND'
        && priceVerification === 'PRICE_NOT_VERIFIED'
        && quality === 'UNKNOWN'
        ? 'UNVERIFIED'
        : 'PARTIAL_MATCH';
  return {
    ...candidate,
    title: String(candidate?.title || candidate?.name || 'Unnamed food result').trim().slice(0, 300),
    url: String(candidate?.url || '').trim().slice(0, 2048),
    snippet: String(candidate?.snippet || candidate?.description || '').trim().slice(0, 600),
    price: observedPrice || candidate?.price || null,
    sourceQuality: quality,
    foodRelevance: foodMatch ? 'MATCH' : 'NOT_FOUND',
    locationRelevance,
    priceVerification,
    deliveryEvidence,
    classification,
  };
}

function dedupeFoodCandidates(candidates) {
  const rank = { MATCH: 4, PARTIAL_MATCH: 3, UNVERIFIED: 2, IRRELEVANT: 1 };
  const byKey = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const urlKey = String(candidate?.url || '').toLowerCase().replace(/[?#].*$/, '');
    const titleKey = String(candidate?.title || candidate?.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const sourceKey = String(candidate?.source || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const key = urlKey || `${titleKey}|${sourceKey}`;
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing || (rank[candidate.classification] || 0) > (rank[existing.classification] || 0)) byKey.set(key, candidate);
  }
  return [...byKey.values()].sort((left, right) => (rank[right.classification] || 0) - (rank[left.classification] || 0));
}

function evaluateFoodCandidates(candidates, food = {}) {
  return dedupeFoodCandidates((Array.isArray(candidates) ? candidates : []).map((candidate) => evaluateFoodCandidate(candidate, food)));
}

function foodResearchOutcome(candidates) {
  const evaluated = Array.isArray(candidates) ? candidates : [];
  if (evaluated.some((candidate) => candidate.classification === 'MATCH')) return 'MATCH';
  if (evaluated.some((candidate) => candidate.classification === 'PARTIAL_MATCH')) return 'PARTIAL_MATCH';
  if (evaluated.some((candidate) => candidate.classification === 'UNVERIFIED')) return 'NOT_VERIFIED';
  return 'NOT_VERIFIED';
}

function formatFoodResearchResponse(food = {}, candidates = []) {
  const evaluated = dedupeFoodCandidates(candidates);
  const matches = evaluated.filter((candidate) => candidate.classification === 'MATCH').slice(0, 5);
  const partial = evaluated.filter((candidate) => candidate.classification === 'PARTIAL_MATCH').slice(0, 4);
  const location = food.location || 'the requested area';
  const budget = food.budget !== null && food.budget !== undefined && Number.isFinite(Number(food.budget))
    ? `₹${Number(food.budget)}`
    : 'the requested budget';
  if (matches.length > 0) {
    const rows = matches.map((candidate) => `| ${candidate.title.replace(/\|/g, '\\|')} | ${candidate.price || budget} | ${candidate.url || 'Observed page'} |`).join('\n');
    return [
      `I found ${matches.length} food option${matches.length === 1 ? '' : 's'} that match the requested dish, price, location, and pickup/no-delivery constraint near ${location}.`,
      '',
      '| Option | Price | Source |',
      '|---|---|---|',
      rows,
      '',
      'No order or payment was made.',
    ].join('\n');
  }
  if (partial.length > 0) {
    const references = partial.map((candidate) => `- ${candidate.title}${candidate.url ? ` — ${candidate.url}` : ''}`).join('\n');
    return [
      `I found ${partial.length} relevant reference${partial.length === 1 ? '' : 's'}, but I could not verify all of the requested details for ${location}.`,
      `The ${budget} price, exact location, or pickup/no-delivery condition is not fully confirmed, so I have not presented these as verified matches.`,
      '',
      references,
    ].join('\n');
  }
  return `I could not verify a ${food.dish || 'food'} option at ${budget} near ${location} without relying on unrelated or unverified results. No order or payment was made.`;
}

function extractTaskType(text, categories) {
  const normalized = normalizedText(text);
  if (/\b(bus(?:es)?|redbus|coach)\b/i.test(normalized)) return 'BUS_BOOKING';
  if (/\b(flight|airline|airport)\b/i.test(normalized)) return 'FLIGHT_BOOKING';
  if (/\b(train|railway)\b/i.test(normalized)) return 'TRAIN_BOOKING';
  if (/\b(hotel|stay|room|accommodation)\b/i.test(normalized)) return 'HOTEL_BOOKING';
  if (/\b(taxi|cab|uber|ola)\b/i.test(normalized)) return 'TAXI_BOOKING';
  if (categories.includes('GROCERY')) return 'GROCERY_ORDER';
  if (categories.includes('SHOPPING') || categories.includes('FOOD') || categories.includes('FOOD_RESEARCH')) return 'COMMERCE_TASK';
  if (categories.includes('EMAIL')) return 'EMAIL_TASK';
  if (categories.includes('CALENDAR')) return 'CALENDAR_TASK';
  return 'GENERAL_TASK';
}

function extractDomainRequirements(text, categories, preferences) {
  const normalized = normalizedText(text);
  const budgetValue = extractBudgetValue(normalized);
  const budget = budgetValue;
  const passengerCount = extractPassengerCount(normalized);
  const duration = extractDuration(normalized);
  const departureAfter = preferences.departureAfter
    || normalized.match(/\b(?:depart(?:ure|ing)?|leave|leaving)\s+(?:after|from)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i)?.[1]
    || null;
  const arrivalBefore = normalized.match(/\barriv(?:e|al)\s+before\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i)?.[1] || preferences.arrivalBefore || null;
  const classMatch = normalized.match(/\b(first class|business class|economy|premium|standard)\b/i);
  const seatMatch = normalized.match(/\b(ac\s+sleeper|ac|air[- ]?conditioned|sleeper|seater|non[- ]?ac)\b/i);
  const ratingMatch = normalized.match(/\b(?:rating|rated)\s+(?:of\s+)?(?:at\s+least|minimum|above|over)\s+(\d+(?:\.\d+)?)\b/i);
  const locationMatch = normalized.match(/\b(?:near|around|close to)\s+([A-Za-z][A-Za-z0-9\s.'-]+?)(?=\s+(?:for|under|below|and|with|$))/i);
  const quantityMatch = normalized.match(/\b(\d+)\s+(?:items?|units?|packs?|plates?|meals?)\b/i);
  const foodIdentity = extractFoodIdentity(normalized);
  const foodLocation = extractFoodLocation(normalized);
  const sourcePreference = /\b(?:restaurant|restaurants|local listing|menu)\b/i.test(normalized)
    ? 'RESTAURANTS'
    : /\b(?:video|videos|youtube|article|articles|blog|blogs)\b/i.test(normalized) ? 'NON_RESTAURANT' : null;
  return {
    travel: {
      passengerCount,
      departureAfter,
      arrivalBefore,
      travelClass: classMatch ? classMatch[1].toUpperCase() : null,
      seatPreference: preferences.seatPreference || (seatMatch ? seatMatch[1].toUpperCase().replace(/\s+/g, '_') : null),
      airConditioned: /\b(?:ac|air[- ]?conditioned)\b/i.test(normalized) ? true : null,
      duration,
      minimumRating: preferences.minimumRating || (ratingMatch ? Number(ratingMatch[1]) : null),
      budget,
    },
    shopping: {
      quantity: quantityMatch ? Number(quantityMatch[1]) : null,
      budget,
      brand: normalized.match(/\b(?:brand|from)\s+([A-Z][A-Za-z0-9-]+)/)?.[1] || null,
      size: normalized.match(/\bsize\s+([A-Za-z0-9-]+)/i)?.[1] || null,
      variant: normalized.match(/\b(?:variant|model)\s+([A-Za-z0-9-]+)/i)?.[1] || null,
      deliveryPreference: normalized.match(/\b(express|same[- ]day|next[- ]day|standard)\s+delivery\b/i)?.[1]?.toUpperCase().replace(/-/g, '_') || null,
      deliveryLocation: locationMatch?.[1]?.trim() || null,
    },
    food: {
      budget: budgetValue,
      quantity: quantityMatch ? Number(quantityMatch[1]) : null,
      foodType: foodIdentity.foodType,
      dish: foodIdentity.dish,
      location: foodLocation || locationMatch?.[1]?.trim() || null,
      locationTerms: extractLocationTokens(foodLocation || locationMatch?.[1]?.trim() || ''),
      dietaryPreference: normalized.match(/\b(vegetarian|vegan|halal|jain)\b/i)?.[1]?.toLowerCase() || null,
      deliveryExcluded: /\b(?:without|no|exclude|excluding|excluding any)\s+(?:any\s+)?delivery(?:\s+(?:fee|fees|charge|charges))?\b/i.test(normalized),
      sourcePreference,
      searchQueries: buildFoodSearchQueries(normalized, {
        foodType: foodIdentity.foodType,
        dish: foodIdentity.dish,
        budget: budgetValue,
        location: foodLocation || locationMatch?.[1]?.trim() || '',
      }),
      purchase: false,
      payment: false,
    },
    email: {
      targetAccount: normalized.match(/\b(?:my|the)\s+([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/i)?.[1] || null,
      sender: normalized.match(/\bfrom\s+([A-Za-z][A-Za-z0-9._-]*)\b/i)?.[1] || null,
      recipient: normalized.match(/\b(?:to|for)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)/)?.[1] || null,
      subject: normalized.match(/\bsubject(?: is|:)\s*["']?([^"'.!?]+)["']?/i)?.[1]?.trim() || null,
      timeRange: normalized.match(/\b(?:last|past|this)\s+(?:\d+\s+)?(?:day|days|week|month)s?\b/i)?.[0] || null,
      action: normalized.match(/\b(send|reply|forward|draft)\b/i)?.[1]?.toUpperCase() || null,
      summaryRequired: /\b(summar(?:y|ize)|important|key points)\b/i.test(normalized),
    },
    research: {
      topic: categories.some((category) => ['WEB_RESEARCH', 'RESEARCH', 'TRAVEL_RESEARCH'].includes(category))
        ? normalized.replace(/\b(research|find|search|look up|tell me about)\b/ig, '').trim().slice(0, 160) || null : null,
      sourceCount: normalized.match(/\b(?:from|using)\s+(\d+)\s+sources?\b/i)?.[1] ? Number(normalized.match(/\b(?:from|using)\s+(\d+)\s+sources?\b/i)[1]) : null,
      summaryDepth: normalized.match(/\b(short|brief|detailed|deep|comprehensive)\b/i)?.[1]?.toUpperCase() || null,
    },
  };
}

const MISSING_INFORMATION_RULES = [
  {
    id: 'origin',
    applies: (text, categories) => categories.some((category) => ['BUS', 'FLIGHT', 'TRAIN', 'TAXI', 'TRAVEL_BOOKING'].includes(category)) && /\b(book|reserve|ticket|bus|flight|train|taxi|travel)\b/i.test(text) && !/\b(from|origin|starting|depart(?:ing|ure)?)\b/i.test(text),
    prompt: 'Where will the journey start?',
    reason: 'Travel preparation needs an origin.',
  },
  {
    id: 'destination',
    applies: (text, categories) => categories.some((category) => ['BUS', 'FLIGHT', 'TRAIN', 'TAXI', 'TRAVEL_BOOKING'].includes(category)) && /\b(book|reserve|ticket|bus|flight|train|taxi|travel)\b/i.test(text) && !/\b(to|destination|going)\b/i.test(text),
    prompt: 'What is the destination?',
    reason: 'Travel preparation needs a destination.',
  },
  {
    id: 'travel-date',
    applies: (text, categories) => categories.some((category) => ['BUS', 'FLIGHT', 'TRAIN', 'TAXI', 'TRAVEL_BOOKING'].includes(category)) && /\b(book|reserve|ticket|bus|flight|train|taxi|travel)\b/i.test(text) && !/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}[/-]\d{1,2})\b/i.test(text),
    prompt: 'What date should I use?',
    reason: 'Travel preparation needs a date.',
  },
  {
    id: 'delivery-location',
    applies: (text, categories) => categories.some((category) => ['SHOPPING', 'GROCERY', 'FOOD'].includes(category))
      && extractActionIntent(text, categories).actionIntent !== 'RESEARCH'
      && /\b(order|deliver|delivery|buy|purchase)\b/i.test(text)
      && !/\b(address|deliver to|location|home)\b/i.test(text),
    prompt: 'Where should the delivery go?',
    reason: 'An order cannot be prepared without a delivery location.',
  },
  {
    id: 'recipient',
    applies: (text, categories) => categories.includes('EMAIL') && /\b(send|reply|email|contact)\b/i.test(text) && !/\b(to|recipient|recruiter|everyone)\b/i.test(text),
    prompt: 'Who should receive the message?',
    reason: 'External communication needs a recipient.',
  },
];

function normalizedText(value) {
  return String(value || '').trim().slice(0, 2000);
}

function unique(values) {
  return [...new Set(values)];
}

function monthIndexFromName(value) {
  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const index = monthNames.indexOf(String(value || '').slice(0, 3).toLowerCase());
  return index >= 0 ? index + 1 : null;
}

function toIsoDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() + days);
  return next;
}

function getNextWeekday(referenceDate, weekday) {
  const date = new Date(referenceDate);
  date.setHours(0, 0, 0, 0);
  const current = date.getDay();
  const offset = (weekday - current + 7) % 7 || 7;
  date.setDate(date.getDate() + offset);
  return date;
}

function resolveRelativeDate(text, referenceDate = new Date()) {
  const lower = normalizedText(text).toLowerCase();
  if (!lower) return null;
  if (/\btoday\b/.test(lower)) return toIsoDate(new Date(referenceDate));
  if (/\btonight\b/.test(lower)) return toIsoDate(new Date(referenceDate));
  if (/\btomorrow\b/.test(lower)) return toIsoDate(addDays(referenceDate, 1));
  if (/\bnext\s+week\b/.test(lower)) return toIsoDate(addDays(referenceDate, 7));

  const weekdayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let index = 0; index < weekdayNames.length; index += 1) {
    const name = weekdayNames[index];
    if (new RegExp(`\\bnext\\s+${name}\\b`, 'i').test(lower)) {
      return toIsoDate(getNextWeekday(referenceDate, index));
    }
    if (new RegExp(`\\b${name}\\b`, 'i').test(lower) && !/next\s+/.test(lower)) {
      return toIsoDate(getNextWeekday(referenceDate, index));
    }
  }
  return null;
}

function parseMonthDayYear(value) {
  const match = normalizedText(value).match(/(\d{1,2})\s+(?:of\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*,?\s*(\d{2,4})/i);
  if (match) {
    const day = Number(match[1]);
    const month = monthIndexFromName(match[2]);
    const year = Number(match[3]);
    const normalizedYear = year < 100 ? 2000 + year : year;
    const date = new Date(normalizedYear, month - 1, day);
    if (!Number.isNaN(date.getTime())
      && date.getFullYear() === normalizedYear
      && date.getMonth() === month - 1
      && date.getDate() === day) return toIsoDate(date);
  }
  return null;
}

function parseMonthFirstDate(value) {
  const match = normalizedText(value).match(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2}),?\s*(\d{2,4})/i);
  if (!match) return null;
  const month = monthIndexFromName(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const normalizedYear = year < 100 ? 2000 + year : year;
  const date = new Date(normalizedYear, month - 1, day);
  if (!Number.isNaN(date.getTime())
    && date.getFullYear() === normalizedYear
    && date.getMonth() === month - 1
    && date.getDate() === day) return toIsoDate(date);
  return null;
}

function parseSlashDate(value) {
  const match = normalizedText(value).match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (!match) return null;
  let day = Number(match[1]);
  let month = Number(match[2]);
  const yearValue = Number(match[3]);
  const year = yearValue < 100 ? 2000 + yearValue : yearValue;
  if (day > 12 && month <= 12) {
    [day, month] = [month, day];
  }
  const date = new Date(year, month - 1, day);
  if (!Number.isNaN(date.getTime())
    && date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day) return toIsoDate(date);
  return null;
}

function parseIsoDate(value) {
  const match = normalizedText(value).match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (!Number.isNaN(date.getTime())
    && date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day) return toIsoDate(date);
  return null;
}

function extractDateFromText(text, referenceDate = new Date()) {
  const normalized = normalizedText(text);
  if (!normalized) return null;

  const relative = resolveRelativeDate(normalized, referenceDate);
  if (relative) return relative;

  const directPatterns = [
    parseIsoDate,
    parseSlashDate,
    parseMonthDayYear,
    parseMonthFirstDate,
  ];
  for (const parser of directPatterns) {
    const result = parser(normalized);
    if (result) return result;
  }

  const monthDayYear = normalized.match(/(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*,?\s*(\d{2,4})/i);
  if (monthDayYear) {
    const result = parseMonthDayYear(`${monthDayYear[1]} ${monthDayYear[2]} ${monthDayYear[3]}`);
    if (result) return result;
  }

  return null;
}

function cleanLocation(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b(?:from|to|on|for|at|by|with|date|journey|trip|travel|bus|flight|train|taxi|booking|ticket)\s*$/i, '')
    .replace(/[,.]+$/, '')
    .trim();
}

function extractRoute(text) {
  const normalized = normalizedText(text);
  if (!normalized) return { origin: null, destination: null };

  const direct = normalized.match(/(?:from|origin(?:ating)?(?:\s+from)?|depart(?:ing|ure)?(?:\s+from)?|starting(?:\s+from)?)\s+([A-Za-z][A-Za-z0-9\s.'-]+?)\s+(?:to|->|→)\s+([A-Za-z][A-Za-z0-9\s.'-]+?)(?=\s+(?:on|for|at|by|with|date|journey|trip|travel|bus|flight|train|taxi|booking|ticket|$))/i);
  if (direct) {
    return { origin: cleanLocation(direct[1]), destination: cleanLocation(direct[2]) };
  }

  const simple = normalized.match(/([A-Za-z][A-Za-z0-9\s.'-]+?)\s+(?:to|->|→)\s+([A-Za-z][A-Za-z0-9\s.'-]+?)(?=\s+(?:on|for|at|by|with|date|journey|trip|travel|bus|flight|train|taxi|booking|ticket|$))/i);
  if (simple) {
    return { origin: cleanLocation(simple[1]), destination: cleanLocation(simple[2]) };
  }

  return { origin: null, destination: null };
}

function extractResultCount(text) {
  const normalized = normalizedText(text);
  const match = normalized.match(/(?:best|top)\s+(\d+)\b|\b(\d+)\s+(?:best|top)\b|\bfor\s+(\d+)\s+options?\b/i);
  if (!match) return null;
  const value = Number(match[1] || match[2] || match[3]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function extractOptimization(text) {
  const normalized = normalizedText(text);
  if (/\b(best value|value for money|cheapest reasonable|cheap(?:est)?\s+(?:good|reasonable)|cheap and good)\b/i.test(normalized)) {
    return 'BEST_VALUE';
  }
  if (/\b(best rated|highest rated|rating)\b/i.test(normalized)) return 'BEST_RATED';
  if (/\b(fastest|quickest|soonest)\b/i.test(normalized)) return 'FASTEST';
  if (/\b(convenient|closest|nearby)\b/i.test(normalized)) return 'MOST_CONVENIENT';
  if (/\b(cheapest|lowest price|budget)\b/i.test(normalized)) return 'CHEAPEST';
  return 'BEST_VALUE';
}

function extractStructuredRequirements(goal, referenceDate = new Date(), options = {}) {
  const normalized = normalizedText(goal);
  const latest = normalizedText(options.latestText);
  const fullRoute = extractRoute(normalized);
  const latestRoute = latest ? extractRoute(latest) : { origin: null, destination: null };
  const origin = latestRoute.origin || fullRoute.origin;
  const destination = latestRoute.destination || fullRoute.destination;
  const travelDate = (latest && extractDateFromText(latest, referenceDate)) || extractDateFromText(normalized, referenceDate);
  const resultCount = (latest && extractResultCount(latest)) || extractResultCount(normalized) || 3;
  const optimizationSignal = /\b(best value|value for money|cheapest|lowest price|budget|best rated|highest rated|rating|fastest|quickest|soonest|convenient|closest|nearby)\b/i;
  const optimization = latest && optimizationSignal.test(latest) ? extractOptimization(latest) : extractOptimization(normalized);
  const categories = detectCategories(normalized);
  const action = options.action || extractActionIntent(normalized, categories);
  const intent = options.intent || classifyIntent(normalized, action);
  const references = extractReferences(normalized);
  const extractedPreferences = extractPreferences(normalized, options.previousPreferences);
  const domainRequirements = extractDomainRequirements(normalized, categories, extractedPreferences);

  const latestCategories = latest ? detectCategories(latest) : [];
  const taskType = latest && extractTaskType(latest, latestCategories) !== 'GENERAL_TASK'
    ? extractTaskType(latest, latestCategories) : extractTaskType(normalized, categories);
  const criticalFields = ['BUS_BOOKING', 'FLIGHT_BOOKING', 'TRAIN_BOOKING', 'HOTEL_BOOKING', 'TAXI_BOOKING'].includes(taskType)
    ? ['origin', 'destination', 'travelDate'] : [];
  const values = { origin, destination, travelDate };

  return {
    taskType,
    origin,
    destination,
    travelDate,
    resultCount,
    optimization,
    actionIntent: action.actionIntent,
    intent,
    currentIntent: intent,
    allowedActions: action.allowedActions,
    forbiddenActions: action.forbiddenActions,
    autonomyLevel: action.autonomyLevel,
    references,
    preferences: {
      price: 'high',
      quality: 'high',
      busType: 'considered',
      rating: 'considered',
      duration: 'considered',
      seatAvailability: 'considered',
      boardingPoint: 'considered',
      droppingPoint: 'considered',
      ...extractedPreferences,
    },
    domainRequirements,
    criticalRequirements: criticalFields,
    requirementStatus: Object.fromEntries(['origin', 'destination', 'travelDate'].map((field) => [
      field,
      values[field] ? 'PROVIDED' : (criticalFields.includes(field) ? 'CRITICAL_REQUIRED' : 'OPTIONAL'),
    ])),
    executionPolicy: action.executionPolicy,
    bookingAllowed: false,
    paymentAllowed: false,
    submitAllowed: false,
    confirmationRequired: action.confirmationRequired,
    refinement: options.refinement || null,
    entities: {
      locations: [origin, destination].filter(Boolean),
      dates: travelDate ? [travelDate] : [],
      quantities: resultCount ? [resultCount] : [],
    },
  };
}

function detectCategories(goal) {
  let categories = [];
  const activeGoal = normalizedText(goal).replace(NEGATION_SEGMENT_PATTERN, ' ');
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(activeGoal)) categories.push(category);
  }
  if (categories.includes('FOOD_RESEARCH')) categories = categories.filter((category) => category !== 'FOOD');
  if (categories.length === 0) categories.push('GENERAL_COMPUTER_TASK');
  if (categories.includes('WEB_RESEARCH') || categories.includes('RESEARCH')) categories.push('RESEARCH');
  if (categories.some((category) => ['PDF', 'DOCUMENTS', 'SPREADSHEET'].includes(category))) categories.push('INFORMATION_EXTRACTION');
  if (categories.some((category) => ['SHOPPING', 'GROCERY', 'FOOD', 'FOOD_RESEARCH', 'BUS', 'FLIGHT', 'TRAIN', 'HOTEL', 'TAXI'].includes(category))) categories.push('COMPARISON');
  return unique(categories).filter((category) => CAPABILITY_CATEGORIES.includes(category));
}

function classifyRisk(goal, categories) {
  const action = extractActionIntent(goal, categories);
  if (action.actionIntent === 'RESEARCH') {
    if (ACTION_PATTERNS.userData.test(goal) || categories.some((category) => ['EMAIL', 'MESSAGING', 'CALENDAR', 'DOCUMENTS', 'PDF', 'SPREADSHEET', 'FILE_MANAGEMENT'].includes(category))) return 'USER_DATA';
    if (categories.includes('DESKTOP_APPS') || categories.includes('GENERAL_COMPUTER_TASK')) return 'LOW_RISK';
    return 'READ_ONLY';
  }
  if (ACTION_PATTERNS.destructive.test(goal) && !action.forbiddenActions.includes('DELETE')) return 'DESTRUCTIVE';
  const statusLookup = /\b(track|tracking|status|confirmed|confirmation)\b/i.test(goal);
  const explicitFinancialVerb = /\b(buy|purchase|pay|checkout|book|reserve|ticket|payment)\b/i.test(goal)
    || (/\b(order|booking)\b/i.test(goal) && !statusLookup);
  if (
    action.actionIntent !== 'RESEARCH'
    && (ACTION_PATTERNS.financial.test(goal) || categories.includes('TRAVEL_BOOKING'))
    && !(statusLookup && !explicitFinancialVerb)
  ) return 'FINANCIAL';
  if (ACTION_PATTERNS.communication.test(goal) && !action.forbiddenActions.includes('COMMUNICATE') && !action.forbiddenActions.includes('SUBMIT')) return 'EXTERNAL_COMMUNICATION';
  if (ACTION_PATTERNS.account.test(goal)) return 'ACCOUNT_CHANGE';
  if (ACTION_PATTERNS.userData.test(goal) || /\b(track|tracking|status|confirmed|confirmation)\b/i.test(goal) || categories.some((category) => ['EMAIL', 'MESSAGING', 'CALENDAR', 'DOCUMENTS', 'PDF', 'SPREADSHEET', 'FILE_MANAGEMENT'].includes(category))) return 'USER_DATA';
  if (categories.includes('DESKTOP_APPS') || categories.includes('GENERAL_COMPUTER_TASK')) return 'LOW_RISK';
  return 'READ_ONLY';
}

function extractPreferences(goal, defaults = {}) {
  const preferences = { ...defaults };
  if (/\b(best value|value for money|cheapest reasonable|cheap(?:est)?\s+(?:good|reasonable))\b/i.test(goal)) preferences.ranking = 'BEST_VALUE';
  else if (/\b(cheapest|lowest price|budget)\b/i.test(goal)) preferences.ranking = 'CHEAPEST';
  else if (/\b(best rated|highest rated|rating)\b/i.test(goal)) preferences.ranking = 'BEST_RATED';
  else if (/\b(fastest|quickest|soonest)\b/i.test(goal)) preferences.ranking = 'FASTEST';
  else if (/\b(convenient|closest|nearby)\b/i.test(goal)) preferences.ranking = 'MOST_CONVENIENT';
  else if (!preferences.ranking) preferences.ranking = 'BEST_VALUE';
  const budget = extractBudgetValue(goal);
  if (budget !== null) preferences.budget = budget;
  if (/\b(ac|air[- ]?conditioned)\b/i.test(goal)) preferences.comfort = 'AC';
  if (/\b(sleeper)\b/i.test(goal)) preferences.seatPreference = 'SLEEPER';
  if (/\b(vegetarian|vegan|halal)\b/i.test(goal)) preferences.diet = goal.match(/\b(vegetarian|vegan|halal)\b/i)[1].toLowerCase();
  const arrivalBefore = goal.match(/\barriv(?:e|al)\s+before\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (arrivalBefore) preferences.arrivalBefore = arrivalBefore[0].replace(/^arrival\s+/i, '').trim();
  const departureAfter = goal.match(/\b(?:depart(?:ure|ing)?|leave|leaving)\s+after\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b|\bonly\s+after\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b|\bafter\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (departureAfter) {
    const phrase = departureAfter[0].trim();
    preferences.departureAfter = /^only\s+/i.test(phrase)
      ? phrase
      : `Depart ${phrase.replace(/^(?:departure|departing|depart|leave|leaving)\s+/i, '')}`.trim();
  }
  const rating = goal.match(/\b(?:rating|rated)\s+(?:below|under|less than)\s+(\d+(?:\.\d+)?)\b|\b(?:rating|rated)\s+(?:of\s+)?at\s+least\s+(\d+(?:\.\d+)?)\b/i);
  if (rating) preferences.minimumRating = Number(rating[1] || rating[2]);
  return preferences;
}

function findMissingInformation(goal, categories, referenceDate = new Date()) {
  const extracted = extractStructuredRequirements(goal, referenceDate);
  const critical = new Set(extracted.criticalRequirements);
  return MISSING_INFORMATION_RULES
    .filter((rule) => rule.applies(goal, categories))
    .filter((rule) => {
      if (rule.id === 'origin') return !extracted.origin;
      if (rule.id === 'destination') return !extracted.destination;
      if (rule.id === 'travel-date') return !extracted.travelDate;
      return true;
    })
    .map(({ id, prompt, reason }) => ({
      id,
      prompt,
      reason,
      requiredFor: 'PREPARE',
      criticality: critical.has(id === 'travel-date' ? 'travelDate' : id) ? 'CRITICAL_REQUIRED' : 'NON_CRITICAL',
    }));
}

function step(id, title, capability, action, dependsOn, status = 'PENDING') {
  return { id, title, capability, action, dependsOn, status };
}

function buildTaskGraph(categories, riskLevel, missingInformation) {
  const primary = categories[0] || 'GENERAL_COMPUTER_TASK';
  const nodes = [
    step('understand-goal', 'Understand the request', null, 'understand', [], 'READY'),
    step('select-capabilities', 'Select capabilities and providers', primary, 'route', ['understand-goal'], 'PENDING'),
    step('collect-evidence', 'Collect relevant information', categories.includes('WEB_RESEARCH') ? 'WEB_RESEARCH' : primary, 'research', ['select-capabilities'], 'PENDING'),
  ];
  const comparison = categories.includes('COMPARISON') || categories.includes('PRODUCT_COMPARISON') || categories.includes('WEB_COMPARISON');
  if (comparison) nodes.push(step('compare-options', 'Compare options using the stated preferences', 'COMPARISON', 'compare', ['collect-evidence'], 'PENDING'));
  const lastResearch = comparison ? 'compare-options' : 'collect-evidence';
  if (riskLevel === 'READ_ONLY' || riskLevel === 'LOW_RISK' || riskLevel === 'USER_DATA') {
    nodes.push(step('prepare-result', 'Prepare a result for the user', 'SUMMARIZATION', 'summarize', [lastResearch], 'PENDING'));
    nodes.push(step('verify-result', 'Verify the result against the request', 'INFORMATION_EXTRACTION', 'verify', ['prepare-result'], 'PENDING'));
  } else {
    const blocked = missingInformation.length > 0 ? 'BLOCKED' : 'PENDING';
    nodes.push(step('prepare-action', 'Prepare the external action without executing it', primary, 'prepare', [lastResearch], blocked));
    nodes.push(step('request-confirmation', 'Show the exact action and wait for confirmation', null, 'requestConfirmation', ['prepare-action'], blocked));
    nodes.push(step('execute-action', 'Execute only the confirmed action', primary, 'execute', ['request-confirmation'], blocked));
    nodes.push(step('verify-action', 'Verify the resulting external state', 'INFORMATION_EXTRACTION', 'verify', ['execute-action'], blocked));
  }
  return {
    nodes,
    roots: ['understand-goal'],
    terminalNodeId: nodes[nodes.length - 1].id,
  };
}

function clonePlanningValue(value) {
  if (Array.isArray(value)) return value.map(clonePlanningValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clonePlanningValue(item)]));
  return value;
}

function diffStructuredRequirements(before, after, path = '', changes = []) {
  if (before === after) return changes;
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) || Array.isArray(after)) {
    if (path) changes.push(path);
    return changes;
  }
  const keys = unique([...Object.keys(before), ...Object.keys(after)]).filter((key) => key !== 'refinement');
  for (const key of keys) diffStructuredRequirements(before[key], after[key], path ? `${path}.${key}` : key, changes);
  return changes;
}

function buildPlan({
  goal,
  requirements = [],
  constraints = [],
  referenceDate = new Date(),
  latestText = '',
  previousStructuredRequirements = null,
  previousPreferences = {},
}) {
  const normalizedGoal = normalizedText(goal);
  const normalizedRequirements = unique(requirements.map(normalizedText).filter(Boolean)).slice(0, 8);
  const normalizedConstraints = unique(constraints.map(normalizedText).filter(Boolean)).slice(0, 8);
  const planningText = [normalizedGoal, ...normalizedRequirements, ...normalizedConstraints].join(' ');
  const normalizedLatestText = normalizedText(latestText);
  const categories = detectCategories(planningText);
  const completeAction = extractActionIntent(planningText, categories);
  const latestAction = normalizedLatestText ? extractActionIntent(normalizedLatestText, categories) : completeAction;
  const action = normalizedLatestText
    ? {
      ...latestAction,
      forbiddenActions: latestAction.forbiddenActions.length ? latestAction.forbiddenActions : completeAction.forbiddenActions,
    }
    : completeAction;
  const intent = classifyIntent(normalizedLatestText || planningText, action);
  const riskLevel = classifyRisk(normalizedLatestText || planningText, categories);
  const preferences = extractPreferences(planningText, previousPreferences);
  if (normalizedLatestText) {
    const latestPreferences = extractPreferences(normalizedLatestText, {});
    const latestHasRanking = /\b(best value|value for money|cheapest|lowest price|budget|best rated|highest rated|rating|fastest|quickest|soonest|convenient|closest|nearby)\b/i.test(normalizedLatestText);
    if (!latestHasRanking) delete latestPreferences.ranking;
    Object.assign(preferences, latestPreferences);
  }
  const structuredRequirements = extractStructuredRequirements(planningText, referenceDate, {
    action,
    intent,
    previousPreferences: preferences,
    latestText: normalizedLatestText,
  });
  const changedFields = normalizedLatestText && previousStructuredRequirements
    ? diffStructuredRequirements(previousStructuredRequirements, structuredRequirements)
    : [];
  const refinement = normalizedLatestText ? {
    input: normalizedLatestText,
    changedFields,
    before: previousStructuredRequirements ? clonePlanningValue(previousStructuredRequirements) : null,
    after: clonePlanningValue(structuredRequirements),
  } : null;
  structuredRequirements.refinement = refinement;
  const missingInformation = findMissingInformation(planningText, categories, referenceDate);
  const capabilityRoutes = getCapabilityRegistry().route(categories);
  const taskGraph = buildTaskGraph(categories, riskLevel, missingInformation);
  const providers = unique(capabilityRoutes.flatMap((route) => route.providerCandidates.map((provider) => provider.providerId)));
  return {
    version: 1,
    status: missingInformation.length ? 'NEEDS_INFORMATION' : 'READY',
    objective: normalizedGoal,
    categories,
    riskLevel,
    intent,
    currentIntent: intent,
    latestInput: normalizedLatestText || null,
    requirements: normalizedRequirements,
    constraints: normalizedConstraints,
    preferences,
    structuredRequirements,
    refinement,
    missingInformation,
    capabilityRoutes,
    providers,
    taskGraph,
    nextAction: missingInformation.length ? 'ASK_FOR_REQUIRED_INFORMATION' : taskGraph.nodes.find((node) => node.status === 'PENDING')?.id || taskGraph.terminalNodeId,
  };
}

function summarizeForDeveloperHandoff(plan) {
  if (!plan) throw new Error('A planned General task is required for handoff.');
  return {
    targetMode: 'developer',
    summary: `Review the user request in Developer mode: ${plan.objective}`,
    goal: plan.objective,
    requirements: [...plan.requirements],
    constraints: [...plan.constraints],
    categories: [...plan.categories],
    riskLevel: plan.riskLevel,
    missingInformation: plan.missingInformation.map(({ id, prompt, reason }) => ({ id, prompt, reason })),
    contextBoundary: 'Only this safe task summary is shared. General browser credentials, cookies, payment data, and General task state remain private.',
  };
}

function rankOptions(options, preferences = {}) {
  const ranking = RANKING_MODES.includes(preferences.ranking) ? preferences.ranking : 'BEST_MATCH';
  return [...options].map((option, index) => ({ option, evidence: option?.evidence || {}, originalIndex: index }))
    .sort((left, right) => {
      const leftScore = Number(left.evidence[ranking] ?? left.evidence.score ?? 0);
      const rightScore = Number(right.evidence[ranking] ?? right.evidence.score ?? 0);
      return rightScore - leftScore || left.originalIndex - right.originalIndex;
    })
    .map(({ option, evidence }, index) => ({ ...option, rank: index + 1, ranking, rankingEvidence: evidence }));
}

module.exports = {
  RANKING_MODES,
  detectCategories,
  classifyRisk,
  classifyIntent,
  SEMANTIC_INTENTS,
  extractActionIntent,
  extractDateFromText,
  extractReferences,
  resolveReference,
  extractRoute,
  extractStructuredRequirements,
  extractPreferences,
  extractDomainRequirements,
  extractBudgetValue,
  extractFoodIdentity,
  extractFoodLocation,
  buildFoodSearchQueries,
  extractSearchQueryFromUrl,
  evaluateFoodCandidate,
  evaluateFoodCandidates,
  dedupeFoodCandidates,
  foodResearchOutcome,
  formatFoodResearchResponse,
  findMissingInformation,
  diffStructuredRequirements,
  buildTaskGraph,
  buildPlan,
  rankOptions,
  summarizeForDeveloperHandoff,
};
