// True while an IME (拼音 etc.) is composing: Enter picks a candidate and
// arrows move around the candidate panel, so app hotkeys must not fire.
// keyCode 229 catches Safari, which reports isComposing=false on the Enter
// that confirms a candidate.
export const isImeEvent = (e: { nativeEvent: KeyboardEvent; keyCode: number }) =>
  e.nativeEvent.isComposing || e.keyCode === 229
