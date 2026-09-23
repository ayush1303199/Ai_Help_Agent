interface ScreenReadingButtonProps {
  chatStreaming: boolean;
  onReadScreen: () => void;
  screenReading: boolean;
  enabled: boolean;
}

export function ScreenReadingButton({
  chatStreaming,
  onReadScreen,
  screenReading,
  enabled,
}: ScreenReadingButtonProps) {
  return (
    <button
      type="button"
      onClick={onReadScreen}
      disabled={!enabled || screenReading || chatStreaming}
      className="ui-button mt-3 w-full border border-cyan-500/40 text-xs text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-40"
    >
      {screenReading ? 'Reading shared screen...' : enabled ? 'Read screen and answer (Ctrl + Shift + R)' : 'Screen reading is OFF — enable it in the header'}
    </button>
  );
}
