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
  const { AnswerSessionView } = await vite.ssrLoadModule('/src/ui/AnswerSessionView.tsx');
  const { renderAnswerMarkdown } = await vite.ssrLoadModule('/src/ui/answerMarkdown.tsx');
  const { ChatHistoryModal } = await vite.ssrLoadModule('/src/features/history/ChatHistoryModal.tsx');
  const { pruneHistorySessions, readHistory } = await vite.ssrLoadModule('/src/history/historyService.ts');
  const previousLocalStorage = globalThis.localStorage;
  const storedValues = new Map([
    ['chat-history', '[]'],
    ['meeting-history-conversation-id', 'conversation-1'],
    ['meeting-chat-state', JSON.stringify([{
      question: 'What is two plus two?',
      answer: 'Four.',
      createdAt: '2026-09-28T00:00:00.000Z',
    }])],
  ]);
  globalThis.localStorage = {
    getItem: (key) => storedValues.get(key) ?? null,
    setItem: (key, value) => storedValues.set(key, String(value)),
  };
  assert.deepEqual(
    readHistory().map(({ id, mode, title, messages }) => ({ id, mode, title, messages })),
    [{
      id: 'meeting-conversation-1',
      mode: 'meeting',
      title: 'What is two plus two?',
      messages: [
        { role: 'user', content: 'What is two plus two?' },
        { role: 'assistant', content: 'Four.' },
      ],
    }],
    'A completed Meeting answer stored in the Meeting state must appear in shared Chat history.',
  );
  storedValues.set('chat-history', JSON.stringify([{
    id: 'meeting-conversation-1',
    mode: 'meeting',
    title: 'Existing Meeting conversation',
    updatedAt: '2026-09-28T00:00:00.000Z',
    messages: [{ role: 'user', content: 'Existing question' }, { role: 'assistant', content: 'Existing answer' }],
  }]));
  assert.equal(readHistory().length, 1, 'Meeting history migration must not duplicate an existing shared entry.');
  storedValues.set('meeting-chat-state', '[]');
  storedValues.set('chat-history', '[]');
  assert.deepEqual(readHistory(), [], 'Cleared Meeting state must not repopulate deleted shared history.');
  globalThis.localStorage = previousLocalStorage;
  const fixedNow = Date.parse('2026-09-28T00:00:00.000Z');
  const sessions = [
    { id: 'expired-meeting', title: 'Expired', messages: [], updatedAt: '2026-08-01T00:00:00.000Z', mode: 'meeting' },
    { id: 'fresh-meeting', title: 'Fresh', messages: [], updatedAt: '2026-09-27T00:00:00.000Z', mode: 'meeting' },
    { id: 'old-assistant', title: 'Assistant', messages: [], updatedAt: '2026-08-01T00:00:00.000Z', mode: 'assistant' },
  ];
  assert.deepEqual(
    pruneHistorySessions(sessions, 30, fixedNow).map(({ id }) => id),
    ['fresh-meeting'],
    'The selected retention period must apply to every saved conversation mode.',
  );
  assert.deepEqual(
    pruneHistorySessions(sessions, 'off', fixedNow),
    sessions,
    'Disabling retention must preserve every shared-history record.',
  );
  assert.deepEqual(
    pruneHistorySessions(sessions, 'date:2026-09-29', fixedNow),
    sessions,
    'A future custom date must keep all saved history until its selected date.',
  );
  assert.deepEqual(
    pruneHistorySessions(sessions, 'date:2026-09-28', fixedNow),
    [],
    'A due custom date deletes all saved conversation modes.',
  );
  const noop = () => {};
  const historyModalMarkup = renderToStaticMarkup(createElement(ChatHistoryModal, {
    sessions: [],
    filteredSessions: [],
    search: '',
    copiedItem: '',
    hasCurrentMessages: false,
    historyRetention: 30,
    onRetentionChange: noop,
    onSearchChange: noop,
    onClose: noop,
    onNewChat: noop,
    onCopyChat: noop,
    onDeleteAll: noop,
    onOpenSession: noop,
    onDeleteSession: noop,
  }));
  assert.match(historyModalMarkup, /aria-label="Chat history retention"/, 'Global retention options should be visible in the Chat history modal.');
  assert.match(historyModalMarkup, /Delete all saved history on a date/);
  const baseProps = {
    sessionActive: false,
    meetingAudioMode: 'microphone',
    transcriptionLanguage: 'auto',
    reviewBeforeSend: false,
    pendingTranscriptReviews: [],
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
    onReviewBeforeSendChange: noop,
    onSendReviewedTranscript: noop,
    onSkipReviewedTranscript: noop,
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
  assert.match(setupMarkup, /Review transcript before sending/, 'Optional transcript review should be available in audio settings.');
  assert.equal(baseProps.reviewBeforeSend, false, 'Hands-free behavior should remain the default.');
  assert.match(setupMarkup, /aria-label="Meeting history retention"/, 'Retention settings should be visible on the setup screen even before data exists.');
  assert.match(setupMarkup, /Delete after 7 days/);
  assert.match(setupMarkup, /Delete after 30 days \(recommended\)/);
  assert.match(setupMarkup, /Delete after 60 days/);
  assert.match(setupMarkup, /Delete after 90 days/);
  assert.match(setupMarkup, /Delete all saved history on a date/);
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
  const scheduledDeletionMarkup = renderToStaticMarkup(createElement(MeetingAssistantWorkspace, {
    ...baseProps,
    historyRetentionDays: 'date:2099-12-31',
  }));
  assert.match(scheduledDeletionMarkup, /aria-label="Delete all saved history on date"/);
  assert.match(scheduledDeletionMarkup, /All saved history will be deleted on 2099-12-31/);

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
  assert.match(activeMarkup, /Questions &amp; answers/, 'Questions and their answers should share one conversation area.');
  assert.doesNotMatch(activeMarkup, /Earlier answers/, 'Q&A history should not be split into a separate earlier-answers panel.');
  const conversationMarkup = renderToStaticMarkup(createElement(AnswerSessionView, {
    lastQuestion: 'Latest question?',
    lastAnswer: 'Latest answer.',
    isThinking: false,
    answeredSegments: [
      { question: 'First question?', answer: 'First answer.' },
      { question: 'Latest question?', answer: 'Latest answer.' },
    ],
  }));
  assert.ok(
    conversationMarkup.indexOf('Latest question?') < conversationMarkup.indexOf('First question?'),
    'The newest question and answer should be immediately visible before older conversation entries.',
  );
  assert.match(conversationMarkup, /First question\?.*First answer\./s, 'Each previous question should remain paired with its answer.');
  const malformedFencedAnswer = renderToStaticMarkup(createElement(
    'div',
    null,
    renderAnswerMarkdown([
      'Here are the two requested programs.',
      '**1. Check even or odd number** \\`\\`\\`python n = int(input("Enter a number: ")) if n % 2 == 0: print(n, "is even") else: print(n, "is odd")\\`\\`\\`',
      '**2. Recursion example** \\`\\`\\`python def factorial(n): if n == 0 or n == 1: return 1 return n * factorial(n - 1)\\`\\`\\`',
    ].join('\n\n')),
  ));
  assert.equal((malformedFencedAnswer.match(/<pre/g) || []).length, 2, 'Escaped inline fences should render as separate code blocks.');
  assert.match(malformedFencedAnswer, /n = int\(input\(&quot;Enter a number: ?&quot;\)\)/, 'The first inline code block should retain its code as preformatted text.');
  assert.match(malformedFencedAnswer, /def factorial\(n\):/, 'The second inline code block should retain its code as preformatted text.');
  assert.doesNotMatch(malformedFencedAnswer, /```/, 'Fence markers should not leak into the rendered answer.');
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
    pendingTranscriptReviews: [{ id: 'review-1', text: 'What is JavaScript?' }],
    reviewBeforeSend: true,
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
    onReviewBeforeSendChange: (enabled) => {
      interactionEvents.push(`review-${enabled}`);
      interactionProps = { ...interactionProps, reviewBeforeSend: enabled };
    },
    onOpenAudioSettings: () => {
      interactionProps = { ...interactionProps, meetingMenuOpen: !interactionProps.meetingMenuOpen };
    },
    onSendReviewedTranscript: (id, text) => {
      interactionEvents.push(`review-send-${id}-${text}`);
      interactionProps = {
        ...interactionProps,
        pendingTranscriptReviews: interactionProps.pendingTranscriptReviews.filter((review) => review.id !== id),
      };
    },
    onSkipReviewedTranscript: (id) => {
      interactionEvents.push(`review-skip-${id}`);
      interactionProps = {
        ...interactionProps,
        pendingTranscriptReviews: interactionProps.pendingTranscriptReviews.filter((review) => review.id !== id),
      };
    },
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
    const reviewModeToggle = rootElement.querySelector('[aria-label="Review transcript before sending"]');
    assert.equal(reviewModeToggle?.checked, true, 'The opt-in review preference should be reflected in settings.');
    await act(async () => {
      reviewModeToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await renderInteraction();
    assert.equal(interactionEvents.at(-1), 'review-false', 'The review preference should be changeable before capture.');
    const reenabledReviewToggle = rootElement.querySelector('[aria-label="Review transcript before sending"]');
    await act(async () => {
      reenabledReviewToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await renderInteraction();
    assert.equal(interactionEvents.at(-1), 'review-true');
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
    assert.ok(rootElement.querySelector('[aria-label="Review recognized transcript before sending"]'));
    assert.ok([...rootElement.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Send to AI'));
    await clickButton('Speech recognition settings');
    assert.equal(rootElement.querySelector('[aria-label="Review transcript before sending"]')?.checked, true);
    await clickButton('Skip');
    assert.equal(interactionEvents.at(-1), 'review-skip-review-1', 'Skipping should discard only the current review item.');
    interactionProps = { ...interactionProps, pendingTranscriptReviews: [{ id: 'review-2', text: 'What is JavaScript?' }] };
    await renderInteraction();
    const reviewTextarea = rootElement.querySelector('[aria-label="Review recognized transcript before sending"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(reviewTextarea, 'Explain JavaScript.');
      reviewTextarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      reviewTextarea.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await renderInteraction();
    await clickButton('Send to AI');
    assert.equal(interactionEvents.at(-1), 'review-send-review-2-Explain JavaScript.', 'The edited transcript should be sent only after explicit confirmation.');
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
    const retentionModeSelect = rootElement.querySelector('select[aria-label="Meeting history retention"]');
    await act(async () => {
      retentionModeSelect.value = 'custom';
      retentionModeSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await renderInteraction();
    const dateInput = rootElement.querySelector('input[aria-label="Delete all saved history on date"]');
    assert.ok(dateInput, 'Selecting custom deletion should reveal its date picker.');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 2);
    const dateValue = [
      tomorrow.getFullYear().toString().padStart(4, '0'),
      (tomorrow.getMonth() + 1).toString().padStart(2, '0'),
      tomorrow.getDate().toString().padStart(2, '0'),
    ].join('-');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(dateInput, dateValue);
      dateInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      dateInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await renderInteraction();
    assert.equal(interactionEvents.at(-1), `retention-date:${dateValue}`, 'A future custom date should schedule deletion of all Meeting history.');
    assert.equal(interactionProps.historyRetentionDays, `date:${dateValue}`);
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
