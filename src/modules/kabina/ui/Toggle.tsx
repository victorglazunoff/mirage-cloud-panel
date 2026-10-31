type ToggleProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Spoken name of the setting. */
  ariaLabel: string;
  disabled?: boolean;
  /** The ВКЛ/ВЫКЛ caption left of the track; rows with their own label (widgets, plugins) hide it. */
  showState?: boolean;
};

/** Used by settings rows of the Kabina layer: the ВКЛ/ВЫКЛ switch whose knob glows orange when on (DarkSettings). */
export function Toggle({ checked, onChange, ariaLabel, disabled = false, showState = true }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      className="kb-sw"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      {showState && <span className="kb-m kb-sw-state" aria-hidden="true">{checked ? 'ВКЛ' : 'ВЫКЛ'}</span>}
      <span className="kb-sw-track" aria-hidden="true">
        <span className="kb-sw-knob" />
      </span>
    </button>
  );
}
