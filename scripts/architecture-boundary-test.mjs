import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const sourceExtensions = /\.(?:cjs|js|jsx|mjs|py|ts|tsx)$/;
const appSource = fs.readFileSync(path.join(projectRoot, 'src', 'App.tsx'), 'utf8');
const generalControllerSource = fs.readFileSync(path.join(projectRoot, 'src', 'features', 'general', 'useGeneralAgentController.ts'), 'utf8');
const generalPageSource = fs.readFileSync(path.join(projectRoot, 'src', 'features', 'general', 'GeneralAgentPage.tsx'), 'utf8');
const codingControllerSource = fs.readFileSync(path.join(projectRoot, 'src', 'features', 'coding', 'useCodingAgentController.ts'), 'utf8');
const codingPageSource = fs.readFileSync(path.join(projectRoot, 'src', 'features', 'coding', 'CodingAgentPage.tsx'), 'utf8');
const meetingControllerSource = fs.readFileSync(path.join(projectRoot, 'src', 'features', 'meeting', 'useMeetingAssistantController.ts'), 'utf8');
const meetingPageSource = fs.readFileSync(path.join(projectRoot, 'src', 'features', 'meeting', 'MeetingAssistantPage.tsx'), 'utf8');
const meetingTransportSource = fs.readFileSync(path.join(projectRoot, 'src', 'features', 'meeting', 'meetingTransport.ts'), 'utf8');
const assistantControllerSource = fs.readFileSync(path.join(projectRoot, 'src', 'features', 'assistant', 'useAssistantAgentController.ts'), 'utf8');
const assistantTransportSource = fs.readFileSync(path.join(projectRoot, 'src', 'features', 'assistant', 'assistantTransport.ts'), 'utf8');
const assistantPageSource = fs.readFileSync(path.join(projectRoot, 'src', 'features', 'assistant', 'AssistantAgentPage.tsx'), 'utf8');
const assistantWorkspaceSource = fs.readFileSync(path.join(projectRoot, 'src', 'features', 'assistant', 'AssistantAgentWorkspace.tsx'), 'utf8');
const providerSelectionSource = fs.readFileSync(path.join(projectRoot, 'src', 'features', 'provider-selection', 'useAgentProviderSelection.ts'), 'utf8');
const providerSelectComponentSource = fs.readFileSync(path.join(projectRoot, 'src', 'features', 'provider-selection', 'AgentProviderSelect.tsx'), 'utf8');
const screenReaderSource = fs.readFileSync(path.join(projectRoot, 'src', 'features', 'screen-reading', 'useScreenReader.ts'), 'utf8');
const agentRoots = Object.freeze({
  assistant: [
    'src/features/assistant',
  ],
  coding: [
    'src/features/coding',
    'electron/coding-pipeline',
    'electron/developerAgent.cjs',
    'electron/developerBenchmark.cjs',
    'electron/developerContext.cjs',
    'electron/developerFiles.cjs',
    'electron/developerIndex.cjs',
    'server/src/coding_provider.py',
    'server/src/coding_websocket.py',
  ],
  general: [
    'src/features/general',
    'electron/generalAgent.cjs',
    'electron/generalAgentCapabilities.cjs',
    'electron/generalAgentElectronBrowser.cjs',
    'electron/generalAgentExecution.cjs',
    'electron/generalAgentPlanner.cjs',
  ],
  meeting: [
    'src/features/meeting',
    'src/audio/sttService.ts',
    'src/audio/sttTypes.ts',
    'server/src/stt_service.py',
  ],
});

const pythonModuleOwners = new Map([
  ['coding_provider', 'coding'],
  ['coding_websocket', 'coding'],
  ['stt_service', 'meeting'],
]);

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

function ownerForPath(relativePath) {
  const normalized = normalizePath(relativePath).replace(/^\.\//, '');
  for (const [owner, roots] of Object.entries(agentRoots)) {
    if (roots.some((root) => {
      const normalizedRoot = normalizePath(root);
      return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
    })) return owner;
  }
  return null;
}

function collectSourceFiles(directory, root = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(entryPath, root);
    if (!sourceExtensions.test(entry.name)) return [];
    return [{
      relativePath: normalizePath(path.relative(projectRoot, entryPath)),
      source: fs.readFileSync(entryPath, 'utf8'),
      root,
    }];
  });
}

