import type { VoiceView } from '@/modules/kabina-voice/hooks/useVoiceFlow';

/**
 * How a step tab looks: `current` — the screen on show (orange); `passed` — behind it and
 * reachable (soft, with a dim orange line); `ahead` — not reached yet (plain, like the
 * mock's idle tabs). A step can be `ahead` and still clickable (re-recording after a parse).
 */
export type VoiceStepState = 'current' | 'passed' | 'ahead';

/** One step tab of the voice overlay (desktop footer or the phone segmented bar). */
export type VoiceStepTab<Id extends string> = {
  id: Id;
  n: string;
  label: string;
  state: VoiceStepState;
  /** True when a click on the tab cannot go there (yet). */
  disabled: boolean;
};

/**
 * Steps are linear. `reached` — the cycle has got that far (there is a parse for «Понял»);
 * `open` — a click may go there now. A step is clickable only when it is open and every
 * step before it was reached, so «03» never lights up while «02» is still locked — no
 * jumping over a step. Steps before the current one that were reached read as passed.
 */
function linearSteps<Id extends string>(
  steps: Array<{ id: Id; n: string; label: string; reached: boolean; open: boolean }>,
  currentId: Id,
): Array<VoiceStepTab<Id>> {
  const currentIndex = steps.findIndex((step) => step.id === currentId);
  let chainReached = true;
  return steps.map((step, index) => {
    const isCurrent = index === currentIndex;
    const clickable = isCurrent || (step.open && chainReached);
    chainReached = chainReached && step.reached;
    let state: VoiceStepState = 'ahead';
    if (isCurrent) state = 'current';
    else if (index < currentIndex && step.reached) state = 'passed';
    return { id: step.id, n: step.n, label: step.label, state, disabled: !clickable };
  });
}

/**
 * Used by VoiceDesktop for the footer tabs 01 «Слушаю» → 02 «Понял» → 03 «Куда отправить».
 * «Понял» opens once the phrase is parsed; «Куда отправить» only after «Понял» and not while
 * the actions run or after they ran (the header «КОМУ» button still opens it at any time).
 */
export function desktopVoiceSteps(input: {
  view: VoiceView;
  hasIntent: boolean;
  done: boolean;
  executing: boolean;
}): Array<VoiceStepTab<VoiceView>> {
  const { view, hasIntent, done, executing } = input;
  return linearSteps<VoiceView>([
    { id: 'listen', n: '01', label: 'Слушаю', reached: true, open: !executing },
    { id: 'parsed', n: '02', label: 'Понял', reached: hasIntent, open: hasIntent },
    { id: 'dest', n: '03', label: 'Куда отправить', reached: hasIntent, open: hasIntent && !done && !executing },
  ], view);
}

/** Step of the phone layout: «Куда отправить» lives inside «Понял» there. */
export type PhoneVoiceStep = 'listen' | 'got' | 'done';

/**
 * Used by VoicePhone for its 01 «Слушаю» / 02 «Понял» / 03 «Готово» bar. «Готово» is
 * never a click target: it is where «Выполнить» leads.
 */
export function phoneVoiceSteps(input: {
  step: PhoneVoiceStep;
  hasIntent: boolean;
  executing: boolean;
}): Array<VoiceStepTab<PhoneVoiceStep>> {
  const { step, hasIntent, executing } = input;
  const tabs = linearSteps<PhoneVoiceStep>([
    { id: 'listen', n: '01', label: 'Слушаю', reached: true, open: !executing },
    // After «Готово» «Понял» is history: passed, but only «Слушаю» starts over.
    { id: 'got', n: '02', label: 'Понял', reached: hasIntent, open: hasIntent && step !== 'done' },
    { id: 'done', n: '03', label: 'Готово', reached: false, open: false },
  ], step);
  // A tap on the step on show would restart it (01 starts a new recording): not a target.
  return tabs.map((tab) => (tab.state === 'current' ? { ...tab, disabled: true } : tab));
}
