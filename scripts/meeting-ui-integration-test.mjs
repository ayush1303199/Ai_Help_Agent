import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const vite = await createServer({
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
});

try {
  const { MeetingAssistantWorkspace } = await vite.ssrLoadModule(
    '/src/features/meeting/MeetingAssistantWorkspace.tsx',
  );
  const { pruneMeetingHistory } = await vite.ssrLoadModule('/src/history/historyService.ts');
  const fixedNow = Date.parse('2026-09-28T00:00:00.000Z');
  const sessions = [
    { id: 'expired-meeting', title: 'Expired', messages: [], updatedAt: '2026-08-01T00:00:00.000Z', mode: 'meeting' },
    { id: 'fresh-meeting', title: 'Fresh', messages: [], updatedAt: '2026-09-27T00:00:00.000Z', mode: 'meeting' },
    { id: 'old-assistant', title: 'Assistant', messages: [], updatedAt: '2026-08-01T00:00:00.000Z', mode: 'assistant' },
  ];
  assert.deepEqual(
    pruneMeetingHistory(sessions, 30, fixedNow).map(({ id }) => id),
    ['fresh-meeting', 'old-assistant'],
    'The shared-history pruning function must expire Meeting records without touching other agent modes.',
  );
  assert.deepEqual(
    pruneMeetingHistory(sessions, 'off', fixedNow),
    sessions,
    'Disabling retention must preserve every shared-history record.',
  );
  const noop = () => {};
  const baseProps = {
    sessionActive: false,
    meetingAudioMode: 'microphone',
    transcriptionLanguage: 'auto',
    displayedAudioSourceLabel: 'Default microphone',
    displayedAudioStatus: 'Ready',
    microphoneStatus: 'connected',
    microphoneUnavailable: false,
    systemAudioStatus: 'off',
    audioLevel: 0,
    audioSignalDetected: false,
    meetingMenuOpen: false,
    statusLabel: 'Ready',
    pipelineStatus: 'ready',
    pipelineElapsedMs: 0,
    lastStageTimings: {},
    liveTranscript: '',
    lastQuestion: '',
    lastAnswer: '',
    answeredSegments: [],
    transcripts: [],
    transcriptSearch: '',
    filteredTranscripts: [],
    transcriptOpen: false,
    error: '',
    input: '',
    isRecording: false,
    isTranscribing: false,
    chatStreaming: false,
    onAudioModeChange: noop,
    onTranscriptionLanguageChange: noop,
    onTestAudio: noop,
    onStartCapture: noop,
    onStopCapture: noop,
    onCancelRequest: () => false,
    onOpenAudioSettings: noop,
    onTranscriptToggle: noop,
    onInputChange: noop,
    onSendMessage: noop,
    onReadScreen: noop,
    screenReading: false,
    screenReadingEnabled: false,
    onTranscriptSearchChange: noop,
    onUseTranscript: noop,
    onSaveTranscript: noop,
    onSendTranscript: noop,
    onDeleteTranscript: noop,
    onClearHistory: noop,
    historyRetentionDays: 30,
    onRetentionDaysChange: noop,
  };

  const setupMarkup = renderToStaticMarkup(createElement(MeetingAssistantWorkspace, baseProps));
  assert.match(setupMarkup, /Start Listening/, 'The meeting setup screen must expose audio capture.');
  assert.match(setupMarkup, /Test Microphone/, 'The setup screen must preserve microphone testing.');
  assert.match(setupMarkup, /aria-label="Meeting history retention"/, 'Retention settings should be visible on the setup screen even before data exists.');
  assert.match(setupMarkup, /Delete after 7 days/);
  assert.match(setupMarkup, /Delete after 30 days \(recommended\)/);
  assert.match(setupMarkup, /Delete after 60 days/);
  assert.match(setupMarkup, /Delete after 90 days/);
  assert.match(setupMarkup, /Off \(manual deletion only\)/);
  assert.doesNotMatch(setupMarkup, /Clear saved Meeting data/, 'History controls should not appear before a meeting session.');
  const permissionErrorMarkup = renderToStaticMarkup(createElement(MeetingAssistantWorkspace, {
    ...baseProps,
    statusLabel: 'Microphone permission was denied. Allow microphone access and try again.',
    error: 'Microphone permission was denied. Allow microphone access and try again.',
  }));
  assert.match(permissionErrorMarkup, /role="alert" aria-live="assertive"/, 'Permission failures must be announced urgently.');
  assert.match(permissionErrorMarkup, /role="status" aria-live="polite"/, 'Setup progress and recovery state must be announced politely.');
  assert.match(permissionErrorMarkup, /Start Listening/, 'Permission failures should leave a clear retry action available.');

  const setupHistoryMarkup = renderToStaticMarkup(createElement(MeetingAssistantWorkspace, {
    ...baseProps,
    transcriptOpen: true,
    transcripts: [{
      id: 'old-transcript',
      source: 'Microphone',
      text: 'Saved question',
      createdAt: '2026-09-27T00:00:00.000Z',
    }],
    filteredTranscripts: [{
      id: 'old-transcript',
      source: 'Microphone',
      text: 'Saved question',
      createdAt: '2026-09-27T00:00:00.000Z',
    }],
  }));
  assert.match(setupHistoryMarkup, /Hide saved Meeting data/, 'Saved data can be managed before capture starts.');
  assert.match(setupHistoryMarkup, /Clear saved Meeting data/, 'Retention controls must remain available from the setup screen.');
  assert.match(setupHistoryMarkup, /Meeting history retention/, 'Users can choose Meeting data retention duration.');

  const activeMarkup = renderToStaticMarkup(createElement(MeetingAssistantWorkspace, {
    ...baseProps,
    sessionActive: true,
    isRecording: true,
    pipelineStatus: 'listening',
    statusLabel: 'Listening...',
    transcriptOpen: true,
    liveTranscript: 'What is JavaScript?',
    lastQuestion: 'What is JavaScript?',
    lastAnswer: 'A programming language.',
    answeredSegments: [{ question: 'What is JavaScript?', answer: 'A programming language.' }],
    transcripts: [{
      id: 'transcript-1',
      source: 'Microphone',
      text: 'What is JavaScript?',
      createdAt: '2026-09-28T00:00:00.000Z',
    }],
    filteredTranscripts: [{
      id: 'transcript-1',
      source: 'Microphone',
      text: 'What is JavaScript?',
      createdAt: '2026-09-28T00:00:00.000Z',
    }],
  }));
  assert.match(activeMarkup, /Stop Listening/, 'An active capture must expose its stop control.');
  assert.match(activeMarkup, /Answer ready|A programming language/, 'The answer state must render in the Meeting workspace.');
  assert.match(activeMarkup, /Search saved transcripts/, 'Saved transcript search must render in the history view.');
  assert.match(activeMarkup, /Delete transcript from Microphone/, 'Saved transcripts must retain per-entry deletion.');
  assert.match(activeMarkup, /Clear saved Meeting data/, 'The history view must expose the Meeting-only clear control.');
  assert.match(activeMarkup, /role="status" aria-live="polite" aria-atomic="true"/, 'Active capture and retry states must be announced to assistive technology.');
  const providerErrorMarkup = renderToStaticMarkup(createElement(MeetingAssistantWorkspace, {
    ...baseProps,
    sessionActive: true,
    pipelineStatus: 'error',
    statusLabel: 'Transcription failed after two retries. Start listening to try again.',
    error: 'The speech-to-text provider timed out. Please try again.',
  }));
  assert.match(providerErrorMarkup, /role="alert" aria-live="assertive"/, 'Provider failures must be announced urgently.');
  assert.match(providerErrorMarkup, /Start Listening/, 'Provider failures must offer a visible capture retry.');

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.Event = dom.window.Event;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const rootElement = document.getElementById('root');
  const root = createRoot(rootElement);
  const interactionEvents = [];
  let captureStartAttempts = 0;
  let interactionProps = {
    ...baseProps,
    onTestAudio: () => interactionEvents.push('audio-test'),
    onStartCapture: () => {
      captureStartAttempts += 1;
      interactionEvents.push('capture-start');
      if (captureStartAttempts === 1) {
        interactionProps = {
          ...interactionProps,
          statusLabel: 'Microphone permission was denied. Allow microphone access and try again.',
          error: 'Microphone permission was denied. Allow microphone access and try again.',
          pipelineStatus: 'error',
        };
        return;
      }
      interactionProps = {
        ...interactionProps,
        sessionActive: true,
        isRecording: true,
        pipelineStatus: 'listening',
        statusLabel: 'Listening...',
        error: '',
      };
    },
    onStopCapture: () => {
      interactionEvents.push('capture-stop');
      interactionProps = {
        ...interactionProps,
        sessionActive: false,
        isRecording: false,
        pipelineStatus: 'stopped',
        statusLabel: 'Stopped',
      };
    },
    onCancelRequest: () => {
      interactionEvents.push('request-cancel');
      interactionProps = { ...interactionProps, isTranscribing: false };
      return true;
    },
    onClearHistory: () => {
      interactionEvents.push('meeting-history-clear');
      interactionProps = {
        ...interactionProps,
        transcripts: [],
        filteredTranscripts: [],
        answeredSegments: [],
        liveTranscript: '',
        lastQuestion: '',
        lastAnswer: '',
      };
    },
    onRetentionDaysChange: (days) => {
      interactionEvents.push(`retention-${days}`);
      if (interactionProps.failRetentionSave) throw new Error('Could not save the Meeting data retention setting.');
      interactionProps = { ...interactionProps, historyRetentionDays: days };
    },
    onSendMessage: () => interactionEvents.push('keyboard-question-send'),
  };
  const renderInteraction = async () => act(async () => {
    root.render(createElement(MeetingAssistantWorkspace, interactionProps));
  });
  const clickButton = async (label) => {
    const button = [...rootElement.querySelectorAll('button')]
      .find((candidate) => candidate.textContent.trim() === label);
    assert.ok(button, `Expected an interactive button labelled "${label}".`);
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await renderInteraction();
  };

  try {
    await renderInteraction();
    await clickButton('Test Microphone');
    assert.equal(interactionEvents.at(-1), 'audio-test', 'Audio-test control must invoke the selected-source test.');
    await clickButton('Start Listening');
    assert.equal(interactionEvents.at(-1), 'capture-start');
    assert.match(rootElement.textContent, /Microphone permission was denied/);
    assert.ok(rootElement.querySelector('[role="alert"]'), 'Permission failure should render an alert for recovery.');
    await clickButton('Start Listening');
    assert.equal(captureStartAttempts, 2, 'The setup retry action should attempt capture again.');
    assert.ok([...rootElement.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Stop Listening'));
    assert.equal(rootElement.querySelector('[role="status"]')?.getAttribute('aria-live'), 'polite');

    await clickButton('Stop Listening');
    assert.equal(interactionEvents.at(-1), 'capture-stop');
    assert.ok([...rootElement.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Start Listening'));

    interactionProps = {
      ...interactionProps,
      sessionActive: true,
      isTranscribing: true,
      pipelineStatus: 'transcribing',
      input: 'What is JavaScript?',
      transcriptOpen: true,
      transcripts: [{
        id: 'interaction-transcript',
        source: 'Microphone',
        text: 'What is JavaScript?',
        createdAt: '2026-09-28T00:00:00.000Z',
      }],
      filteredTranscripts: [{
        id: 'interaction-transcript',
        source: 'Microphone',
        text: 'What is JavaScript?',
        createdAt: '2026-09-28T00:00:00.000Z',
      }],
      answeredSegments: [{ question: 'What is JavaScript?', answer: 'A programming language.' }],
    };
    await renderInteraction();
    const questionInput = rootElement.querySelector('input[placeholder="Ask the assistant..."]');
    assert.ok(questionInput, 'Meeting question composer should be keyboard reachable.');
    await act(async () => {
      questionInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    assert.equal(interactionEvents.at(-1), 'keyboard-question-send', 'Enter should submit a typed Meeting question.');
    await clickButton('Cancel transcription');
    assert.equal(interactionEvents.at(-1), 'request-cancel');
    assert.equal(interactionProps.isTranscribing, false, 'Cancel should be wired to the active transcription request.');

    const retentionSelect = rootElement.querySelector('select[aria-label="Meeting history retention"]');
    assert.ok(retentionSelect, 'Saved Meeting history should expose retention preferences.');
    await act(async () => {
      retentionSelect.value = '7';
      retentionSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await renderInteraction();
    assert.equal(interactionEvents.at(-1), 'retention-7', 'Changing retention should persist the selected duration.');
    assert.equal(interactionProps.historyRetentionDays, 7);
    const sixtyDaySelect = rootElement.querySelector('select[aria-label="Meeting history retention"]');
    await act(async () => {
      sixtyDaySelect.value = '60';
      sixtyDaySelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await renderInteraction();
    assert.equal(interactionEvents.at(-1), 'retention-60', 'The 60-day retention option should persist its selection.');
    assert.equal(interactionProps.historyRetentionDays, 60);
    interactionProps = { ...interactionProps, failRetentionSave: true };
    await renderInteraction();
    const failingRetentionSelect = rootElement.querySelector('select[aria-label="Meeting history retention"]');
    await act(async () => {
      failingRetentionSelect.value = '90';
      failingRetentionSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await renderInteraction();
    assert.match(rootElement.querySelector('[role="alert"]')?.textContent || '', /Could not save the Meeting data retention setting/);
    interactionProps = { ...interactionProps, failRetentionSave: false };

    await clickButton('Clear saved Meeting data');
    assert.match(rootElement.textContent, /Delete all locally saved Meeting transcripts and answers/);
    await clickButton('Cancel');
    assert.doesNotMatch(rootElement.textContent, /Delete all locally saved Meeting transcripts and answers/);
    await clickButton('Clear saved Meeting data');
    await clickButton('Delete Meeting data');
    assert.equal(interactionEvents.at(-1), 'meeting-history-clear');
    assert.equal(interactionProps.transcripts.length, 0, 'Confirmed clear should remove saved transcripts.');
    assert.equal(interactionProps.answeredSegments.length, 0, 'Confirmed clear should remove saved answers.');
    assert.doesNotMatch(rootElement.textContent, /What is JavaScript\?/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.HTMLElement;
    delete globalThis.MouseEvent;
    delete globalThis.Event;
    delete globalThis.navigator;
  }

  console.log('Meeting UI integration tests passed (rendering and click-driven capture, cancel, and history flows).');
} finally {
  await vite.close();
}