function extractModuleSpecifiers(source) {
  const specifiers = new Set();
  const jsImports = /\b(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
  const pythonImports = /^\s*(?:from|import)\s+([.\w]+)/gm;
  for (const match of source.matchAll(jsImports)) specifiers.add(match[1]);
  for (const match of source.matchAll(pythonImports)) specifiers.add(match[1]);
  return specifiers;
}

function ownerForImport(importerPath, specifier) {
  const importer = normalizePath(importerPath);
  const aliased = specifier.startsWith('@/') || specifier.startsWith('~/')
    ? `src/${specifier.slice(2)}`
    : specifier;
  if (aliased.startsWith('.')) {
    const resolved = normalizePath(path.relative(projectRoot, path.resolve(projectRoot, path.dirname(importer), aliased)));
    return ownerForPath(resolved);
  }
  return pythonModuleOwners.get(path.basename(aliased)) || null;
}

function findCrossAgentImports(files) {
  const violations = [];
  for (const file of files) {
    const importerOwner = ownerForPath(file.relativePath);
    if (!importerOwner) continue;
    for (const specifier of extractModuleSpecifiers(file.source)) {
      const importedOwner = ownerForImport(file.relativePath, specifier);
      if (importedOwner && importedOwner !== importerOwner) {
        violations.push(
          `${file.relativePath} (${importerOwner}) imports "${specifier}" owned by ${importedOwner}`,
        );
      }
    }
  }
  return violations;
}

const fixtureViolations = findCrossAgentImports([{
  relativePath: 'src/features/coding/test-fixture.ts',
  source: "import { GeneralAgentWorkspace } from '../general/GeneralAgentWorkspace';",
}]);
assert.equal(fixtureViolations.length, 1, 'The boundary checker must detect a cross-agent import.');
const codingMeetingFixtureViolations = findCrossAgentImports([
  {
    relativePath: 'src/features/coding/test-fixture.ts',
    source: "import { useMeetingAssistantController } from '../meeting/useMeetingAssistantController';",
  },
  {
    relativePath: 'src/features/meeting/test-fixture.ts',
    source: "import { CodingAgentPage } from '../coding/CodingAgentPage';",
  },
]);
assert.equal(codingMeetingFixtureViolations.length, 2, 'The boundary checker must reject imports between Coding and Meeting.');
assert.match(generalPageSource, /useGeneralAgentController\(\{ providerId \}\)/, 'The General Agent page must own its controller lifecycle and provider selection.');
assert.match(generalPageSource, /<GeneralAgentWorkspace/, 'The General Agent page must render its own workspace.');
assert.match(generalPageSource, /onHistoryEntry\(/, 'General Agent history records must leave the page through a typed callback.');
assert.doesNotMatch(appSource, /useGeneralAgentController/, 'App composition must not construct the General Agent controller.');
assert.doesNotMatch(
  appSource,
  /createGeneralTask|generalBrowserOperation|recordGeneralModelResponse|runGeneralAgentRequest|pendingGeneralRequestIdsRef/,
  'General lifecycle, model transport, and browser dispatch must stay in the General feature.',
);
assert.match(generalControllerSource, /new WebSocket\(GENERAL_WS_URL\)/, 'General Agent must own its WebSocket connection.');
assert.match(generalControllerSource, /mode: 'general'[\s\S]*general: true/, 'General requests must use the General-only protocol contract.');
assert.match(meetingPageSource, /useMeetingAssistantController\(/, 'The Meeting Assistant page must own its controller lifecycle.');
assert.doesNotMatch(appSource, /useMeetingAssistantController/, 'App composition must not construct the Meeting Assistant controller.');
assert.match(
  meetingControllerSource,
  /const sendQuestion = async[\s\S]*transport\.send\(buildChatRequest\(/,
  'Meeting questions must use the Meeting-owned transport and request builder.',
);
assert.match(meetingTransportSource, /agent: 'meeting'/, 'Meeting transport must identify its own agent endpoint.');
assert.match(meetingPageSource, /<MeetingAssistantWorkspace \{\.\.\.workspace\} \/>/, 'Meeting must have a feature-owned page boundary.');
assert.match(appSource, /appMode === 'meeting'/, 'Meeting must have an independent application page route.');
assert.doesNotMatch(appSource, /generalAnswer \|\| assistantAnswer|generalBusy \? 'thinking' : generalAnswer/, 'Assistant overlay status must not consume General Agent state.');
assert.match(assistantPageSource, /useAssistantAgentController\(/, 'The Assistant page must own its controller lifecycle.');
assert.doesNotMatch(appSource, /useAssistantAgentController/, 'App composition must not construct the Assistant controller.');
assert.match(assistantPageSource, /<AssistantAgentWorkspace[\s\S]*\{\.\.\.workspace\}/, 'Assistant must have a feature-owned page boundary.');
assert.match(assistantWorkspaceSource, /export function AssistantAgentWorkspace/, 'Assistant chat presentation must stay in its feature folder.');
assert.match(appSource, /<AssistantAgentPage/, 'App must route Assistant rendering through its feature-owned page.');
assert.match(assistantControllerSource, /new AssistantAgentTransport\(/, 'Assistant Agent must own its transport lifecycle.');
assert.match(assistantTransportSource, /ASSISTANT_WS_URL = .*\/assistant/, 'Assistant transport must use its isolated endpoint.');
assert.match(assistantTransportSource, /agent: 'assistant'/, 'Assistant transport must identify its own endpoint.');
assert.doesNotMatch(appSource, /new WebSocket|wsRef|wsConnectPromiseRef|handleWsMessage|pendingChatRequestIdsRef|draftImproveRequestIdRef/, 'Assistant WebSocket lifecycle and request routing must stay in the Assistant feature.');
assert.match(appSource, /requestContext=\{meetingRequestContext\}/, 'App must provide Meeting context through its typed feature-owned request contract.');
assert.match(appSource, /requestContext=\{assistantRequestContext\}/, 'App must provide Assistant context through its typed feature-owned request contract.');
assert.match(assistantPageSource, /buildAssistantChatRequest\(requestContext/, 'Assistant prompt construction must stay in the Assistant feature.');
assert.match(meetingPageSource, /buildMeetingChatRequest\(requestContext/, 'Meeting prompt construction must stay in the Meeting feature.');
assert.match(appSource, /onHistoryEntries=\{addAssistantHistoryEntries\}/, 'Assistant history must cross the page boundary through a feature-owned completed-turn callback.');
assert.doesNotMatch(appSource, /completedTurnEntries/, 'Assistant completed-turn history generation must stay out of App.');
assert.match(providerSelectionSource, /ai-help-agent-provider-selection:\$\{agentId\}/, 'Agent provider preferences must be stored independently per agent.');
assert.match(providerSelectionSource, /provider\.enabled && provider\.hasApiKey/, 'Agent provider preferences must reject disabled or unconfigured provider instances.');
assert.match(providerSelectComponentSource, /provider\.enabled && provider\.hasApiKey/, 'Agent selectors must only expose enabled providers with shared credentials.');
assert.match(providerSelectComponentSource, /Automatic \(enabled provider fallback\)/, 'Agent provider selection must preserve automatic provider fallback.');
assert.doesNotMatch(meetingPageSource, /<AgentProviderSelect/, 'Meeting provider selection must remain hidden from the Meeting page.');
assert.match(assistantPageSource, /useScreenReader\(\{[\s\S]*storageKey: 'assistant-screen-reading-enabled'/, 'Assistant must own its independent screen-reading preference.');
assert.match(meetingPageSource, /useScreenReader\(\{[\s\S]*storageKey: 'meeting-screen-reading-enabled'/, 'Meeting must own its independent screen-reading preference.');
assert.match(screenReaderSource, /if \(enabled && !disabled && event\.ctrlKey/, 'Inactive feature pages must not intercept screen-reading shortcuts.');
assert.doesNotMatch(
  appSource,
  /transcribeAudioSegment|MediaRecorder|getUserMedia|segmentProcessorRef|captureSessionIdRef|pendingPartialQuestionRef|const (?:start|stop)MeetingCapture|const requestMeetingAudioStream/,
  'Meeting capture, segmentation, and STT lifecycle must stay in the Meeting controller.',
);
assert.doesNotMatch(
  appSource,
  /const \[(?:meetingAudioMode|meetingMenuOpen|microphoneDevices|microphoneUnavailable|transcriptOpen|isRecording|isTranscribing|audioSourceLabel|audioLevel|audioStatus|systemAudioStatus|microphoneStatus|pipelineStatus|liveTranscript|transcripts|transcriptSearch),/,
  'Meeting-owned capture, transcript, and pipeline state must not drift back into App.',
);
assert.doesNotMatch(
  appSource,
  /CodingAgentTransport|developerSocket|codingWebSocket|proposal_ready|awaiting_approval|developer\.readFiles|developer\.applyPatch|developer\.verify|const \[(?:developerMessages|developerInput|developerStreaming|developerProposal|developerActivity|codingMessages|codingInput|codingProposal),/,
  'Coding Agent transport, state, and proposal lifecycle must stay in the Coding feature.',
);
assert.match(codingPageSource, /useCodingAgentController\(/, 'The Coding Agent page must own its controller lifecycle.');
assert.doesNotMatch(appSource, /useCodingAgentController/, 'App composition must not construct the Coding Agent controller.');
assert.match(codingControllerSource, /new CodingAgentTransport\(\)/, 'Coding Agent must own its transport lifecycle.');
assert.match(meetingControllerSource, /transcribeAudioSegment\(/, 'Meeting Assistant must own its STT processing lifecycle.');
assert.match(meetingControllerSource, /const \[meetingAudioMode, setMeetingAudioMode\]/, 'Meeting Assistant must own audio source state.');
assert.match(meetingControllerSource, /MediaRecorder|getUserMedia|captureSessionIdRef/, 'Meeting Assistant must own capture and segmentation state.');

const sourceFiles = Object.values(agentRoots).flat().flatMap((root) => {
  const absolute = path.resolve(projectRoot, root);
  if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
    return collectSourceFiles(absolute);
  }
  if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
    return [{
      relativePath: normalizePath(path.relative(projectRoot, absolute)),
      source: fs.readFileSync(absolute, 'utf8'),
    }];
  }
  return [];
});

const violations = findCrossAgentImports(sourceFiles);
if (violations.length > 0) {
  console.error('Architecture boundary violations found:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log('Architecture boundary test passed (cross-agent module imports are isolated).');
